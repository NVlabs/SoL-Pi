/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CACHE_WRITE_READ_RATIO } from "../../config.ts";
import { createOnlineContextCompactExtension } from "./extension.ts";

export {
	DEFAULT_COMPACTION_ECONOMICS,
	decideCompaction,
	estimateRemainingRequests,
	type CompactionDecision,
	type CompactionEconomics,
	type CompactionReason,
} from "./economics.ts";
export {
	BOUNDARY_COMPACTION_INSTRUCTIONS,
	createOnlineContextCompactExtension,
	DEFAULT_KEEP_RECENT_TOKENS,
	DEFAULT_NATIVE_SUMMARY_TOKEN_ESTIMATE,
	POST_COMPACTION_PLAN_REMINDER,
	type OnlineContextCompactOptions,
	resolveKeepRecentTokens,
} from "./extension.ts";
export {
	analyzePlanTransition,
	formatPlanSnapshot,
	parsePlanSteps,
	type PlanStatus,
	type PlanStep,
} from "./plan.ts";
export {
	initialOnlineState,
	ONLINE_STATE_ENTRY,
	restoreOnlineState,
	type OnlineState,
	type ProgressSummary,
} from "./state.ts";
export type { PlanProgress, PlanUpdateInput } from "./tools.ts";

export function registerOnlineContextCompact(
	pi: ExtensionAPI,
	cacheWriteReadRatio = DEFAULT_CACHE_WRITE_READ_RATIO,
): void {
	createOnlineContextCompactExtension({ cacheWriteReadRatio })(pi);
}

export default registerOnlineContextCompact;
