/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const queueTails = new Map<string, Promise<void>>();
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/gu;
const WINDOWS_SHELL_DRIVE = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i;

function normalizeToolPath(filePath: string): string {
	const normalized = filePath.replace(UNICODE_SPACES, " ");
	return normalized.startsWith("@") ? normalized.slice(1) : normalized;
}

/**
 * Git Bash, MSYS, Cygwin, and WSL hand Pi paths like `/c/src/app.ts`. On
 * Windows, Pi's built-in mutation tools convert those to a native drive path
 * before touching the filesystem, so the queue and hash guard must convert them
 * the same way or they address a file the mutation never wrote.
 */
export function normalizeWindowsShellPath(filePath: string): string {
	if (process.platform !== "win32") return filePath;
	if (!filePath.startsWith("/") || filePath.startsWith("//") || filePath.includes("\\")) return filePath;
	const match = WINDOWS_SHELL_DRIVE.exec(filePath);
	if (!match?.[1]) return filePath;
	return `${match[1].toUpperCase()}:\\${match[2]?.replaceAll("/", "\\") ?? ""}`;
}

export function resolveToolPath(cwd: string, filePath: string): string {
	const stripped = normalizeWindowsShellPath(normalizeToolPath(filePath));
	// Pi accepts file URLs; the queue and hash guard must use the same target.
	const expanded = stripped.startsWith("file://") ? fileURLToPath(stripped) : stripped;
	if (expanded === "~") return homedir();
	if (expanded.startsWith("~/") || (process.platform === "win32" && expanded.startsWith("~\\"))) {
		return resolve(homedir(), expanded.slice(2));
	}
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
