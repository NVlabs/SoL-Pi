/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CompactOptions, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	BOUNDARY_COMPACTION_INSTRUCTIONS,
	createOnlineContextCompactExtension,
	DEFAULT_KEEP_RECENT_TOKENS,
	POST_COMPACTION_PLAN_REMINDER,
	SKIPPED_COMPACTION_CONTINUATION,
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

	it("stops at an eligible completed-step boundary, then compacts after settlement", async () => {
		const manager = new FakeSessionManager();
		manager.appendMessage({ role: "user", content: `old ${"x".repeat(2_000)}`, timestamp: Date.now() });
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

	it("does not abort for a compaction Pi would reject as session too small (system-entry window)", async () => {
		// Regression for pi 0.87.x compaction preparation: the projected window
		// starts at a persisted system message, and everything before the first
		// cut point is system prompt state that Pi never summarizes. The old raw
		// entry count claimed feasibility, aborted the turn, and then
		// AgentSession.compact() failed with "Nothing to compact (session too small)".
		const manager = new FakeSessionManager();
		manager.appendMessage({ role: "system", content: "", timestamp: Date.now() } as unknown as AgentMessage);
		manager.appendMessage({ role: "user", content: `task ${"x".repeat(2_000)}`, timestamp: Date.now() });
		manager.appendMessage(assistant(`work ${"y".repeat(2_000)}`));
		const pi = new FakePi(manager);
		createOnlineContextCompactExtension({ cacheWriteReadRatio: 12.5 })(pi.asExtensionApi());

		const abort = vi.fn();
		const compact = vi.fn();
		const context = fakeContext(manager, {
			abort,
			compact,
			isIdle: () => true,
			getSystemPrompt: () => "test prompt",
			getContextUsage: () => ({ tokens: 195_000, contextWindow: 200_000, percent: 97.5 }),
		});

		await pi.emit("session_start", { type: "session_start" }, context);
		await pi.emitContext(
			[
				{ role: "user", content: `task ${"x".repeat(2_000)}`, timestamp: Date.now() },
			assistant(`work ${"y".repeat(2_000)}`),
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
		expect(pi.sentMessages).toEqual([]);
	});

	it("resumes the task once when compaction benignly skips, and stops after a repeated skip", async () => {
		const manager = new FakeSessionManager();
		manager.appendMessage({ role: "user", content: `old ${"x".repeat(2_000)}`, timestamp: Date.now() });
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
		const compact = (options: CompactOptions = {}): void => {
			setTimeout(
				() => options.onError?.(new Error("Nothing to compact (session too small)")),
				0,
			);
		};
		let context: ExtensionContext;
		context = fakeContext(manager, {
			abort,
			compact,
			isIdle: () => idle,
			getSystemPrompt: () => "test prompt",
			getContextUsage: () => ({ tokens: 195_000, contextWindow: 200_000, percent: 97.5 }),
		});

		const boundaryTurn = async (ordinal: number): Promise<void> => {
			await runPlan(pi, context, `plan-open-${ordinal}`, { steps: OPEN });
			await runPlan(pi, context, `plan-done-${ordinal}`, { steps: DONE, progress: PROGRESS });
			await pi.emit(
				"turn_end",
				{
					type: "turn_end",
					turnIndex: ordinal,
					message: assistant("boundary"),
					toolResults: [
						{
						role: "toolResult",
						toolCallId: `plan-done-${ordinal}`,
						toolName: "update_plan",
						content: [{ type: "text", text: "done" }],
						isError: false,
						timestamp: Date.now(),
						},
					],
				},
				context,
			);
		};

		await pi.emit("session_start", { type: "session_start" }, context);
		await pi.emitContext(buildSessionMessages(), context);
		await pi.emit("before_provider_request", { type: "before_provider_request", payload: {} }, context);
		await boundaryTurn(1);
		expect(abort).toHaveBeenCalledOnce();

		idle = true;
		const firstSettlement = pi.emit("agent_settled", { type: "agent_settled" }, context);
		await vi.waitFor(() => expect(pi.sentMessages).toHaveLength(1));
		expect(pi.sentMessages[0]?.message.content).toBe(SKIPPED_COMPACTION_CONTINUATION);
		idle = true;
		await pi.emit("agent_settled", { type: "agent_settled" }, context);
		await firstSettlement;

		// The skipped-compaction continuation kept the task alive; a repeated
		// benign skip on the very next boundary must not resume again.
		idle = true;
		await boundaryTurn(2);
		expect(abort).toHaveBeenCalledTimes(2);
		await pi.emit("agent_settled", { type: "agent_settled" }, context);
		expect(pi.sentMessages).toHaveLength(1);
	});
});

function buildSessionMessages(): AgentMessage[] {
	return [
		{ role: "user", content: `old ${"x".repeat(2_000)}`, timestamp: Date.now() },
		assistant(`work ${"y".repeat(2_000)}`),
	];
}
