/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

export type CompactionEconomics = {
	readonly remainingRequestScale: number;
	readonly remainingRequestStddevK: number;
	readonly windowReserveTokens: number;
	readonly firstCompactionRequestScale: number;
	readonly subsequentCompactionMargin: number;
};

export const DEFAULT_COMPACTION_ECONOMICS: CompactionEconomics = Object.freeze({
	remainingRequestScale: 1,
	remainingRequestStddevK: 0,
	windowReserveTokens: 16_384,
	firstCompactionRequestScale: 2,
	subsequentCompactionMargin: 1.5,
});

export type CompactionReason =
	| "economic"
	| "window_protection"
	| "deferred_economic"
	| "deferred_subsequent_margin"
	| "deferred_carried_debt"
	| "horizon_unavailable"
	| "cache_ratio_unavailable"
	| "native_not_compactable"
	| "non_positive_saving";

export type RequestHorizonEstimate = {
	readonly completedBoundaryRequestCounts: readonly number[];
	readonly requestsPerBoundaryMean: number;
	readonly requestsPerBoundaryLowerBound: number;
	readonly unboundedExpectedRemainingRequests: number;
	readonly averageContextTokenIncrement: number | null;
	readonly windowRequestUpperBound: number | null;
	readonly expectedRemainingRequests: number;
};

export type CompactionDecision = {
	readonly writeTokens: number;
	readonly archiveTokens: number;
	readonly memoTokens: number;
	readonly contextTokens: number;
	readonly completedBoundaryRequestCounts: readonly number[] | null;
	readonly requestsPerBoundaryMean: number | null;
	readonly requestsPerBoundaryLowerBound: number | null;
	readonly unboundedExpectedRemainingRequests: number | null;
	readonly averageContextTokenIncrement: number | null;
	readonly windowRequestUpperBound: number | null;
	readonly expectedRemainingRequests: number | null;
	readonly breakevenRequests: number | null;
	readonly combinedBreakevenRequests: number | null;
	readonly effectiveHorizonRequests: number | null;
	readonly cacheWriteReadRatio: number | null;
	readonly incrementalCacheCostRatio: number | null;
	readonly priorCompactionCount: number;
	readonly carriedDebtTokens: number;
	readonly cacheDebtRepaymentTokens: number;
	readonly compact: boolean;
	readonly reason: CompactionReason;
};

const MINIMUM_VARIANCE_SAMPLES = 3;
const SMALL_SAMPLE_SCALE = 0.5;

export function estimateRemainingRequests(input: {
	readonly completedBoundaryRequestCounts: readonly number[];
	readonly remainingBoundaries: number;
	readonly scale: number;
	readonly standardDeviationK: number;
	readonly contextTokens: number;
	readonly contextWindowTokens: number | null;
	readonly averageContextTokenIncrement: number | null;
}): RequestHorizonEstimate {
	const mean =
		input.completedBoundaryRequestCounts.reduce((total, count) => total + count, 0) /
		Math.max(1, input.completedBoundaryRequestCounts.length);
	let lowerBound = mean;
	if (input.standardDeviationK !== 0) {
		if (input.completedBoundaryRequestCounts.length < MINIMUM_VARIANCE_SAMPLES) {
			lowerBound *= SMALL_SAMPLE_SCALE;
		} else {
			const variance = input.completedBoundaryRequestCounts.reduce(
				(total, count) => total + (count - mean) ** 2,
				0,
			);
			const deviation = Math.sqrt(variance / (input.completedBoundaryRequestCounts.length - 1));
			lowerBound = Math.max(0, mean - input.standardDeviationK * deviation);
		}
	}

	const unboundedExpectedRemainingRequests =
		1 + Math.floor(lowerBound * Math.max(0, input.remainingBoundaries) * input.scale);
	const windowRequestUpperBound =
		input.contextWindowTokens === null ||
		input.averageContextTokenIncrement === null ||
		input.averageContextTokenIncrement <= 0
			? null
			: Math.max(
					0,
					Math.floor((input.contextWindowTokens - input.contextTokens) / input.averageContextTokenIncrement),
				);

	return {
		completedBoundaryRequestCounts: [...input.completedBoundaryRequestCounts],
		requestsPerBoundaryMean: mean,
		requestsPerBoundaryLowerBound: lowerBound,
		unboundedExpectedRemainingRequests,
		averageContextTokenIncrement: input.averageContextTokenIncrement,
		windowRequestUpperBound,
		expectedRemainingRequests:
			windowRequestUpperBound === null
				? unboundedExpectedRemainingRequests
				: Math.min(unboundedExpectedRemainingRequests, windowRequestUpperBound),
	};
}

