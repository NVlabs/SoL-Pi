/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Append-only JSONL record of what the mechanism did on each provider request.
 *
 * The caller derives the ledger path from the active Pi session.
 */
export type Ledger = (entry: Record<string, unknown>) => Promise<void>;

export function createLedger(path: string): Ledger {
	return async (entry) => {
		await mkdir(dirname(path), { recursive: true });
		await appendFile(path, `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`, "utf8");
	};
}
