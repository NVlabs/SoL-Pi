/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createObservationPackExtension } from "../src/sol-pi/extensions/observation-pack/index.ts";
import { createOnlineContextCompactExtension, estimateNativeCompactionTokens } from "../src/sol-pi/extensions/online-context-compact/extension.ts";
import { decideCompaction, DEFAULT_COMPACTION_ECONOMICS } from "../src/sol-pi/extensions/online-context-compact/economics.ts";
import { projectedEntryTokens } from "../src/sol-pi/extensions/online-context-compact/projection.ts";
import { FakePi, FakeSessionManager, fakeContext } from "./helpers.ts";

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
		const ctx = fakeContext(manager, { abort, getSystemPrompt: () => "s".repeat(4_000) });
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
});