export function decideCompaction(input: {
	readonly writeTokens: number;
	readonly archiveTokens: number;
	readonly memoTokens: number;
	readonly contextTokens: number;
	readonly completedBoundaryRequestCounts: readonly number[] | null;
	readonly remainingBoundaries: number;
	readonly averageContextTokenIncrement: number | null;
	readonly contextWindowTokens: number | null;
	readonly priorCompactionCount: number;
	readonly carriedDebtTokens: number;
	readonly cacheDebtRepaymentTokens: number;
	readonly cacheWriteReadRatio: number | null;
	readonly economics: CompactionEconomics;
}): CompactionDecision {
	const horizon =
		input.completedBoundaryRequestCounts === null
			? null
			: estimateRemainingRequests({
					completedBoundaryRequestCounts: input.completedBoundaryRequestCounts,
					remainingBoundaries: input.remainingBoundaries,
					scale: input.economics.remainingRequestScale,
					standardDeviationK: input.economics.remainingRequestStddevK,
					contextTokens: input.contextTokens,
					contextWindowTokens: input.contextWindowTokens,
					averageContextTokenIncrement: input.averageContextTokenIncrement,
				});
	const savingTokens = input.archiveTokens - input.memoTokens;
	const incrementalCacheCostRatio =
		input.cacheWriteReadRatio === null ? null : Math.max(0, input.cacheWriteReadRatio - 1);
	const breakevenRequests =
		savingTokens > 0 && incrementalCacheCostRatio !== null
			? (input.writeTokens * incrementalCacheCostRatio) / savingTokens
			: null;
	const combinedBreakevenRequests =
		savingTokens > 0 && incrementalCacheCostRatio !== null
			? (input.carriedDebtTokens + input.writeTokens * incrementalCacheCostRatio) / savingTokens
			: null;
	const firstCompaction = input.priorCompactionCount === 0;
	const effectiveHorizonRequests =
		horizon === null
			? null
			: firstCompaction
				? Math.min(
						horizon.expectedRemainingRequests * input.economics.firstCompactionRequestScale,
						horizon.windowRequestUpperBound ?? Number.POSITIVE_INFINITY,
					)
				: horizon.expectedRemainingRequests;
	const windowProtection =
		input.contextWindowTokens !== null &&
		input.contextTokens >= input.contextWindowTokens - input.economics.windowReserveTokens;
	const baseEconomic =
		horizon !== null &&
		horizon.expectedRemainingRequests > 0 &&
		breakevenRequests !== null &&
		breakevenRequests <= horizon.expectedRemainingRequests;
	const firstEconomic =
		firstCompaction &&
		effectiveHorizonRequests !== null &&
		effectiveHorizonRequests > 0 &&
		breakevenRequests !== null &&
		breakevenRequests <= effectiveHorizonRequests;
	const subsequentMarginOpen =
		!firstCompaction &&
		horizon !== null &&
		breakevenRequests !== null &&
		breakevenRequests * input.economics.subsequentCompactionMargin <= horizon.expectedRemainingRequests;
	const carriedDebtGateOpen =
		!firstCompaction &&
		horizon !== null &&
		combinedBreakevenRequests !== null &&
		combinedBreakevenRequests <= horizon.expectedRemainingRequests;
	const economic = firstCompaction ? firstEconomic : baseEconomic && subsequentMarginOpen && carriedDebtGateOpen;
	const compressible = savingTokens > 0;
	const compact = compressible && (windowProtection || economic);

	return {
		writeTokens: input.writeTokens,
		archiveTokens: input.archiveTokens,
		memoTokens: input.memoTokens,
		contextTokens: input.contextTokens,
		...(horizon ?? {
			completedBoundaryRequestCounts: null,
			requestsPerBoundaryMean: null,
			requestsPerBoundaryLowerBound: null,
			unboundedExpectedRemainingRequests: null,
			averageContextTokenIncrement: input.averageContextTokenIncrement,
			windowRequestUpperBound: null,
			expectedRemainingRequests: null,
		}),
		breakevenRequests,
		combinedBreakevenRequests,
		effectiveHorizonRequests,
		cacheWriteReadRatio: input.cacheWriteReadRatio,
		incrementalCacheCostRatio,
		priorCompactionCount: input.priorCompactionCount,
		carriedDebtTokens: input.carriedDebtTokens,
		cacheDebtRepaymentTokens: input.cacheDebtRepaymentTokens,
		compact,
		reason: !compressible
			? "non_positive_saving"
			: windowProtection
				? "window_protection"
				: economic
					? "economic"
					: horizon === null
						? "horizon_unavailable"
						: breakevenRequests === null
							? "cache_ratio_unavailable"
							: !firstCompaction && baseEconomic && !subsequentMarginOpen
								? "deferred_subsequent_margin"
								: !firstCompaction && baseEconomic && !carriedDebtGateOpen
									? "deferred_carried_debt"
									: "deferred_economic",
	};
}
