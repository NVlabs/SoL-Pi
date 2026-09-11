/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import type { ProviderResult } from "./provider.ts";

/** Only accepted receipts enter this bounded, session-local LRU cache. */
export class ReceiptCache {
	private readonly entries = new Map<string, ProviderResult>();

	constructor(private readonly capacity = 64) {}

	get(key: string): ProviderResult | undefined {
		const value = this.entries.get(key);
		if (!value) return undefined;
		this.entries.delete(key);
		this.entries.set(key, value);
		// Reuse the evidence, not the usage charged for the original request.
		return {
			...value,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
		};
	}

	set(key: string, value: ProviderResult): void {
		this.entries.delete(key);
		this.entries.set(key, value);
		if (this.entries.size > this.capacity) {
			const oldest = this.entries.keys().next().value;
			if (oldest !== undefined) this.entries.delete(oldest);
		}
	}

	delete(key: string): void {
		this.entries.delete(key);
	}
}
