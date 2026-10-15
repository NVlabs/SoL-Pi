/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Append-only JSONL record of what the mechanism did on each provider request.
 *
 * The caller derives the ledger path from the active Pi session. One call uses
 * one appendFile operation, which is not transactional and may partially write
 * before rejecting.
 */
export type Ledger = (entries: readonly Record<string, unknown>[]) => Promise<void>;

export function createLedger(path: string): Ledger {
	return async (entries) => {
		if (entries.length === 0) return;
		await mkdir(dirname(path), { recursive: true });
		const records = entries.map((entry) => JSON.stringify({ timestamp: new Date().toISOString(), ...entry })).join("\n");
		await appendFile(path, `${records}\n`, "utf8");
	};
}
