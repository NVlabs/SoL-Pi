/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import * as piApi from "@earendil-works/pi-coding-agent";
import { estimateTokens, sessionEntryToContextMessages, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createObservationPackExtension } from "../src/sol-pi/extensions/observation-pack/index.ts";
import { createOnlineContextCompactExtension, estimateNativeCompactionTokens } from "../src/sol-pi/extensions/online-context-compact/extension.ts";
import { decideCompaction, DEFAULT_COMPACTION_ECONOMICS } from "../src/sol-pi/extensions/online-context-compact/economics.ts";
import { projectedEntryTokens } from "../src/sol-pi/extensions/online-context-compact/projection.ts";
import { FakePi, FakeSessionManager, fakeToolContext } from "./helpers.ts";

const buildProjection = (piApi as unknown as {
	buildSessionProjection?: (entries: SessionEntry[]) => { messages: AgentMessage[] };
}).buildSessionProjection;

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function history(): AgentMessage[] {
	return [
		{ role: "user", content: "Inspect the diagnostic output.", timestamp: 1 },
		fauxAssistantMessage(fauxToolCall("bash", { command: "make test" }, { id: "large" })),
		{ role: "toolResult", toolCallId: "large", toolName: "bash", content: [{ type: "text", text: "diagnostic line\n".repeat(13_000) }], isError: false, timestamp: 2 },
		{ role: "user", content: "Continue with the next step.", timestamp: 3 },
		fauxAssistantMessage("r".repeat(80_000)),
	];
}

