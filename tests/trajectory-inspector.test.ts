/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { TrajectoryWidget } from "../src/sol-pi/extensions/trajectory-inspector/trajectory.ts";
import { DEFAULT_CONFIG } from "../src/sol-pi/config.ts";
import { registerConfiguredFeatures } from "../src/sol-pi/index.ts";
import { createTrajectoryInspectorExtension, TRAJECTORY_EVENT_SCHEMA, TRAJECTORY_WIDGET_KEY, TrajectoryStore } from "../src/sol-pi/extensions/trajectory-inspector/index.ts";
import { FakePi, FakeSessionManager, componentText, fakeContext, plainTheme } from "./helpers.ts";

function assistantMessage(text: string): Record<string, unknown> {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test",
		provider: "test",
		model: "test-model",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: 1,
	};
}

describe("TrajectoryStore", () => {
	it("keeps a bounded tail and updates active records", () => {
		const store = new TrajectoryStore(2);
		store.record({ kind: "turn", label: "turn 1", status: "running" }, 1_000);
		const active = store.record({ kind: "tool", label: "tool bash", status: "running" }, 2_000);
		store.record({ kind: "result", label: "result bash", status: "ok" }, 3_000);

		expect(store.totalRecords).toBe(3);
		expect(store.snapshot().map((record) => record.sequence)).toEqual([2, 3]);
		expect(store.update(active.sequence, { status: "ok", durationMs: 12 })).toMatchObject({ status: "ok", durationMs: 12 });
		expect(store.snapshot()[0]).toMatchObject({ kind: "tool", status: "ok", durationMs: 12 });
	});

	it("rejects an invalid record bound", () => {
		expect(() => new TrajectoryStore(0)).toThrow("maxRecords");
	});

	it("fits narrow terminals and removes control characters from metadata", () => {
		const store = new TrajectoryStore();
		store.record({ kind: "tool", label: "\u001b[2J\n" + "界🙂".repeat(80), turnIndex: 12345 });
		const widget = new TrajectoryWidget(store, plainTheme);
		expect(store.snapshot()[0]?.label).not.toMatch(/[\x00-\x1f]/u);
		for (const width of [1, 10, 20, 40, 80]) {
			for (const line of widget.render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				expect(line).not.toContain("\u001b[2J");
			}
		}
	});

	it("does not reuse sequence IDs when clearing the live tail", () => {
		const store = new TrajectoryStore();
		const first = store.record({ kind: "session", label: "first" });
		store.clear();
		expect(store.record({ kind: "session", label: "resumed" }).sequence).toBeGreaterThan(first.sequence);
	});
});

