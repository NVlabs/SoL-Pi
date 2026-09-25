/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	buildContextEntries,
	buildSessionContext,
	estimateTokens,
	sessionEntryToContextMessages,
	type ExtensionContext,
	type ExtensionFactory,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { formatSavingsCount, showSolPiSavings } from "../../tui.ts";
import {
	DEFAULT_COMPACTION_ECONOMICS,
	decideCompaction,
	type CompactionDecision,
} from "./economics.ts";
import { analyzePlanTransition, formatPlanSnapshot, parsePlanSteps } from "./plan.ts";
import {
	appendOnlineState,
	initialOnlineState,
	recordBoundary,
	recordCompaction,
	recordCorrection,
	recordProviderRequest,
	restoreOnlineState,
	type OnlineState,
	type ProgressSummary,
} from "./state.ts";
import { registerOnlineTools, type PlanUpdateInput } from "./tools.ts";

export const DEFAULT_KEEP_RECENT_TOKENS = 20_000;
export const DEFAULT_NATIVE_SUMMARY_TOKEN_ESTIMATE = 1_000;
export const BOUNDARY_COMPACTION_INSTRUCTIONS =
	"Preserve completed work, verification results, important decisions, and remaining work.";
export const POST_COMPACTION_PLAN_REMINDER =
	"Online context compaction finished. The parent task is still active. " +
	"Before continuing work, call update_plan with a fresh plan for the remaining work.";
export const SKIPPED_COMPACTION_CONTINUATION =
	"Online context compaction was skipped: the session has nothing left to compact. " +
	"The parent task is still active. Continue the remaining work from the current plan.";

const BENIGN_COMPACTION_SKIP_MESSAGES: ReadonlySet<string> = new Set([
	"Nothing to compact (session too small)",
	"Already compacted",
]);

function isBenignCompactionSkip(error: Error | undefined): boolean {
	return error !== undefined && BENIGN_COMPACTION_SKIP_MESSAGES.has(error.message);
}

export type OnlineContextCompactOptions = {
	readonly cacheWriteReadRatio?: number | null;
	readonly keepRecentTokens?: number;
};

type PendingBoundary = { readonly toolCallId: string };
type SelectedCompaction = { readonly decision: CompactionDecision };
type CacheDebt = { readonly debtTokens: number; readonly repaymentTokens: number };
type PendingContinuation = { readonly promise: Promise<void>; readonly resolve: () => void };

export function resolveKeepRecentTokens(value: number | undefined): number {
	const resolved = value ?? DEFAULT_KEEP_RECENT_TOKENS;
	if (!Number.isSafeInteger(resolved) || resolved < 1) {
		throw new Error("Online Context Compact keepRecentTokens must be a positive safe integer");
	}
	return resolved;
}

function resolveCacheWriteReadRatio(value: number | null | undefined): number | null {
	if (value === undefined || value === null) return null;
	if (!Number.isFinite(value) || value < 0) {
		throw new Error("Online Context Compact cacheWriteReadRatio must be finite and non-negative");
	}
	return value;
}

function tokenEstimate(text: string): number {
	return Math.ceil(Buffer.byteLength(text) / 4);
}

function result(text: string, details: Readonly<Record<string, unknown>>): AgentToolResult<Readonly<Record<string, unknown>>> {
	return { content: [{ type: "text", text }], details };
}

function progressSummary(input: PlanUpdateInput, completedStepId: string): ProgressSummary | undefined {
	const step = input.steps.find((item) => item.id === completedStepId);
	if (!step || !input.progress) return;
	return {
		stepId: step.id,
		goal: step.goal,
		filesChanged: [...input.progress.files_changed],
		verification: [...input.progress.verification],
		decisions: [...input.progress.decisions],
		nextWork: input.steps.filter((item) => item.status !== "completed").map((item) => item.goal),
	};
}

type ProjectedEntry = { readonly sourceEntry: SessionEntry; readonly messages: readonly AgentMessage[] };
type ProjectedCutPoint = {
	readonly firstKeptEntryIndex: number;
	readonly turnStartIndex: number;
	readonly isSplitTurn: boolean;
};

const CUT_POINT_ROLES: ReadonlySet<string> = new Set([
	"user",
	"assistant",
	"bashExecution",
	"custom",
	"branchSummary",
	"compactionSummary",
]);
const TURN_START_ROLES: ReadonlySet<string> = new Set([
	"user",
	"bashExecution",
	"custom",
	"branchSummary",
	"compactionSummary",
]);

