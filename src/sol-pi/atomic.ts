/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

/**
 * Atomic content-addressed writes.
 *
 * The store is a durable, multi-process surface (a wall-killed attempt, a
 * concurrent review of the same repository). The former writers used `wx`
 * exclusive-create: a truncated file left by a kill is then a permanent
 * dedup failure — the object name is derived from the payload, so a partial
 * write can never be overwritten. Two properties are needed:
 *
 *  1. a create is atomic — a temp file in the destination directory, fsync,
 *     rename; a kill leaves either the previous state or the complete object;
 *  2. a mismatched existing object is an integrity signal: refuse loudly by
 *     default, repair when the deployment opts in (a torn tail from a killed
 *     writer is the expected mismatch shape; a payload mismatch is a defect).
 */

import { constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

export type WriteOutcome = "created" | "reused" | "repaired";

export interface AtomicWriteOptions {
	readonly mode?: number;
	/** Repair a mismatched existing object instead of refusing (default false). */
	readonly repairMismatch?: boolean;
	/** Expected sha256 of the payload; mismatched stored bytes are an integrity failure. */
	readonly expectedHash?: string;
}

const DEFAULT_MODE = 0o600;

function sha256(value: Buffer | string): string {
	return createHash("sha256").update(value).digest("hex");
}

/** Directory must be a real directory — a symlink is refused (the mount is the trust edge). */
export async function ensureDirectory(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	const stats = await lstat(path);
	if (!stats.isDirectory() || stats.isSymbolicLink()) {
		throw new Error(`not a regular directory: ${path}`);
	}
}

/**
 * Write `payload` to `path` atomically, verifying or repairing an existing object.
 */
export async function atomicWrite(path: string, payload: string, options: AtomicWriteOptions = {}): Promise<WriteOutcome> {
	const mode = options.mode ?? DEFAULT_MODE;
	const directory = dirname(path);
	await ensureDirectory(directory);

	const expected = options.expectedHash ?? sha256(payload);

	let existing: string | undefined;
	try {
		const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const stats = await handle.stat();
			if (!stats.isFile()) {
				throw new Error(`not a regular file: ${path}`);
			}
			existing = await handle.readFile({ encoding: "utf8" });
		} finally {
			await handle.close();
		}
	} catch (error) {
		const code = error instanceof Error && "code" in error ? (error as { code: string }).code : undefined;
		if (code === "ENOENT") {
			// absent: create below
		} else if (code === "ELOOP") {
			// a symlinked target: O_NOFOLLOW refuses it; name the cause loudly
			throw new Error(`not a regular file (symlink target): ${path}`);
		} else {
			throw error;
		}
	}

	if (existing !== undefined) {
		const existingHash = sha256(existing);
		if (existingHash === expected && existing === payload) return "reused";
		if (existingHash === expected) {
			// Same content hash, different bytes: impossible for a real sha256 match.
			throw new Error(`Atomic write integrity failure (hash collision shape): ${path}`);
		}
		if (!options.repairMismatch) {
			throw new Error(`Atomic write integrity failure: ${path} holds a different payload`);
		}
		// Repair: replace the mismatched object atomically.
		await writeTempAndRename(path, payload, mode);
		return "repaired";
	}

	await writeTempAndRename(path, payload, mode);
	return "created";
}

async function writeTempAndRename(path: string, payload: string, mode: number): Promise<void> {
	const directory = dirname(path);
	const temp = join(directory, `.sol-pi-tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	let handle: FileHandle | undefined;
	let wrote = false;
	try {
		handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
		wrote = true;
		await handle.writeFile(payload, { encoding: "utf8" });
		await handle.sync();
		await handle.close();
		handle = undefined;
		await rename(temp, path);
	} finally {
		if (handle) {
			try {
				await handle.close();
			} catch {
				// closing a failed handle is best-effort; the cleanup below is the contract
			}
		}
		if (wrote) {
			// A rename already moved the temp away; unlink only when the rename failed.
			try {
				await unlink(temp);
			} catch {
				// ENOENT after a successful rename is expected
			}
		}
	}
}

/** Read an object with symlink refusal, for recall paths and integrity checks. */
export async function readObject(path: string): Promise<string> {
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stats = await handle.stat();
		if (!stats.isFile()) throw new Error(`Store object is not a regular file: ${path}`);
		return await handle.readFile({ encoding: "utf8" });
	} finally {
		await handle.close();
	}
}

export async function objectExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
		throw error;
	}
}
