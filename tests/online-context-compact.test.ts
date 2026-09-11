/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	estimateTokens,
	type CompactOptions,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	BOUNDARY_COMPACTION_INSTRUCTIONS,
	createOnlineContextCompactExtension,
	DEFAULT_KEEP_RECENT_TOKENS,
	DEFAULT_NATIVE_SUMMARY_TOKEN_ESTIMATE,
	estimateNativeCompactionTokens,
	POST_COMPACTION_PLAN_REMINDER,
	registerOnlineContextCompact,
	resolveKeepRecentTokens,
} from "../src/sol-pi/extensions/online-context-compact/index.ts";
import { restoreOnlineState } from "../src/sol-pi/extensions/online-context-compact/state.ts";
import { FakePi, FakeSessionManager, fakeContext } from "./helpers.ts";

const OPEN = [{ id: "build", goal: "build it", status: "in_progress" }] as const;
const DONE = [{ id: "build", goal: "build it", status: "completed" }] as const;
const PROGRESS = {
	files_changed: ["src/a.ts"],
	verification: ["tests passed"],
	decisions: ["kept the implementation small"],
};

function assistant(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test",
		provider: "test",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

async function runPlan(pi: FakePi, context: ExtensionContext, id: string, params: unknown) {
	const execute = pi.tool("update_plan").execute as (
		toolCallId: string,
		params: unknown,
		signal: undefined,
		onUpdate: undefined,
		context: ExtensionContext,
	) => Promise<{ content: unknown[]; details: Readonly<Record<string, unknown>> }>;
	return await execute(id, params, undefined, undefined, context);
}

describe("Online Context Compact extension", () => {
	it("registers one tool and only public Pi lifecycle hooks", () => {
		const pi = new FakePi();
		registerOnlineContextCompact(pi.asExtensionApi());
		expect(pi.registeredTools.map((tool) => tool.name)).toEqual(["update_plan"]);
		expect([...pi.handlers.keys()].sort()).toEqual([
			"agent_settled",
			"before_provider_request",
			"context",
			"input",
			"session_before_tree",
			"session_compact",
			"session_shutdown",
			"session_start",
			"session_tree",
			"turn_end",
		]);
	});

	it("uses Pi's retained-tail default and validates overrides", () => {
		expect(resolveKeepRecentTokens(undefined)).toBe(DEFAULT_KEEP_RECENT_TOKENS);
		expect(() => resolveKeepRecentTokens(0)).toThrow(/positive safe integer/u);
		expect(resolveKeepRecentTokens(50)).toBe(50);
	});

	it("observes context without changing it", async () => {
		const pi = new FakePi();
		registerOnlineContextCompact(pi.asExtensionApi());
		const context = fakeContext(pi.sessionManager);
		await pi.emit("session_start", { type: "session_start" }, context);
		const messages = [assistant("unchanged")];
		expect(await pi.emitContext(messages, context)).toEqual(messages);
	});

	it("matches Pi's removable messages across initial and repeated compactions", () => {
		const manager = new FakeSessionManager();
		manager.appendMessage({ role: "user", content: "x".repeat(100), timestamp: Date.now() });
		manager.appendMessage(assistant("y".repeat(100_000)));
		const initialEntries = manager.getBranch();
		const initialMessage = initialEntries[0];
		if (initialMessage?.type !== "message") throw new Error("expected message entry");
		const initialExpected = estimateTokens(initialMessage.message);
		expect(estimateNativeCompactionTokens(initialEntries, 20_000)).toBe(initialExpected);
		expect(initialExpected).toBeLessThan(DEFAULT_NATIVE_SUMMARY_TOKEN_ESTIMATE);

		const firstKeptEntryId = manager.entries.at(-1)?.id ?? "message-2";
		manager.entries.push({
			type: "compaction",
			id: "compact-1",
			parentId: firstKeptEntryId,
			timestamp: new Date().toISOString(),
			summary: "s".repeat(8_000),
			firstKeptEntryId,
			tokensBefore: 25_025,
		});
		manager.leafId = "compact-1";
		manager.appendMessage({ role: "user", content: "new work", timestamp: Date.now() });
		manager.appendMessage(assistant("z".repeat(8_000)));
		const repeatedEntries = manager.getBranch();
		const previousSummary = repeatedEntries.findLast((entry) => entry.type === "compaction");
		if (!previousSummary) throw new Error("expected compaction entry");
		const previousSummaryMessage: AgentMessage = {
			role: "compactionSummary",
			summary: previousSummary.summary,
			tokensBefore: previousSummary.tokensBefore,
			timestamp: new Date(previousSummary.timestamp).getTime(),
		};
		const firstKept = repeatedEntries.find((entry) => entry.id === previousSummary.firstKeptEntryId);
		const newUser = repeatedEntries.at(-2);
		if (firstKept?.type !== "message" || newUser?.type !== "message") {
			throw new Error("expected removable message entries");
		}
		const repeatedExpected =
			estimateTokens(previousSummaryMessage) + estimateTokens(firstKept.message) + estimateTokens(newUser.message);
		expect(estimateNativeCompactionTokens(repeatedEntries, 1)).toBe(repeatedExpected);

		const noNewPrefix = repeatedEntries.slice(0, repeatedEntries.indexOf(previousSummary) + 2);
		expect(estimateNativeCompactionTokens(noNewPrefix, 20_000)).toBe(0);
	});

	it("defers when Pi's cut point leaves too little history to offset the summary", async () => {
		const manager = new FakeSessionManager();
		manager.appendMessage({ role: "user", content: "x".repeat(100), timestamp: Date.now() });
		manager.appendMessage(assistant("y".repeat(100_000)));
		const pi = new FakePi(manager);
		createOnlineContextCompactExtension({ cacheWriteReadRatio: 12.5 })(pi.asExtensionApi());
		const abort = vi.fn();
		const compact = vi.fn();
		const context = fakeContext(manager, {
			abort,
			compact,
			getContextUsage: () => ({ tokens: 25_025, contextWindow: 30_000, percent: 83.4 }),
		});

		await pi.emit("session_start", { type: "session_start" }, context);
		await pi.emitContext(
			[
				{ role: "user", content: "x".repeat(100), timestamp: Date.now() },
				assistant("y".repeat(100_000)),
			],
			context,
		);
		await pi.emit("before_provider_request", { type: "before_provider_request", payload: {} }, context);
		await runPlan(pi, context, "plan-open", { steps: OPEN });
		await runPlan(pi, context, "plan-done", { steps: DONE, progress: PROGRESS });
		await pi.emit(
			"turn_end",
			{
				type: "turn_end",
				turnIndex: 1,
				message: assistant("boundary"),
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "plan-done",
						toolName: "update_plan",
						content: [{ type: "text", text: "done" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			},
			context,
		);

		expect(abort).not.toHaveBeenCalled();
		await pi.emit("agent_settled", { type: "agent_settled" }, context);
		expect(compact).not.toHaveBeenCalled();
	});

	it("stops at an eligible completed-step boundary, then compacts after settlement", async () => {
		const manager = new FakeSessionManager();
		manager.appendMessage({ role: "user", content: `old ${"x".repeat(8_000)}`, timestamp: Date.now() });
		manager.appendMessage(assistant(`work ${"y".repeat(2_000)}`));
		const pi = new FakePi(manager);
		createOnlineContextCompactExtension({ cacheWriteReadRatio: 12.5, keepRecentTokens: 1 })(pi.asExtensionApi());
		let idle = true;
		const sendMessage = pi.sendMessage.bind(pi);
		vi.spyOn(pi, "sendMessage").mockImplementation((message, options) => {
			idle = false;
			sendMessage(message, options);
		});
		const abort = vi.fn();
		const compactCalls: CompactOptions[] = [];
		let finishCompaction!: () => void;
		const compactionGate = new Promise<void>((resolve) => {
			finishCompaction = resolve;
		});
		let context: ExtensionContext;
		const compact = (options: CompactOptions = {}): void => {
			compactCalls.push(options);
			void compactionGate.then(() => pi
				.emit(
					"session_compact",
					{
						type: "session_compact",
						fromExtension: false,
						reason: "manual",
						willRetry: false,
						compactionEntry: {
							type: "compaction",
							id: "compact-1",
							parentId: manager.getLeafId(),
							timestamp: new Date().toISOString(),
							summary: "summary",
							firstKeptEntryId: manager.entries.at(-1)?.id ?? "message-1",
							tokensBefore: 195_000,
						},
					},
					context,
				))
				.then(() => options.onComplete?.({
					summary: "summary",
					firstKeptEntryId: manager.entries.at(-1)?.id ?? "message-1",
					tokensBefore: 195_000,
				}));
		};
		context = fakeContext(manager, {
			abort,
			compact,
			isIdle: () => idle,
			getSystemPrompt: () => "test prompt",
			getContextUsage: () => ({ tokens: 195_000, contextWindow: 200_000, percent: 97.5 }),
		});

		await pi.emit("session_start", { type: "session_start" }, context);
		await pi.emitContext(buildSessionMessages(), context);
		await pi.emit("before_provider_request", { type: "before_provider_request", payload: {} }, context);
		await runPlan(pi, context, "plan-open", { steps: OPEN });
		const planResult = await runPlan(pi, context, "plan-done", { steps: DONE, progress: PROGRESS });

		await pi.emit(
			"turn_end",
			{
				type: "turn_end",
				turnIndex: 1,
				message: assistant("boundary"),
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "plan-done",
						toolName: "update_plan",
						content: [{ type: "text", text: "done" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			},
			context,
		);

		expect(planResult.details).toMatchObject({ boundary: true, progress_recorded: true });
		expect(abort).toHaveBeenCalledOnce();
		expect(compactCalls).toEqual([]);

		idle = false;
		await pi.emit("agent_settled", { type: "agent_settled" }, context);
		expect(compactCalls).toEqual([]);

		idle = true;
		let firstSettlementFinished = false;
		const firstSettlement = pi.emit("agent_settled", { type: "agent_settled" }, context).then(() => {
			firstSettlementFinished = true;
		});
		await vi.waitFor(() => expect(compactCalls).toHaveLength(1));
		expect(await pi.emit("session_before_tree", { type: "session_before_tree" }, context)).toEqual({ cancel: true });
		finishCompaction();
		await vi.waitFor(() => expect(pi.sentMessages).toHaveLength(1));

		expect(compactCalls).toHaveLength(1);
		expect(compactCalls[0]?.customInstructions).toBe(BOUNDARY_COMPACTION_INSTRUCTIONS);
		expect(firstSettlementFinished).toBe(false);
		expect(pi.sentMessages).toEqual([
			{
				message: {
					customType: "sol-pi-online-context-compact",
					content: POST_COMPACTION_PLAN_REMINDER,
					display: false,
				},
				options: { triggerTurn: true },
			},
		]);

		idle = true;
		await pi.emit("agent_settled", { type: "agent_settled" }, context);
		await firstSettlement;
		expect(firstSettlementFinished).toBe(true);
		expect(await pi.emit("session_before_tree", { type: "session_before_tree" }, context)).toBeUndefined();
		expect(restoreOnlineState(manager.entries)).toMatchObject({ nativeCompactionCount: 1, pendingProgress: [] });
	});
});

function buildSessionMessages(): AgentMessage[] {
	return [
		{ role: "user", content: `old ${"x".repeat(8_000)}`, timestamp: Date.now() },
		assistant(`work ${"y".repeat(2_000)}`),
	];
}
