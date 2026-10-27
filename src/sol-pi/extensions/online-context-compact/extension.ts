/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	estimateTokens,
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
import { estimateProjectedCompactionTokens } from "./projection.ts";
import {
	appendOnlineState,
	initialOnlineState,
	recordBoundary,
	recordCompaction,
	recordCompletedPlanHandoff,
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
	"Continue the remaining work from the current plan. Preserve existing step IDs when updating progress.";
export const SKIPPED_COMPACTION_REMINDER =
	"Online context compaction was skipped. The existing context is still available. " +
	"Continue the remaining work from the current plan.";
// Pi rejects these before committing a replacement summary, so the current
// context is still usable. Unknown errors and user cancellation remain distinct.
const RECOVERABLE_COMPACTION_ERRORS = new Set([
	"Nothing to compact (session too small)",
	"Already compacted",
	"Summarization failed: generation hit the token cap and the summary is incomplete",
]);
export const COMPACTION_FAILED_RESUME_REMINDER =
	"Online context compaction did not complete. The parent task is still active. " +
	"Continue the remaining work from the current plan.";

export type OnlineContextCompactOptions = {
	readonly cacheWriteReadRatio?: number | null;
	readonly keepRecentTokens?: number;
};

type PendingBoundary = { readonly toolCallId: string };
type SelectedCompaction = { readonly decision: CompactionDecision };
type CacheDebt = { readonly debtTokens: number; readonly repaymentTokens: number };
type PendingContinuation = { readonly promise: Promise<void>; readonly resolve: () => void };
type CompactionTokenSettings = { readonly keepRecentTokens: number; readonly reserveTokens: number };
type SettingsSource = { readonly getSettings?: () => unknown };

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

type SystemPromptPart = string | { readonly text?: string };

// Pi types the system prompt as a string, but Pi-compatible hosts can return
// segments or content parts at runtime, so normalize before measuring bytes.
function tokenEstimate(prompt: string | readonly SystemPromptPart[]): number {
	const text = typeof prompt === "string"
		? prompt
		: prompt.map((part) => (typeof part === "string" ? part : (part.text ?? ""))).join("\n");
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

export function estimateNativeCompactionTokens(
	entries: readonly SessionEntry[],
	keepRecentTokens: number,
	projectedMessages?: readonly AgentMessage[],
): number {
	return estimateProjectedCompactionTokens(entries, keepRecentTokens, projectedMessages);
}

function validPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function tokenSetting(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Readonly<Record<string, unknown>>)
		: undefined;
}

/**
 * Pi's effective compaction token settings for `model`, resolved the way Pi resolves them:
 * `compaction.modelOverrides["<provider>/<id>"]`, then `compaction`, then Pi's defaults.
 */
export function resolveCompactionTokenSettings(
	settings: unknown,
	model: { readonly provider: string; readonly id: string } | undefined,
): CompactionTokenSettings {
	const compaction = record(record(settings)?.compaction);
	const override = model ? record(record(compaction?.modelOverrides)?.[`${model.provider}/${model.id}`]) : undefined;
	return {
		keepRecentTokens:
			tokenSetting(override?.keepRecentTokens) ??
			tokenSetting(compaction?.keepRecentTokens) ??
			DEFAULT_KEEP_RECENT_TOKENS,
		reserveTokens:
			tokenSetting(override?.reserveTokens) ??
			tokenSetting(compaction?.reserveTokens) ??
			DEFAULT_COMPACTION_ECONOMICS.windowReserveTokens,
	};
}

function isUserAbort(error: Error): boolean {
	return error.name === "AbortError" || error.message === "Compaction cancelled";
}

export function createOnlineContextCompactExtension(options: OnlineContextCompactOptions = {}): ExtensionFactory {
	const configuredKeepRecentTokens =
		options.keepRecentTokens === undefined ? undefined : resolveKeepRecentTokens(options.keepRecentTokens);
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
		let requestPending = false;
		let compactionRefused = false;

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
			// Restoring raw history is not evidence of a provider-visible projection.
			observedMessages = [];
			pendingBoundary = undefined;
			selected = undefined;
			activeDebt = undefined;
			compactionInFlight = false;
			requestPending = false;
			compactionRefused = false;
		};
		const ensureRestored = (context: ExtensionContext): void => {
			if (!restored) restore(context);
		};
		const save = (): void => appendOnlineState(pi, state);
		// Pi 1.0 exposes its effective settings; Pi 0.84.2 does not, so it keeps the documented defaults.
		const compactionSettings = (context: ExtensionContext): CompactionTokenSettings => {
			const getSettings = (pi as SettingsSource).getSettings;
			let settings: unknown;
			try {
				settings = typeof getSettings === "function" ? getSettings.call(pi) : undefined;
			} catch {
				settings = undefined;
			}
			const resolved = resolveCompactionTokenSettings(settings, context.model);
			return configuredKeepRecentTokens === undefined
				? resolved
				: { ...resolved, keepRecentTokens: configuredKeepRecentTokens };
		};
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
				} else {
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

		// Count a provider request only when it carries an agent-loop context. Pi builds each agent
		// request with one context event before the provider sends it. A build that never reaches the
		// provider, such as the one Pi still starts after this extension aborts at a boundary, is not
		// a request. Pi 1.0 cache warming replays the last request through before_provider_request
		// without a context event; a replay is not a request either.
		pi.on("context", (event, context) => {
			ensureRestored(context);
			observedMessages = [...event.messages];
			requestPending = !context.signal?.aborted;
		});

		pi.on("before_provider_request", (_event, context) => {
			if (!requestPending) return;
			requestPending = false;
			ensureRestored(context);
			state = recordProviderRequest(state, contextTokens(context));
			save();
		});

		// The assistant message ends the request a context event started, whether or not it reached
		// the provider, so a later replay cannot take its place.
		pi.on("message_end", (event) => {
			if (event.message.role === "assistant") requestPending = false;
		});

		pi.on("input", (event, context) => {
			compactionRefused = false;
			ensureRestored(context);
			if (event.streamingBehavior !== "steer" && !event.text.startsWith("CORRECTION:")) {
				const next = recordCompletedPlanHandoff(state);
				if (next !== state) {
					state = next;
					save();
				}
				return { action: "continue" as const };
			}
			pendingBoundary = undefined;
			selected = undefined;
			activeDebt = undefined;
			state = recordCorrection(state);
			save();
			return { action: "continue" as const };
		});

		pi.on("turn_end", (event, context) => {
			// Plan chatter cannot make a rejected compact feasible. Require actual
			// tool work or new user input before attempting another boundary.
			if (event.toolResults.some((item) => item.toolName !== "update_plan" && !item.isError)) compactionRefused = false;
			const boundary = pendingBoundary;
			pendingBoundary = undefined;
			if (!boundary || selected || compactionRefused) return;
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

			const { keepRecentTokens, reserveTokens } = compactionSettings(context);
			const usage = context.getContextUsage();
			const writeTokens = contextTokens(context);
			const archiveTokens = estimateNativeCompactionTokens(
				context.sessionManager.getBranch(),
				keepRecentTokens,
				observedMessages,
			);
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
				requestsSinceLastCompaction:
					state.lastCompactionRequestCount === null
						? null
						: state.requestCount - state.lastCompactionRequestCount,
				carriedDebtTokens: state.cacheDebtTokens,
				cacheDebtRepaymentTokens: state.cacheDebtRepaymentTokens,
				cacheWriteReadRatio,
				economics: { ...DEFAULT_COMPACTION_ECONOMICS, windowReserveTokens: reserveTokens },
			});
			const decision: CompactionDecision =
				priced.compact && archiveTokens === 0
					? { ...priced, compact: false, reason: "native_not_compactable" }
					: priced;
			if (!decision.compact) return;

			selected = { decision };
			context.abort();
		});

		// Resume the parent task after a boundary compaction. Pi before 0.87 starts the requested turn
		// synchronously, and this barrier keeps the settlement open until that turn settles. Pi 0.87+
		// defers a turn requested from agent_settled until every settled handler has returned, keeps
		// the session idle meanwhile, and awaits the turn before its own settlement completes, so
		// waiting here would deadlock.
		const continueParentTask = async (context: ExtensionContext, content: string): Promise<void> => {
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
					{ customType: "sol-pi-online-context-compact", content, display: false },
					{ triggerTurn: true },
				);
			} catch (error) {
				if (nextContinuation === continuation) nextContinuation = undefined;
				continuation.resolve();
				throw error;
			}
			if (context.isIdle()) {
				if (nextContinuation === continuation) nextContinuation = undefined;
				continuation.resolve();
				return;
			}
			await continuation.promise;
		};

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
				debtTokens: pending.decision.postCompactionTokens * (pending.decision.incrementalCacheCostRatio ?? 0),
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
							activeDebt = undefined;
							compactionError = error;
							finish();
						},
					});
				});
				compactionInFlight = false;
				const failure = compactionError && !isUserAbort(compactionError) ? compactionError : undefined;
				const recoverableError = failure !== undefined && RECOVERABLE_COMPACTION_ERRORS.has(failure.message);
				if (recoverableError) {
					compactionRefused = true;
					pi.appendEntry("sol-pi-online-context-compact-skipped", { reason: failure!.message });
					if (context.mode === "tui") context.ui.notify(`Online compaction skipped: ${failure!.message}`, "warning");
				}

				// The run was stopped for this compaction, so resume it unless the user cancelled.
				// Known native refusals are recorded as skips; other failures still propagate after resuming.
				if (compacted) await continueParentTask(context, POST_COMPACTION_PLAN_REMINDER);
				else if (recoverableError) await continueParentTask(context, SKIPPED_COMPACTION_REMINDER);
				else if (failure) await continueParentTask(context, COMPACTION_FAILED_RESUME_REMINDER);
				if (failure && !recoverableError) throw failure;
			} finally {
				compactionInFlight = false;
				activeDebt = undefined;
				releaseParentContinuation(parentContinuation);
			}
		});

		// Pi may run its own threshold compaction for a run this extension has already stopped for a
		// selected boundary compaction: Pi 0.84.4+ before the run's next request, older Pi after the
		// run when the aborted request ends with an error. That compaction would consume the
		// selection, so the boundary would get no continuation. Let the selected compaction run from
		// agent_settled instead.
		pi.on("session_before_compact", (event) =>
			selected && event.reason === "threshold" ? { cancel: true } : undefined,
		);

		pi.on("session_compact", (event, context) => {
			ensureRestored(context);
			compactionRefused = false;
			state = recordCompaction(
				state,
				event.fromExtension || !activeDebt ? { debtTokens: 0, repaymentTokens: 0 } : activeDebt,
			);
			save();
			pendingBoundary = undefined;
			selected = undefined;
			activeDebt = undefined;
			requestPending = false;
			observedMessages = [];
		});

		pi.on("session_shutdown", () => {
			releaseContinuation();
			pendingBoundary = undefined;
			selected = undefined;
			activeDebt = undefined;
			compactionInFlight = false;
			requestPending = false;
		});
	};
}
