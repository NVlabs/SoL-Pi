/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { constants } from "node:fs";
import { mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertNotSymlink } from "../src/sol-pi/extensions/observation-pack/observation.ts";

// Stub only lstat; every other fs/promises export passes through untouched.
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return { ...actual, lstat: vi.fn(actual.lstat) };
});

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratchRoot(): Promise<string> {
	const value = await mkdtemp(join(tmpdir(), "observation-symlink-guard-test-"));
	roots.push(value);
	return value;
}

describe("assertNotSymlink (Windows O_NOFOLLOW fallback, #16)", () => {
	it("rejects a symlink with ELOOP", async () => {
		const root = await scratchRoot();
		const target = join(root, "target.txt");
		const link = join(root, "link.txt");
		await writeFile(target, "target bytes must not be recalled");
		await symlink(target, link);

		await expect(assertNotSymlink(link)).rejects.toMatchObject({ code: "ELOOP" });
	});

	it("resolves for a regular file", async () => {
		const root = await scratchRoot();
		const path = join(root, "regular.txt");
		await writeFile(path, "ordinary bytes");

		await expect(assertNotSymlink(path)).resolves.toBeUndefined();
	});

	it("resolves for an absent path so open() still reports ENOENT itself", async () => {
		const root = await scratchRoot();

		await expect(assertNotSymlink(join(root, "absent.txt"))).resolves.toBeUndefined();
	});

	it("rethrows non-ENOENT lstat failures instead of swallowing them", async () => {
		const { lstat } = await import("node:fs/promises");
		vi.mocked(lstat).mockRejectedValueOnce(
			Object.assign(new Error("permission denied"), { code: "EACCES" }),
		);

		await expect(assertNotSymlink(join("anywhere", "file.txt"))).rejects.toMatchObject({
			code: "EACCES",
		});
	});

	// A directory at an observation path keeps failing through the callers'
	// existing error paths (EISDIR from open, or the fstat isFile checks) —
	// the fallback is symlink-specific, not a regular-file validator (#16).
	it.runIf(constants.O_NOFOLLOW !== undefined)(
		"POSIX open() refuses symlinks atomically without the fallback",
		async () => {
			const root = await scratchRoot();
			const target = join(root, "target.txt");
			const link = join(root, "link.txt");
			await writeFile(target, "bytes");
			await symlink(target, link);

			await expect(
				open(link, constants.O_RDONLY | (constants.O_NOFOLLOW as number)),
			).rejects.toMatchObject({ code: "ELOOP" });
		},
	);
});