describe("trajectory inspector extension", () => {
	it("records live activity, renders a widget, and persists metadata only", async () => {
		const root = await mkdtemp(join(tmpdir(), "sol-pi-trajectory-test-"));
		try {
			const manager = new FakeSessionManager([], "trajectory-session", root);
			const pi = new FakePi(manager);
			const setWidget = vi.fn();
			const notify = vi.fn();
			const context = fakeContext(manager, {
				mode: "tui",
				hasUI: true,
				model: { provider: "test-provider", id: "test-model" } as never,
				ui: { setWidget, notify } as never,
			});
			createTrajectoryInspectorExtension({ maxRecords: 20 })(pi.asExtensionApi());

			await pi.emit("session_start", { type: "session_start", reason: "startup" }, context);
			await pi.emit("agent_start", { type: "agent_start" }, context);
			await pi.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 1_000 }, context);
			await pi.emit("context", { type: "context", messages: [{ role: "user", content: "secret prompt", timestamp: 1 }] }, context);
			await pi.emit("before_provider_request", { type: "before_provider_request", payload: { secret: "payload" } }, context);
			await pi.emit("tool_execution_start", { type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash", args: { command: "secret command" } }, context);
			await pi.emit("tool_execution_end", { type: "tool_execution_end", toolCallId: "tool-1", toolName: "bash", result: { secret: "result" }, isError: false }, context);
			await pi.emit("tool_result", { type: "tool_result", toolName: "bash", toolCallId: "tool-1", input: { command: "secret command" }, content: [{ type: "text", text: "ok" }], details: undefined, isError: false }, context);
			await pi.emit("after_provider_response", { type: "after_provider_response", status: 200, headers: {} }, context);
			await pi.emit("message_start", { type: "message_start", message: assistantMessage("secret assistant") }, context);
			await pi.emit("message_end", { type: "message_end", message: assistantMessage("secret assistant") }, context);
			await pi.emit("turn_end", { type: "turn_end", turnIndex: 1, message: assistantMessage("done"), toolResults: [] }, context);
			await pi.emit("agent_settled", { type: "agent_settled" }, context);

			expect(setWidget).toHaveBeenCalledWith(TRAJECTORY_WIDGET_KEY, expect.any(Function), { placement: "aboveEditor" });
			const factory = setWidget.mock.calls.find((call) => typeof call[1] === "function")?.[1] as
				| ((tui: { requestRender: () => void }, theme: typeof plainTheme) => { render(width: number): string[]; invalidate(): void })
				| undefined;
			expect(factory).toBeDefined();
			const widget = factory!({ requestRender: vi.fn() }, plainTheme);
			const rendered = componentText(widget, 120);
			expect(rendered).toContain("Trajectory");
			expect(rendered).toContain("tool bash");
			expect(rendered).toContain("agent settled");

			const command = pi.registeredCommands[0]?.options as { handler: (args: string, ctx: typeof context) => Promise<void> };
			await command.handler("", context);
			expect(setWidget).toHaveBeenLastCalledWith(TRAJECTORY_WIDGET_KEY, undefined);
			await command.handler("", context);
			expect(setWidget).toHaveBeenLastCalledWith(TRAJECTORY_WIDGET_KEY, expect.any(Function), { placement: "aboveEditor" });

			await pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, context);
			const ledger = await readFile(join(root, "sol-pi", "trajectory-session", "trajectory-inspector", "events.jsonl"), "utf8");
			const entries = ledger.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
			expect(entries.length).toBeGreaterThan(8);
			expect(entries.every((entry) => entry.schema === TRAJECTORY_EVENT_SCHEMA)).toBe(true);
			expect(ledger).not.toContain("secret prompt");
			expect(ledger).not.toContain("secret command");
			expect(ledger).not.toContain("secret assistant");
			expect(ledger).toContain('"kind":"tool"');
			expect(entries.find(entry => entry.kind === "result")?.label).toBe("result bash · 2 B");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("is opt-in through the top-level configuration", () => {
		const pi = new FakePi();
		registerConfiguredFeatures(pi.asExtensionApi(), { ...DEFAULT_CONFIG, trajectoryInspector: true });
		expect(pi.registeredCommands.map((command) => command.name)).toEqual(["trajectory"]);
		expect([...pi.handlers.keys()]).toContain("tool_execution_start");
	});

	it("closes failed requests when no provider-response callback arrives", async () => {
		const root = await mkdtemp(join(tmpdir(), "sol-pi-trajectory-error-"));
		try {
			const manager = new FakeSessionManager([], "error-session", root);
			const pi = new FakePi(manager);
			const context = fakeContext(manager);
			createTrajectoryInspectorExtension()(pi.asExtensionApi());
			await pi.emit("session_start", { reason: "startup" }, context);
			await pi.emit("turn_start", { turnIndex: 0, timestamp: Date.now() }, context);
			await pi.emit("before_provider_request", {}, context);
			await pi.emit("turn_end", { message: { ...assistantMessage(""), stopReason: "error" }, toolResults: [] }, context);
			await pi.emit("session_shutdown", { reason: "quit" }, context);
			const ledger = await readFile(join(root, "sol-pi/error-session/trajectory-inspector/events.jsonl"), "utf8");
			const entries = ledger.trim().split("\n").map(line => JSON.parse(line));
			const request = entries.find(e => e.kind === "request");
			expect(entries.find(e => e.event === "update" && e.sequence === request.sequence)).toMatchObject({ status: "error", detail: "ended without response metadata" });
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	it("persists evicted span completions and separates resumed recorder IDs without UI calls", async () => {
		const root = await mkdtemp(join(tmpdir(), "sol-pi-trajectory-resume-"));
		try {
			const manager = new FakeSessionManager([], "resume-session", root);
			for (let attempt = 0; attempt < 2; attempt++) {
				const pi = new FakePi(manager);
				const context = fakeContext(manager);
				createTrajectoryInspectorExtension({ maxRecords: 1 })(pi.asExtensionApi());
				await pi.emit("session_start", { reason: "resume" }, context);
				await pi.emit("tool_execution_start", { toolName: "read", toolCallId: "tool-1" }, context);
				await pi.emit("session_info_changed", { name: "PRIVATE SESSION TITLE" }, context);
				await pi.emit("tool_execution_end", { toolCallId: "tool-1", isError: true }, context);
				const command = pi.registeredCommands[0]?.options as { handler: (args: string, ctx: typeof context) => Promise<void> };
				await command.handler("", context);
				await pi.emit("session_shutdown", { reason: "quit" }, context);
			}
			const ledger = await readFile(join(root, "sol-pi/resume-session/trajectory-inspector/events.jsonl"), "utf8");
			const entries = ledger.trim().split("\n").map(line => JSON.parse(line));
			expect(new Set(entries.map(e => e.runId)).size).toBe(2);
			expect(entries.filter(e => e.event === "update" && e.status === "error")).toHaveLength(2);
			expect(ledger).not.toContain("PRIVATE SESSION TITLE");
			expect(entries.every(e => typeof e.timestamp === "number")).toBe(true);
		} finally { await rm(root, { recursive: true, force: true }); }
	});
});
