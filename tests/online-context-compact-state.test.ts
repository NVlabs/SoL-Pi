/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { describe, expect, it } from "vitest";
import {
	appendOnlineState,
	initialOnlineState,
	ONLINE_STATE_ENTRY,
	recordBoundary,
	recordCompaction,
	recordCompletedPlanHandoff,
	recordCorrection,
	recordProviderRequest,
	restoreOnlineState,
} from "../src/sol-pi/extensions/online-context-compact/state.ts";
import { analyzePlanTransition } from "../src/sol-pi/extensions/online-context-compact/plan.ts";
import { FakePi, FakeSessionManager } from "./helpers.ts";

const PLAN = [
	{ id: "inspect", goal: "inspect the implementation", status: "completed" as const },
	{ id: "verify", goal: "verify the change", status: "in_progress" as const },
];

const PROGRESS = {
	stepId: "inspect",
	goal: "inspect the implementation",
	filesChanged: ["src/a.ts"],
	verification: ["targeted test passed"],
	decisions: ["keep the change small"],
	nextWork: ["verify the change"],
};

describe("Online Context Compact state snapshots", () => {
	it("starts with a disabled-by-default empty state", () => {
		expect(initialOnlineState()).toEqual({
			version: 1,
			epoch: 0,
			plan: [],
			pendingProgress: [],
			requestCount: 0,
			lastCompactionRequestCount: null,
			lastBoundaryRequestCount: 0,
			completedBoundaryRequestCounts: [],
			lastContextTokens: null,
			positiveContextDeltaTotal: 0,
			positiveContextDeltaCount: 0,
			nativeCompactionCount: 0,
			cacheDebtTokens: 0,
			cacheDebtRepaymentTokens: 0,
		});
	});

	it("restores the latest valid snapshot and ignores a malformed tail", () => {
		const manager = new FakeSessionManager();
		const pi = new FakePi(manager);
		const state = recordBoundary(recordProviderRequest(initialOnlineState(), 100), PLAN, PROGRESS);
		appendOnlineState(pi.asExtensionApi(), state);
		manager.appendCustomEntry(ONLINE_STATE_ENTRY, { version: 1, plan: "broken" });

		expect(restoreOnlineState(manager.entries)).toEqual(state);
	});

	it("resets an oversized legacy plan without rolling back the latest accounting", () => {
		const manager = new FakeSessionManager();
		const pi = new FakePi(manager);
		const legacy = {
			...recordProviderRequest(initialOnlineState(), 1_000),
			plan: [{ id: "legacy", goal: "g".repeat(1_001), status: "in_progress" as const }],
			cacheDebtTokens: 900,
			cacheDebtRepaymentTokens: 300,
		};
		appendOnlineState(pi.asExtensionApi(), legacy);

		expect(restoreOnlineState(manager.entries)).toEqual({ ...legacy, plan: [] });
	});

	it("counts requests, positive context growth, and cache-debt repayment", () => {
		const charged = {
			...initialOnlineState(),
			cacheDebtTokens: 300,
			cacheDebtRepaymentTokens: 100,
		};
		const first = recordProviderRequest(charged, 1_000);
		const second = recordProviderRequest(first, 1_250);
		const third = recordProviderRequest(second, 900);

		expect(third).toMatchObject({
			requestCount: 3,
			lastContextTokens: 900,
			positiveContextDeltaTotal: 250,
			positiveContextDeltaCount: 1,
			cacheDebtTokens: 0,
			cacheDebtRepaymentTokens: 0,
		});
	});

	it("records one request interval and one progress summary per boundary", () => {
		let state = initialOnlineState();
		state = recordProviderRequest(state, 100);
		state = recordProviderRequest(state, 200);
		state = recordBoundary(state, PLAN, PROGRESS);
		state = recordProviderRequest(state, 300);
		state = recordBoundary(state, PLAN, undefined);

		expect(state.completedBoundaryRequestCounts).toEqual([2, 1]);
		expect(state.lastBoundaryRequestCount).toBe(3);
		expect(state.pendingProgress).toEqual([PROGRESS]);
	});

	it("preserves request intervals and growth history across compaction", () => {
		let before = recordProviderRequest(initialOnlineState(), 5_000);
		before = recordBoundary(recordProviderRequest(before, 5_200), PLAN, PROGRESS);
		before = recordProviderRequest(before, 5_300);
		const after = recordCompaction(before, { debtTokens: 1_200, repaymentTokens: 300 });

		expect(after).toMatchObject({
			epoch: 1,
			plan: PLAN,
			lastCompactionRequestCount: before.requestCount,
			lastBoundaryRequestCount: 2,
			completedBoundaryRequestCounts: [2],
			positiveContextDeltaTotal: 300,
			positiveContextDeltaCount: 2,
			lastContextTokens: null,
			pendingProgress: [],
			nativeCompactionCount: 1,
			cacheDebtTokens: 1_200,
			cacheDebtRepaymentTokens: 300,
		});
		const next = recordBoundary(recordProviderRequest(after, 1_000), PLAN, undefined);
		expect(next.completedBoundaryRequestCounts).toEqual([2, 2]);
		expect(next.positiveContextDeltaTotal).toBe(300);
	});

	it("restores snapshots persisted before cooldown bookkeeping existed", () => {
		const legacy = initialOnlineState();
		const persisted = JSON.parse(JSON.stringify(legacy)) as Record<string, unknown>;
		delete persisted.lastCompactionRequestCount;

		const manager = new FakeSessionManager();
		manager.appendCustomEntry(ONLINE_STATE_ENTRY, persisted);

		expect(restoreOnlineState(manager.entries)).toEqual(legacy);
	});

	it("ignores the removed restatement flag in existing snapshots", () => {
		const state = recordBoundary(recordProviderRequest(initialOnlineState(), 5_000), PLAN, PROGRESS);
		const manager = new FakeSessionManager();
		manager.appendCustomEntry(ONLINE_STATE_ENTRY, { ...state, awaitingPlanRestatement: true });
		expect(restoreOnlineState(manager.entries)).toEqual(state);
	});

	it("does not treat a plan re-issued after compaction as new progress", () => {
		const before = recordBoundary(recordProviderRequest(initialOnlineState(), 5_000), PLAN, PROGRESS);
		const after = recordCompaction(before, { debtTokens: 0, repaymentTokens: 0 });

		expect(analyzePlanTransition(after.plan, PLAN).completedSteps).toEqual([]);
	});

	it("accumulates unpaid debt and savings across successive compactions", () => {
		const outstanding = {
			...initialOnlineState(),
			cacheDebtTokens: 900,
			cacheDebtRepaymentTokens: 300,
		};
		const after = recordCompaction(outstanding, { debtTokens: 800, repaymentTokens: 200 });

		expect(after).toMatchObject({
			cacheDebtTokens: 1_700,
			cacheDebtRepaymentTokens: 500,
		});
		expect(recordCompaction(outstanding, { debtTokens: 0, repaymentTokens: 0 })).toMatchObject({
			cacheDebtTokens: 900,
			cacheDebtRepaymentTokens: 300,
		});
	});

	it("resets a completed task's horizon at handoff while preserving its unpaid debt", () => {
		const before = {
			...recordBoundary(recordProviderRequest(initialOnlineState(), 5_000), PLAN, PROGRESS),
			plan: PLAN.map((step) => ({ ...step, status: "completed" as const })),
			cacheDebtTokens: 900,
			cacheDebtRepaymentTokens: 300,
		};
		expect(recordCompletedPlanHandoff(before)).toMatchObject({
			plan: [], completedBoundaryRequestCounts: [],
			lastBoundaryRequestCount: before.requestCount, lastContextTokens: null,
			cacheDebtTokens: 900, cacheDebtRepaymentTokens: 300,
		});
		const active = { ...before, plan: PLAN };
		expect(recordCompletedPlanHandoff(active)).toBe(active);
	});

	it("drops stale plan history and debt when the user corrects an active run", () => {
		const before = {
			...recordBoundary(recordProviderRequest(initialOnlineState(), 5_000), PLAN, PROGRESS),
			cacheDebtTokens: 900,
			cacheDebtRepaymentTokens: 300,
		};
		expect(recordCorrection(before)).toMatchObject({
			epoch: 1,
			plan: [],
			pendingProgress: [],
			completedBoundaryRequestCounts: [],
			lastContextTokens: null,
			cacheDebtTokens: 0,
			cacheDebtRepaymentTokens: 0,
		});
	});
});
