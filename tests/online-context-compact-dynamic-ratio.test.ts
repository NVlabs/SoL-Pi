/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { describe, expect, it } from "vitest";
import { resolveModelCacheWriteReadRatio } from "../src/sol-pi/extensions/online-context-compact/extension.ts";

describe("Dynamic Model Cache Ratio Resolver", () => {
	it("resolves ratio from cacheWrite and cacheRead when both exist", () => {
		// Claude Sonnet style pricing: $3.75 write / $0.30 read = 12.5
		const claude = { cost: { cacheWrite: 3.75, cacheRead: 0.3 } };
		expect(resolveModelCacheWriteReadRatio(claude, 4.25)).toBeCloseTo(12.5, 4);

		// Gemini Flash style pricing: $0.15 write / $0.0375 read = 4.0
		const gemini = { cost: { cacheWrite: 0.15, cacheRead: 0.0375 } };
		expect(resolveModelCacheWriteReadRatio(gemini, 4.25)).toBeCloseTo(4.0, 4);
	});

	it("falls back to input price when cacheWrite is undefined", () => {
		// Beam 1.0 style pricing: input $0.30, cacheRead $0.04 = 7.5
		const beam = { cost: { input: 0.3, cacheRead: 0.04 } };
		expect(resolveModelCacheWriteReadRatio(beam, 4.25)).toBeCloseTo(7.5, 4);

		// DeepSeek V3 style pricing: input $0.256, cacheRead $0.07 ≈ 3.657
		const deepseek = { cost: { input: 0.256, cacheRead: 0.07 } };
		expect(resolveModelCacheWriteReadRatio(deepseek, 4.25)).toBeCloseTo(3.6571, 3);
	});

	it("returns 1.0 for uncached models where cacheRead is 0", () => {
		// Model without prompt caching discount: ratio 1.0 (zero rewrite debt penalty)
		const uncached = { cost: { input: 1.0, cacheRead: 0 } };
		expect(resolveModelCacheWriteReadRatio(uncached, 4.25)).toBe(1.0);
	});

	it("returns fallback ratio when model or cost is missing or invalid", () => {
		expect(resolveModelCacheWriteReadRatio(undefined, 4.25)).toBe(4.25);
		expect(resolveModelCacheWriteReadRatio({}, 4.25)).toBe(4.25);
		expect(resolveModelCacheWriteReadRatio({ cost: {} }, 4.25)).toBe(4.25);
		expect(resolveModelCacheWriteReadRatio({ cost: { input: 0 } }, 4.25)).toBe(4.25);
	});

	it("preserves null fallback ratio when configured as null", () => {
		expect(resolveModelCacheWriteReadRatio(undefined, null)).toBeNull();
		expect(resolveModelCacheWriteReadRatio({}, null)).toBeNull();
	});
});