/**
 * Pi 0.87 introduced context edits; older releases have no such entries. The
 * shape is read defensively so the check compiles against both type surfaces.
 */
type ContextEditShape = { readonly targetId?: unknown; readonly replacement?: unknown };

function asContextEdit(entry: SessionEntry): (ContextEditShape & { readonly type?: string }) | undefined {
	const shape = entry as unknown as ContextEditShape & { type?: string };
	return shape.type === "context_edit" ? shape : undefined;
}

/** Latest context edit per target, mirroring how Pi's projection applies edits. */
function latestContextEdits(entries: readonly SessionEntry[]): Map<string, ContextEditShape> {
	const edits = new Map<string, ContextEditShape>();
	for (const entry of entries) {
		const edit = asContextEdit(entry);
		if (edit && typeof edit.targetId === "string") edits.set(edit.targetId, edit);
	}
	return edits;
}

/**
 * Reconstruct the projected window Pi's compaction preparation works on: the
 * latest compaction entry first, its retained raw entries, everything appended
 * after it, with omitted targets removed. Replacements keep their original
 * size here, which can only overestimate the kept window and therefore never
 * overstates feasibility.
 */
function projectBranchEntries(entries: readonly SessionEntry[]): ProjectedEntry[] {
	const contextEntries = buildContextEntries([...entries]);
	const edits = latestContextEdits(entries);
	return contextEntries.map((sourceEntry, index) => {
		const edit = edits.get(sourceEntry.id);
		const messages =
			sourceEntry.type === "compaction" && index > 0
				? []
				: edit && edit.replacement === null
					? []
					: sessionEntryToContextMessages(sourceEntry);
		return { sourceEntry, messages };
	});
}

function isProjectedTurnStart(entry: ProjectedEntry | undefined): boolean {
	return (
		entry !== undefined &&
		entry.sourceEntry.type !== "compaction" &&
		entry.messages.some((message) => TURN_START_ROLES.has(message.role))
	);
}

function findProjectedTurnStartIndex(entries: readonly ProjectedEntry[], entryIndex: number, startIndex: number): number {
	for (let index = entryIndex; index >= startIndex; index--) {
		if (isProjectedTurnStart(entries[index])) return index;
	}
	return -1;
}

/** Mirrors Pi's projected cut-point selection (keepRecentTokens suffix budget). */
function findProjectedCutPoint(
	entries: readonly ProjectedEntry[],
	startIndex: number,
	endIndex: number,
	keepRecentTokens: number,
): ProjectedCutPoint {
	const cutPoints: number[] = [];
	for (let index = startIndex; index < endIndex; index++) {
		const entry = entries[index];
		if (!entry) continue;
		if (
			entry.sourceEntry.type !== "compaction" &&
			entry.messages.some((message) => CUT_POINT_ROLES.has(message.role))
		) {
			cutPoints.push(index);
		}
	}
	if (cutPoints.length === 0) {
		return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
	}

	let accumulatedTokens = 0;
	let exceededBudget = false;
	let cutIndex = cutPoints[0] ?? startIndex;
	for (let index = endIndex - 1; index >= startIndex; index--) {
		const entry = entries[index];
		if (!entry) continue;
		const messageTokens = entry.messages.reduce((total, message) => total + estimateTokens(message), 0);
		if (messageTokens === 0) continue;
		accumulatedTokens += messageTokens;
		if (accumulatedTokens >= keepRecentTokens) {
			exceededBudget = true;
			cutIndex = cutPoints.find((candidate) => candidate >= index) ?? cutPoints[cutPoints.length - 1] ?? cutIndex;
			break;
		}
	}

	// A recovery attempt and its omission edits are context-invisible after the
	// last visible input; advance only for such a closed suffix.
	const suffix = entries.slice(cutIndex + 1, endIndex);
	const isIntrinsicallyVisible = (entry: ProjectedEntry): boolean =>
		asContextEdit(entry.sourceEntry) === undefined &&
		sessionEntryToContextMessages(entry.sourceEntry).length > 0;
	const isOmitted = (entry: ProjectedEntry): boolean => isIntrinsicallyVisible(entry) && entry.messages.length === 0;
	const omittedSuffixIds = new Set(suffix.filter(isOmitted).map((entry) => entry.sourceEntry.id));
	const hasExternalReplacement = suffix.some((entry) => {
		const edit = asContextEdit(entry.sourceEntry);
		return (
			edit !== undefined &&
			edit.replacement !== null &&
			typeof edit.targetId === "string" &&
			!omittedSuffixIds.has(edit.targetId)
		);
	});
	const isRecoveryOmissionSuffix =
		exceededBudget &&
		!hasExternalReplacement &&
		suffix.some(
			(entry) =>
				entry.sourceEntry.type === "message" &&
				entry.sourceEntry.message.role === "assistant" &&
				isOmitted(entry),
		) &&
		suffix.every(
			(entry) => entry.sourceEntry.type !== "compaction" && (!isIntrinsicallyVisible(entry) || isOmitted(entry)),
		);
	if (isRecoveryOmissionSuffix) cutIndex += 1;
	while (cutIndex > startIndex) {
		const previous = entries[cutIndex - 1];
		if (!previous || previous.sourceEntry.type === "compaction" || previous.messages.length > 0) break;
		cutIndex -= 1;
	}
	const startsTurn = isProjectedTurnStart(entries[cutIndex]);
	const turnStartIndex = startsTurn ? -1 : findProjectedTurnStartIndex(entries, cutIndex, startIndex);
	return { firstKeptEntryIndex: cutIndex, turnStartIndex, isSplitTurn: !startsTurn && turnStartIndex !== -1 };
}

