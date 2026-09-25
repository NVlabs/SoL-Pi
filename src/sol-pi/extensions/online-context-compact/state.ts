/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { parsePlanSteps, type PlanStep } from "./plan.ts";

export const ONLINE_STATE_ENTRY = "sol-pi-online-context-state-v1";

export type ProgressSummary = {
	readonly stepId: string;
	readonly goal: string;
	readonly filesChanged: readonly string[];
	readonly verification: readonly string[];
	readonly decisions: readonly string[];
	readonly nextWork: readonly string[];
};

export type OnlineState = {
	readonly version: 1;
	readonly epoch: number;
	readonly plan: readonly PlanStep[];
	/** True after a compaction or correction: the next update_plan re-states the current plan and must not register progress. */
	readonly awaitingPlanRestatement: boolean;
	readonly pendingProgress: readonly ProgressSummary[];
	readonly requestCount: number;
	/** requestCount when the last compaction ran; null before the first compaction. */
	readonly lastCompactionRequestCount: number | null;
	readonly lastBoundaryRequestCount: number;
	readonly completedBoundaryRequestCounts: readonly number[];
	readonly lastContextTokens: number | null;
	readonly positiveContextDeltaTotal: number;
	readonly positiveContextDeltaCount: number;
	readonly nativeCompactionCount: number;
	readonly cacheDebtTokens: number;
	readonly cacheDebtRepaymentTokens: number;
};

export function initialOnlineState(): OnlineState {
	return {
		version: 1,
		epoch: 0,
		plan: [],
		awaitingPlanRestatement: false,
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
	};
}

function nonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function finiteNonNegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function stringArray(value: unknown): readonly string[] | undefined {
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return;
	return [...value];
}

function progressSummary(value: unknown): ProgressSummary | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return;
	const record = value as Record<string, unknown>;
	const filesChanged = stringArray(record.filesChanged);
	const verification = stringArray(record.verification);
	const decisions = stringArray(record.decisions);
	const nextWork = stringArray(record.nextWork);
	if (
		typeof record.stepId !== "string" ||
		typeof record.goal !== "string" ||
		!filesChanged ||
		!verification ||
		!decisions ||
		!nextWork
	) {
		return;
	}
	return { stepId: record.stepId, goal: record.goal, filesChanged, verification, decisions, nextWork };
}

function parseOnlineState(value: unknown): OnlineState | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return;
	const record = value as Record<string, unknown>;
	const plan = parsePlanSteps(record.plan);
	const pendingProgress = Array.isArray(record.pendingProgress)
		? record.pendingProgress.map(progressSummary)
		: undefined;
	const completedBoundaryRequestCounts = Array.isArray(record.completedBoundaryRequestCounts)
		? record.completedBoundaryRequestCounts
		: undefined;
	if (
		record.version !== 1 ||
		!plan ||
		!pendingProgress ||
		pendingProgress.some((item) => item === undefined) ||
		!completedBoundaryRequestCounts ||
		!completedBoundaryRequestCounts.every(nonNegativeInteger) ||
		!nonNegativeInteger(record.epoch) ||
		(typeof record.awaitingPlanRestatement !== "undefined" &&
			typeof record.awaitingPlanRestatement !== "boolean") ||
		(typeof record.lastCompactionRequestCount !== "undefined" &&
			!(record.lastCompactionRequestCount === null || nonNegativeInteger(record.lastCompactionRequestCount))) ||
		!nonNegativeInteger(record.requestCount) ||
		!nonNegativeInteger(record.lastBoundaryRequestCount) ||
		record.lastBoundaryRequestCount > record.requestCount ||
		!(record.lastContextTokens === null || nonNegativeInteger(record.lastContextTokens)) ||
		!finiteNonNegative(record.positiveContextDeltaTotal) ||
		!nonNegativeInteger(record.positiveContextDeltaCount) ||
		!nonNegativeInteger(record.nativeCompactionCount) ||
		!finiteNonNegative(record.cacheDebtTokens) ||
		!finiteNonNegative(record.cacheDebtRepaymentTokens)
	) {
		return;
	}
	return {
		version: 1,
		epoch: record.epoch,
		plan,
		awaitingPlanRestatement: record.awaitingPlanRestatement ?? false,
		pendingProgress: pendingProgress as readonly ProgressSummary[],
		requestCount: record.requestCount,
		lastCompactionRequestCount: record.lastCompactionRequestCount ?? null,
		lastBoundaryRequestCount: record.lastBoundaryRequestCount,
		completedBoundaryRequestCounts: completedBoundaryRequestCounts as readonly number[],
		lastContextTokens: record.lastContextTokens,
		positiveContextDeltaTotal: record.positiveContextDeltaTotal,
		positiveContextDeltaCount: record.positiveContextDeltaCount,
		nativeCompactionCount: record.nativeCompactionCount,
		cacheDebtTokens: record.cacheDebtTokens,
		cacheDebtRepaymentTokens: record.cacheDebtRepaymentTokens,
	};
}

