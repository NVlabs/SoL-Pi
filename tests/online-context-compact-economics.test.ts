/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { describe, expect, it } from "vitest";
import {
	DEFAULT_COMPACTION_ECONOMICS,
	decideCompaction,
	estimateRemainingRequests,
} from "../src/sol-pi/extensions/online-context-compact/economics.ts";

function decision(overrides: Partial<Parameters<typeof decideCompaction>[0]> = {}) {
	return decideCompaction({
		writeTokens: 80_000,
		archiveTokens: 60_000,
		memoTokens: 1_000,
		contextTokens: 80_000,
		completedBoundaryRequestCounts: [4, 6, 5],
		remainingBoundaries: 4,
		averageContextTokenIncrement: 2_000,
		contextWindowTokens: 200_000,
		priorCompactionCount: 0,
		carriedDebtTokens: 0,
		cacheDebtRepaymentTokens: 0,
		cacheWriteReadRatio: 1,
		economics: DEFAULT_COMPACTION_ECONOMICS,
		...overrides,
	});
}

describe("Online Context Compact economics", () => {
	it("estimates the remaining request horizon from completed boundaries", () => {
		expect(
			estimateRemainingRequests({
				completedBoundaryRequestCounts: [4, 6, 5],
				remainingBoundaries: 3,
				scale: 1,
				standardDeviationK: 0,
				contextTokens: 100_000,
				contextWindowTokens: 200_000,
				averageContextTokenIncrement: 5_000,
			}),
		).toMatchObject({
			requestsPerBoundaryMean: 5,
			expectedRemainingRequests: 16,
			windowRequestUpperBound: 20,
		});
	});

	it("rejects a compaction that cannot remove more than its summary", () => {
		expect(decision({ archiveTokens: 500, memoTokens: 1_000 })).toMatchObject({
			compact: false,
			reason: "non_positive_saving",
		});
	});

	it("compacts when the economic breakeven fits the remaining horizon", () => {
		expect(decision()).toMatchObject({ compact: true, reason: "economic" });
	});

	it("uses window protection even when the ordinary economic gate defers", () => {
		expect(
			decision({
				contextTokens: 195_000,
				cacheWriteReadRatio: 100,
				economics: { ...DEFAULT_COMPACTION_ECONOMICS, windowReserveTokens: 10_000 },
			}),
		).toMatchObject({ compact: true, reason: "window_protection" });
	});

	it("defers economic compaction when no cache ratio is available", () => {
		expect(decision({ cacheWriteReadRatio: null })).toMatchObject({
			compact: false,
			reason: "cache_ratio_unavailable",
		});
	});

	it("charges carried debt only after the first compaction", () => {
		const result = decision({
			priorCompactionCount: 1,
			cacheWriteReadRatio: 2,
			carriedDebtTokens: 2_000_000,
		});
		expect(result.compact).toBe(false);
		expect(result.reason).toBe("deferred_carried_debt");
		expect(result.combinedBreakevenRequests).toBeGreaterThan(result.breakevenRequests ?? 0);
	});

	it("applies the subsequent margin to carried cache debt", () => {
		const result = decision({
			writeTokens: 39_940,
			archiveTokens: 17_226,
			memoTokens: 1_000,
			contextTokens: 39_940,
			completedBoundaryRequestCounts: [109, 5, 13, 63, 30, 29, 42, 4, 3],
			remainingBoundaries: 2,
			averageContextTokenIncrement: 2_749,
			contextWindowTokens: 272_000,
			priorCompactionCount: 6,
			carriedDebtTokens: 504_623,
			cacheWriteReadRatio: 12.5,
			requestsSinceCompaction: 20,
		});
		expect(result.compact).toBe(false);
		expect(result.reason).toBe("deferred_carried_debt");
		expect(result.combinedBreakevenRequests ?? 0).toBeLessThanOrEqual(result.expectedRemainingRequests ?? 0);
		expect((result.combinedBreakevenRequests ?? 0) * DEFAULT_COMPACTION_ECONOMICS.subsequentCompactionMargin).toBeGreaterThan(
			result.expectedRemainingRequests ?? 0,
		);
	});

	it("defers a subsequent compact that cannot beat the retained tail", () => {
		expect(
			decision({
				writeTokens: 39_940,
				archiveTokens: 17_226,
				memoTokens: 1_000,
				contextTokens: 39_940,
				completedBoundaryRequestCounts: [4, 3],
				remainingBoundaries: 2,
				priorCompactionCount: 6,
				cacheWriteReadRatio: 12.5,
				minimumSavingTokens: 20_000,
				requestsSinceCompaction: 20,
			}),
		).toMatchObject({ compact: false, reason: "deferred_near_floor" });
	});

	it("defers a subsequent compact that is still inside the cooldown", () => {
		expect(
			decision({
				writeTokens: 75_250,
				archiveTokens: 52_536,
				memoTokens: 1_000,
				contextTokens: 75_250,
				completedBoundaryRequestCounts: [29, 42],
				remainingBoundaries: 2,
				priorCompactionCount: 5,
				cacheWriteReadRatio: 12.5,
				minimumSavingTokens: 20_000,
				requestsSinceCompaction: 7,
			}),
		).toMatchObject({ compact: false, reason: "deferred_cooldown" });
	});

	it("still uses window protection during cooldown or near the floor", () => {
		expect(
			decision({
				writeTokens: 39_940,
				archiveTokens: 17_226,
				memoTokens: 1_000,
				contextTokens: 195_000,
				completedBoundaryRequestCounts: [4, 3],
				remainingBoundaries: 2,
				priorCompactionCount: 6,
				cacheWriteReadRatio: 12.5,
				minimumSavingTokens: 20_000,
				requestsSinceCompaction: 7,
				economics: { ...DEFAULT_COMPACTION_ECONOMICS, windowReserveTokens: 10_000 },
			}),
		).toMatchObject({ compact: true, reason: "window_protection" });
	});

	it("keeps the first long-session compact economic", () => {
		expect(
			decision({
				writeTokens: 126_659,
				archiveTokens: 103_945,
				memoTokens: 1_000,
				contextTokens: 126_659,
				completedBoundaryRequestCounts: [109],
				remainingBoundaries: 2,
				averageContextTokenIncrement: 2_177,
				contextWindowTokens: 272_000,
				priorCompactionCount: 0,
				cacheWriteReadRatio: 12.5,
				minimumSavingTokens: 20_000,
			}),
		).toMatchObject({ compact: true, reason: "economic" });
	});

	it("keeps an epoch-local mid-session compact economic after cooldown", () => {
		expect(
			decision({
				writeTokens: 59_850,
				archiveTokens: 37_136,
				memoTokens: 1_000,
				contextTokens: 59_850,
				completedBoundaryRequestCounts: [5, 13],
				remainingBoundaries: 5,
				averageContextTokenIncrement: 3_516,
				contextWindowTokens: 272_000,
				priorCompactionCount: 1,
				cacheWriteReadRatio: 12.5,
				minimumSavingTokens: 20_000,
				requestsSinceCompaction: 18,
			}),
		).toMatchObject({ compact: true, reason: "economic" });
	});

	it("defers a 40k wrap-up compact that still carries the previous debt", () => {
		expect(
			decision({
				writeTokens: 39_940,
				archiveTokens: 17_226,
				memoTokens: 6_154,
				contextTokens: 39_940,
				completedBoundaryRequestCounts: [4, 3],
				remainingBoundaries: 2,
				averageContextTokenIncrement: 2_749,
				contextWindowTokens: 272_000,
				priorCompactionCount: 6,
				carriedDebtTokens: 504_623,
				cacheWriteReadRatio: 12.5,
				minimumSavingTokens: 20_000,
				requestsSinceCompaction: 7,
			}),
		).toMatchObject({ compact: false, reason: "deferred_near_floor" });
	});

	it("defers a short follow-up task that only has epoch-local intervals", () => {
		expect(
			decision({
				writeTokens: 63_991,
				archiveTokens: 41_277,
				memoTokens: 7_590,
				contextTokens: 63_991,
				completedBoundaryRequestCounts: [8],
				remainingBoundaries: 2,
				averageContextTokenIncrement: 1_847,
				contextWindowTokens: 272_000,
				priorCompactionCount: 7,
				carriedDebtTokens: 4_982,
				cacheWriteReadRatio: 12.5,
				minimumSavingTokens: 20_000,
				requestsSinceCompaction: 28,
			}),
		).toMatchObject({ compact: false, reason: "deferred_economic" });
	});
});
