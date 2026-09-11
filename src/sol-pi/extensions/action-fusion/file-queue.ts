/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const queueTails = new Map<string, Promise<void>>();

function stripToolPathPrefix(filePath: string): string {
	return filePath.startsWith("@") ? filePath.slice(1) : filePath;
}

export function resolveToolPath(cwd: string, filePath: string): string {
	const stripped = stripToolPathPrefix(filePath);
	// Pi accepts file URLs; the queue and hash guard must use the same target.
	const expanded = stripped.startsWith("file://") ? fileURLToPath(stripped) : stripped;
	if (expanded === "~") return homedir();
	if (expanded.startsWith("~/")) return resolve(homedir(), expanded.slice(2));
	return resolve(cwd, expanded);
}

function isMissingPathError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ENOTDIR")
	);
}

async function canonicalQueueKey(filePath: string): Promise<string> {
	const resolvedPath = resolve(filePath);
	let current = resolvedPath;
	const missingSegments: string[] = [];

	while (true) {
		try {
			return resolve(await realpath(current), ...missingSegments);
		} catch (error) {
			if (!isMissingPathError(error)) throw error;
			const parent = dirname(current);
			if (parent === current) return resolvedPath;
			missingSegments.unshift(basename(current));
			current = parent;
		}
	}
}

/**
 * Serialize fused operations for one canonical file path. This queue belongs
 * to SoL-Pi and intentionally does not nest Pi's built-in mutation queue.
 */
export async function withFusedFileQueue<T>(filePath: string, work: () => Promise<T>): Promise<T> {
	const key = await canonicalQueueKey(filePath);
	const previous = queueTails.get(key) ?? Promise.resolve();
	let release!: () => void;
	const owned = new Promise<void>((resolveOwned) => {
		release = resolveOwned;
	});
	const tail = previous.then(() => owned);
	queueTails.set(key, tail);

	await previous;
	try {
		return await work();
	} finally {
		release();
		if (queueTails.get(key) === tail) queueTails.delete(key);
	}
}