describe("ObservationPack and OCC savings", () => {
	it("does not compact a projected prefix that is smaller than the replacement summary", async () => {
		const root = await mkdtemp(join(tmpdir(), "sol-pi-occ-projection-"));
		roots.push(root);
		const manager = new FakeSessionManager([], "projection", root);
		const messages = history();
		for (const message of messages) manager.appendMessage(message);
		const pi = new FakePi(manager);
		createObservationPackExtension()(pi.asExtensionApi());
		createOnlineContextCompactExtension({ cacheWriteReadRatio: 12.5 })(pi.asExtensionApi());
		const abort = vi.fn();
		const ctx = fakeToolContext(manager, { abort, getSystemPrompt: () => "s".repeat(4_000) });
		await pi.emit("session_start", {}, ctx);
		let projected: AgentMessage[] = [];
		for (let index = 0; index < 3; index++) {
			projected = await pi.emitContext(messages, ctx);
			await pi.emit("before_provider_request", {}, ctx);
		}
		expect(projected[2]).toMatchObject({ content: [{ type: "text", text: expect.stringContaining("large tool result replaced") }] });
		const raw = estimateNativeCompactionTokens(manager.getBranch(), 20_000);
		const visible = estimateNativeCompactionTokens(manager.getBranch(), 20_000, projected);
		const writeTokens = projected.reduce((total, message) => total + estimateTokens(message), 1_000);
		expect(raw).toBeGreaterThan(writeTokens);
		expect(visible).toBeGreaterThan(0);
		expect(visible).toBeLessThan(1_000);
		const input = { writeTokens, memoTokens: 1_000, contextTokens: writeTokens,
			completedBoundaryRequestCounts: [5], remainingBoundaries: 2, averageContextTokenIncrement: null,
			contextWindowTokens: 200_000, priorCompactionCount: 0, carriedDebtTokens: 0,
			cacheDebtRepaymentTokens: 0, cacheWriteReadRatio: 12.5, economics: DEFAULT_COMPACTION_ECONOMICS };
		expect(decideCompaction({ ...input, archiveTokens: raw })).toMatchObject({ compact: true, postCompactionTokens: 0 });
		expect(decideCompaction({ ...input, archiveTokens: visible })).toMatchObject({ compact: false, reason: "non_positive_saving" });
		const next = { id: "next", goal: "continue", status: "pending" };
		await pi.tool("update_plan").execute("open", { steps: [{ id: "work", goal: "work", status: "in_progress" }, next] }, undefined, undefined, ctx);
		await pi.tool("update_plan").execute("done", { steps: [{ id: "work", goal: "work", status: "completed" }, next] }, undefined, undefined, ctx);
		await pi.emit("turn_end", { message: fauxAssistantMessage("boundary"), toolResults: [{ toolCallId: "done", toolName: "update_plan", isError: false }] }, ctx);
		expect(abort).not.toHaveBeenCalled();
	});

	it("counts uncompressed observations but never falls back to raw bytes for missing projections", () => {
		const manager = new FakeSessionManager();
		const messages = history();
		for (const message of messages) manager.appendMessage(message);
		expect(estimateNativeCompactionTokens(manager.getBranch(), 20_000, messages)).toBe(estimateNativeCompactionTokens(manager.getBranch(), 20_000));
		const dropped = messages.filter((message) => message.role !== "toolResult");
		expect(estimateNativeCompactionTokens(manager.getBranch(), 20_000, dropped)).toBeLessThan(1_000);
		expect(estimateNativeCompactionTokens(manager.getBranch(), 20_000, [])).toBe(0);
	});

	it("matches by source identity after reordered or injected messages, including repeated compactions", () => {
		const manager = new FakeSessionManager();
		const messages = history();
		for (const message of messages) manager.appendMessage(message);
		const keptId = manager.entries[2]!.id;
		manager.entries.push({ type: "compaction", id: "compact-1", parentId: manager.getLeafId(), timestamp: new Date(10).toISOString(), summary: "old memo", firstKeptEntryId: keptId, tokensBefore: 80_000 });
		manager.leafId = "compact-1";
		const tool = { ...messages[2]!, content: [{ type: "text" as const, text: "short placeholder" }] } as AgentMessage;
		const projected = [fauxAssistantMessage("extension-injected content"), messages[4]!, tool, messages[3]!];
		const sizes = projectedEntryTokens(manager.getBranch(), projected);
		expect(sizes.get(keptId)).toBe(estimateTokens(tool));
		expect(sizes.has(manager.entries[0]!.id)).toBe(false);
		expect(sizes.has("compact-1")).toBe(false);
		const ambiguous = projectedEntryTokens(manager.getBranch(), [...projected, tool]);
		expect(ambiguous.has(keptId)).toBe(false);
	});

	it.skipIf(!buildProjection)("uses edited message sizes when deciding whether Pi has any removable prefix", () => {
		const manager = new FakeSessionManager();
		manager.appendMessage({ role: "user", content: "old question " + "x".repeat(6_000), timestamp: 1 });
		manager.appendMessage(fauxAssistantMessage("old response " + "y".repeat(6_000)));
		manager.appendMessage({ role: "user", content: "continue", timestamp: 2 });
		manager.appendMessage(fauxAssistantMessage("z".repeat(80_000)));
		const targetId = manager.getLeafId();
		manager.entries.push({ type: "context_edit", id: "edit-small", parentId: targetId,
			timestamp: new Date(3).toISOString(), targetId, replacement: { content: "small edited response" } } as unknown as SessionEntry);
		manager.leafId = "edit-small";
		const entries = manager.getBranch();
		const projected = buildProjection!(entries).messages;
		expect(projected.reduce((sum, message) => sum + estimateTokens(message), 0)).toBeLessThan(20_000);
		expect(estimateNativeCompactionTokens(entries, 20_000)).toBe(0);
		expect(estimateNativeCompactionTokens(entries, 20_000, projected)).toBe(0);
	});

	it.skipIf(!buildProjection)("maps edited custom messages to their source before pricing extension projections", () => {
		const manager = new FakeSessionManager();
		manager.entries.push({ type: "custom_message", id: "custom", parentId: null,
			timestamp: new Date(1).toISOString(), customType: "note", content: "x".repeat(40_000), display: false });
		manager.leafId = "custom";
		manager.entries.push({ type: "context_edit", id: "edit-custom", parentId: "custom",
			timestamp: new Date(2).toISOString(), targetId: "custom", replacement: { content: "preserved compact note" } } as unknown as SessionEntry);
		manager.leafId = "edit-custom";
		manager.appendMessage({ role: "user", content: "new question", timestamp: 3 });
		manager.appendMessage(fauxAssistantMessage("y".repeat(80_000)));
		const entries = manager.getBranch();
		const projected = buildProjection!(entries).messages;
		expect(projectedEntryTokens(entries, projected).get("custom")).toBe(estimateTokens(projected[0]!));
		expect(estimateNativeCompactionTokens(entries, 20_000, projected)).toBe(
			estimateTokens(projected[0]!) + estimateTokens(projected[1]!),
		);
	});

	it("never counts a preserved system checkpoint as removable summary tokens", () => {
		const manager = new FakeSessionManager();
		manager.appendMessage({ role: "user", content: "earlier question", timestamp: 1 });
		manager.appendMessage(fauxAssistantMessage("kept answer"));
		const keptId = manager.getLeafId()!;
		manager.entries.push({ type: "compaction", id: "checkpoint", parentId: keptId,
			timestamp: new Date(2).toISOString(), summary: "memo", firstKeptEntryId: keptId, tokensBefore: 100,
			systemMessage: { role: "system", content: "s".repeat(80_000), timestamp: 0 },
		} as SessionEntry);
		manager.leafId = "checkpoint";
		manager.appendMessage({ role: "user", content: "new question", timestamp: 3 });
		manager.appendMessage(fauxAssistantMessage("x".repeat(80_000)));
		const entries = manager.getBranch();
		const checkpoint = entries.find((entry) => entry.id === "checkpoint")!;
		const projected = buildProjection ? buildProjection(entries).messages : [
			...sessionEntryToContextMessages(checkpoint), ...entries.slice(1, 2).flatMap(sessionEntryToContextMessages),
			...entries.slice(3).flatMap(sessionEntryToContextMessages),
		];
		const expected = estimateTokens(projected.find((message) => message.role === "compactionSummary")!) +
			estimateTokens(entries[1]!.type === "message" ? entries[1]!.message : projected[0]!) +
			estimateTokens(entries[3]!.type === "message" ? entries[3]!.message : projected[0]!);
		expect(projectedEntryTokens(entries, projected).get("checkpoint")).toBe(1);
		expect(estimateNativeCompactionTokens(entries, 20_000)).toBe(expected);
		expect(estimateNativeCompactionTokens(entries, 20_000, projected)).toBe(expected);
	});
});