export function restoreOnlineState(entries: readonly SessionEntry[]): OnlineState {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== ONLINE_STATE_ENTRY) continue;
		const state = parseOnlineState(entry.data);
		if (state) return state;
	}
	return initialOnlineState();
}

export function appendOnlineState(pi: ExtensionAPI, state: OnlineState): void {
	pi.appendEntry(ONLINE_STATE_ENTRY, state);
}

export function recordProviderRequest(state: OnlineState, contextTokens: number): OnlineState {
	const delta = state.lastContextTokens === null ? 0 : contextTokens - state.lastContextTokens;
	const cacheDebtTokens = Math.max(0, state.cacheDebtTokens - state.cacheDebtRepaymentTokens);
	return {
		...state,
		requestCount: state.requestCount + 1,
		lastContextTokens: contextTokens,
		positiveContextDeltaTotal: state.positiveContextDeltaTotal + Math.max(0, delta),
		positiveContextDeltaCount: state.positiveContextDeltaCount + (delta > 0 ? 1 : 0),
		cacheDebtTokens,
		cacheDebtRepaymentTokens: cacheDebtTokens === 0 ? 0 : state.cacheDebtRepaymentTokens,
	};
}

export function recordBoundary(
	state: OnlineState,
	plan: readonly PlanStep[],
	progress: ProgressSummary | undefined,
): OnlineState {
	const interval = Math.max(0, state.requestCount - state.lastBoundaryRequestCount);
	return {
		...state,
		plan: [...plan],
		pendingProgress: progress ? [...state.pendingProgress, progress] : state.pendingProgress,
		lastBoundaryRequestCount: state.requestCount,
		completedBoundaryRequestCounts: [...state.completedBoundaryRequestCounts, interval],
	};
}

export function recordCompaction(
	state: OnlineState,
	debt: { readonly debtTokens: number; readonly repaymentTokens: number },
): OnlineState {
	return {
		...state,
		epoch: state.epoch + 1,
		// Preserve the plan: the post-compaction reminder asks for a fresh plan,
		// and re-sending the same completed steps must not register as new
		// progress boundaries, which would immediately re-trigger compaction.
		plan: [...state.plan],
		// The reminder asks the model to re-state its plan; that first
		// update_plan is a restoration, not progress. The model may re-key
		// step ids when re-stating (observed: "3".."8" -> "p2".."p7"), so
		// id-matching alone cannot suppress the bogus boundary.
		awaitingPlanRestatement: true,
		lastCompactionRequestCount: state.requestCount,
		pendingProgress: [],
		lastContextTokens: null,
		positiveContextDeltaTotal: 0,
		positiveContextDeltaCount: 0,
		nativeCompactionCount: state.nativeCompactionCount + 1,
		cacheDebtTokens: Math.max(0, debt.debtTokens),
		cacheDebtRepaymentTokens: Math.max(0, debt.repaymentTokens),
	};
}

export function recordCorrection(state: OnlineState): OnlineState {
	return {
		...state,
		epoch: state.epoch + 1,
		plan: [],
		// The correction drops the plan; the first update_plan afterwards
		// re-states it and is not progress (same semantics as post-compaction).
		awaitingPlanRestatement: true,
		pendingProgress: [],
		lastBoundaryRequestCount: state.requestCount,
		completedBoundaryRequestCounts: [],
		lastContextTokens: null,
		positiveContextDeltaTotal: 0,
		positiveContextDeltaCount: 0,
		cacheDebtTokens: 0,
		cacheDebtRepaymentTokens: 0,
	};
}
