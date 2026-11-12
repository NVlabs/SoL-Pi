/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { join } from "node:path";
import { atomicWrite, type WriteOutcome } from "../../atomic.ts";
import { type ReducerConfig, sha256 } from "./config.ts";

export interface ArchiveObject {
	readonly hash: string;
	readonly bytes: number;
	readonly chars: number;
	readonly lines: number;
	readonly path: string;
	readonly outcome: WriteOutcome;
}

/**
 * Archived logs live under SoL-Pi's session-derived runtime directory.
 */
export function archiveRoot(config: ReducerConfig): string {
	return config.storeRoot;
}

/**
 * Store the raw log under its own content hash.
 *
 * Every quote in a receipt is checked against this archive, and the receipt
 * points the frontier agent back at this path for exact readback. An existing
 * object with the same name but different bytes is an integrity failure, not a
 * cache hit.
 */
export async function archiveBody(
	root: string,
	body: string,
	options: { readonly repairMismatch?: boolean } = {},
): Promise<ArchiveObject> {
	const hash = sha256(body);
	const objectDir = join(root, "objects", hash.slice(0, 2));
	const path = join(objectDir, `${hash}.txt`);
	// Create atomically (temp + fsync + rename): a wall-killed attempt leaves
	// either no object or the complete one, never a truncated tail at a
	// content-addressed name. A mismatched object is an integrity signal:
	// refuse by default, repair only when the deployment opts in.
	const outcome = await atomicWrite(path, body, {
		mode: 0o600,
		expectedHash: hash,
		repairMismatch: options.repairMismatch === true,
	});
	return {
		hash,
		bytes: Buffer.byteLength(body, "utf8"),
		chars: body.length,
		lines: body.length === 0 ? 0 : body.split("\n").length,
		path,
		outcome,
	};
}