function summarizableMessageCount(projected: readonly ProjectedEntry[], fromIndex: number, toIndex: number): number {
	let count = 0;
	for (let index = Math.max(0, fromIndex); index < toIndex; index++) {
		const entry = projected[index];
		if (!entry || entry.sourceEntry.type === "compaction") continue;
		for (const message of entry.messages) {
			// System messages are prompt state, not conversation; Pi's compaction
			// preparation never summarizes them. The role is widened because older
			// Pi type surfaces do not include "system" in AgentMessage.
			if ((message.role as string) !== "system") count += 1;
		}
	}
	return count;
}

/**
 * Mirrors Pi's compaction preparation closely enough to predict its outcome:
 * native compaction can run only when the projected window holds summarizable
 * (non-system) messages before the projected cut point. Pi 0.87 projects the
 * session and filters system messages out of the summary set, so counting raw
 * entries (the pre-0.87 behavior) can claim feasibility where
 * AgentSession.compact() then fails with "Nothing to compact (session too
 * small)" after the turn was already aborted for it.
 */
function nativeCompactionFeasible(entries: readonly SessionEntry[], keepRecentTokens: number): boolean {
	if (entries.length === 0 || entries[entries.length - 1]?.type === "compaction") return false;
	const projected = projectBranchEntries(entries);
	let boundaryStart = 0;
	for (let index = 0; index < projected.length; index++) {
		const entry = projected[index];
		if (entry && entry.sourceEntry.type === "compaction" && entry.messages.length > 0) {
			boundaryStart = index + 1;
			break;
		}
	}
	const cut = findProjectedCutPoint(projected, boundaryStart, projected.length, keepRecentTokens);
	const firstKept = projected[cut.firstKeptEntryIndex]?.sourceEntry;
	if (!firstKept?.id) return false;
	const historyEnd = cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptEntryIndex;
	const historyMessages =
		historyEnd > boundaryStart ? summarizableMessageCount(projected, boundaryStart, historyEnd) : 0;
	const prefixMessages =
		cut.isSplitTurn && cut.turnStartIndex >= 0
			? summarizableMessageCount(projected, cut.turnStartIndex, cut.firstKeptEntryIndex)
			: 0;
	return historyMessages > 0 || prefixMessages > 0;
}

function validPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function createOnlineContextCompactExtension(options: OnlineContextCompactOptions = {}): ExtensionFactory {
	const keepRecentTokens = resolveKeepRecentTokens(options.keepRecentTokens);
	const cacheWriteReadRatio = resolveCacheWriteReadRatio(options.cacheWriteReadRatio);

	return (pi) => {
		let state: OnlineState = initialOnlineState();
		let restored = false;
		let observedMessages: readonly AgentMessage[] = [];
		let pendingBoundary: PendingBoundary | undefined;
		let selected: SelectedCompaction | undefined;
		let activeDebt: CacheDebt | undefined;
		let nextContinuation: PendingContinuation | undefined;
		let compactionInFlight = false;
		let benignSkipStreak = 0;

		const releaseContinuation = (): void => {
			const continuation = nextContinuation;
			nextContinuation = undefined;
			continuation?.resolve();
		};
		const releaseParentContinuation = (continuation: PendingContinuation | undefined): void => {
			if (continuation) setTimeout(continuation.resolve, 0);
		};

		const restore = (context: ExtensionContext): void => {
			releaseContinuation();
			state = restoreOnlineState(context.sessionManager.getBranch());
			restored = true;
			observedMessages = buildSessionContext(
				context.sessionManager.getEntries(),
				context.sessionManager.getLeafId(),
			).messages;
			pendingBoundary = undefined;
			selected = undefined;
			activeDebt = undefined;
			compactionInFlight = false;
			benignSkipStreak = 0;
		};
		const ensureRestored = (context: ExtensionContext): void => {
			if (!restored) restore(context);
		};
		const save = (): void => appendOnlineState(pi, state);
		const contextTokens = (context: ExtensionContext): number => {
			const visible = observedMessages.reduce((total, message) => total + estimateTokens(message), 0);
			const estimated = visible + tokenEstimate(context.getSystemPrompt());
			const reported = context.getContextUsage()?.tokens;
			return validPositiveInteger(reported) ? Math.max(reported, estimated) : estimated;
		};

		registerOnlineTools(pi, {
			updatePlan: async (input) => {
				ensureRestored(input.context);
				if (input.signal?.aborted) throw new Error("Plan update was aborted");
				const steps = parsePlanSteps(input.steps);
				if (!steps || steps.length === 0) throw new Error("Plan must contain at least one valid step");

				const transition = analyzePlanTransition(state.plan, steps);
				const completedIds = transition.completedSteps.map((step) => step.id);
				if (completedIds.length > 0) {
					state = recordBoundary(state, steps, progressSummary(input, completedIds[0] ?? ""));
					if (!pendingBoundary) pendingBoundary = { toolCallId: input.toolCallId };
				} else if (JSON.stringify(state.plan) !== JSON.stringify(steps)) {
					state = { ...state, plan: [...steps] };
				}
				save();

				return result(
					[formatPlanSnapshot(steps), ...transition.advice].join("\n"),
					{
						boundary: completedIds.length > 0,
						completed_step_ids: completedIds,
						progress_recorded: completedIds.length > 0 && input.progress !== undefined,
						task_status: "active",
						plan: steps,
					},
				);
			},
		});

		pi.on("session_start", (_event, context) => restore(context));
		pi.on("session_before_tree", () => (compactionInFlight ? { cancel: true } : undefined));
		pi.on("session_tree", (_event, context) => restore(context));

		pi.on("context", (event, context) => {
			ensureRestored(context);
			observedMessages = [...event.messages];
		});

		pi.on("before_provider_request", (_event, context) => {
			ensureRestored(context);
			state = recordProviderRequest(state, contextTokens(context));
			save();
		});

		pi.on("input", (event, context) => {
			if (event.streamingBehavior !== "steer" && !event.text.startsWith("CORRECTION:")) {
				return { action: "continue" as const };
			}
			ensureRestored(context);
			pendingBoundary = undefined;
			selected = undefined;
			activeDebt = undefined;
			state = recordCorrection(state);
			save();
			return { action: "continue" as const };
		});

		pi.on("turn_end", (event, context) => {
			const boundary = pendingBoundary;
			pendingBoundary = undefined;
			if (!boundary || selected) return;
			const toolResult = event.toolResults.find((item) => item.toolCallId === boundary.toolCallId);
			if (
				event.message.role !== "assistant" ||
				event.message.stopReason === "error" ||
				event.message.stopReason === "aborted" ||
				context.signal?.aborted ||
				!toolResult ||
				toolResult.isError
			) {
				return;
			}

			const usage = context.getContextUsage();
			const writeTokens = contextTokens(context);
			const fixedTokens = tokenEstimate(context.getSystemPrompt());
			const archiveTokens = Math.max(0, writeTokens - fixedTokens - keepRecentTokens);
			const contextWindowTokens = validPositiveInteger(usage?.contextWindow)
				? usage.contextWindow
				: validPositiveInteger(context.model?.contextWindow)
					? context.model.contextWindow
					: null;
			const averageContextTokenIncrement =
				state.positiveContextDeltaCount === 0
					? null
					: state.positiveContextDeltaTotal / state.positiveContextDeltaCount;
			const priced = decideCompaction({
				writeTokens,
				archiveTokens,
				memoTokens: DEFAULT_NATIVE_SUMMARY_TOKEN_ESTIMATE,
				contextTokens: writeTokens,
				completedBoundaryRequestCounts: state.completedBoundaryRequestCounts,
				remainingBoundaries: state.plan.filter((step) => step.status !== "completed").length,
				averageContextTokenIncrement,
				contextWindowTokens,
				priorCompactionCount: state.nativeCompactionCount,
				carriedDebtTokens: state.cacheDebtTokens,
				cacheDebtRepaymentTokens: state.cacheDebtRepaymentTokens,
				cacheWriteReadRatio,
				economics: DEFAULT_COMPACTION_ECONOMICS,
			});
			const decision: CompactionDecision =
				priced.compact && !nativeCompactionFeasible(context.sessionManager.getBranch(), keepRecentTokens)
					? { ...priced, compact: false, reason: "native_not_compactable" }
					: priced;
			if (!decision.compact) return;

			selected = { decision };
			context.abort();
		});

		pi.on("agent_settled", async (_event, context) => {
			// sendMessage() starts a turn without returning its promise. Capture the
			// child settlement so print/JSON mode cannot dispose while it is running.
			const parentContinuation = nextContinuation;
			nextContinuation = undefined;
			const pending = selected;
			selected = undefined;
			if (!context.isIdle()) {
				selected = pending;
				nextContinuation = parentContinuation;
				return;
			}
			if (!pending) {
				releaseParentContinuation(parentContinuation);
				return;
			}

			activeDebt = {
				debtTokens: pending.decision.writeTokens * (pending.decision.incrementalCacheCostRatio ?? 0),
				repaymentTokens: Math.max(0, pending.decision.archiveTokens - pending.decision.memoTokens),
			};
			let compacted = false;
			let compactionError: Error | undefined;
			try {
				compactionInFlight = true;
				await new Promise<void>((resolve) => {
					let finished = false;
					const finish = (): void => {
						if (finished) return;
						finished = true;
						resolve();
					};
					context.compact({
						customInstructions: BOUNDARY_COMPACTION_INSTRUCTIONS,
						onComplete: (compaction) => {
							try {
								compacted = true;
								const removed = Math.max(
									0,
									pending.decision.archiveTokens - tokenEstimate(compaction.summary),
								);
								if (removed > 0) {
									showSolPiSavings(
										context,
										"Online Context Compact",
										formatSavingsCount(removed, "context tokens removed"),
									);
								}
							} finally {
								finish();
							}
						},
						onError: (error) => {
							compactionError = error;
							finish();
						},
					});
				});
				compactionInFlight = false;
				const benignSkip = isBenignCompactionSkip(compactionError);
				if (
					compactionError &&
					!benignSkip &&
					compactionError.name !== "AbortError" &&
					compactionError.message !== "Compaction cancelled"
				) {
					throw compactionError;
				}
				// A benign skip still owes the session a resume: the turn was aborted
				// for a compaction that turned out to have nothing to do. Resume once;
				// a consecutive skip leaves the session idle instead of looping.
				benignSkipStreak = benignSkip ? benignSkipStreak + 1 : 0;
				const resumeSkippedCompaction = benignSkip && benignSkipStreak <= 1;

				if (compacted || resumeSkippedCompaction) {
					if (compacted) benignSkipStreak = 0;
					const continuationText = compacted ? POST_COMPACTION_PLAN_REMINDER : SKIPPED_COMPACTION_CONTINUATION;
					let resolveContinuation!: () => void;
					const continuation: PendingContinuation = {
						promise: new Promise<void>((resolve) => {
							resolveContinuation = resolve;
						}),
						resolve: () => resolveContinuation(),
					};
					nextContinuation = continuation;
					try {
						pi.sendMessage(
							{
								customType: "sol-pi-online-context-compact",
								content: continuationText,
								display: false,
							},
							{ triggerTurn: true },
						);
					} catch (error) {
						if (nextContinuation === continuation) nextContinuation = undefined;
						continuation.resolve();
						throw error;
					}
					if (context.isIdle() && nextContinuation === continuation) {
						nextContinuation = undefined;
						continuation.resolve();
						throw new Error("Online context compact continuation did not start");
					}
					await continuation.promise;
				}
			} finally {
				compactionInFlight = false;
				activeDebt = undefined;
				releaseParentContinuation(parentContinuation);
			}
		});

		pi.on("session_compact", (event, context) => {
			ensureRestored(context);
			state = recordCompaction(
				state,
				event.fromExtension || !activeDebt ? { debtTokens: 0, repaymentTokens: 0 } : activeDebt,
			);
			save();
			pendingBoundary = undefined;
			selected = undefined;
			activeDebt = undefined;
			observedMessages = buildSessionContext(
				context.sessionManager.getEntries(),
				context.sessionManager.getLeafId(),
			).messages;
		});

		pi.on("session_shutdown", () => {
			releaseContinuation();
			pendingBoundary = undefined;
			selected = undefined;
			activeDebt = undefined;
			compactionInFlight = false;
		});
	};
}
