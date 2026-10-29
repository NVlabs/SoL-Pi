/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { createHash } from "node:crypto";
import type { Mode, PathLike } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const race = vi.hoisted(() => ({
	armed: false,
	objectPath: "",
	objectsDirectory: "",
	backupDirectory: "",
	externalDirectory: "",
	opensBeforeSwap: 0,
	restoreDirectory: false,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		open: async (path: PathLike, flags: string | number, mode?: Mode) => {
			if (race.armed && String(path) === race.objectPath) {
				if (race.opensBeforeSwap > 0) {
					race.opensBeforeSwap -= 1;
					return actual.open(path, flags, mode);
				}
				race.armed = false;
				await actual.rename(race.objectsDirectory, race.backupDirectory);
				await actual.symlink(race.externalDirectory, race.objectsDirectory, process.platform === "win32" ? "junction" : "dir");
				const handle = await actual.open(path, flags, mode);
				if (race.restoreDirectory) {
					await actual.rm(race.objectsDirectory);
					await actual.rename(race.backupDirectory, race.objectsDirectory);
				}
				return handle;
			}
			return actual.open(path, flags, mode);
		},
	};
});

import { ensureStored, type Observation, readRecallChunk } from "../src/sol-pi/extensions/observation-pack/observation.ts";

const roots: string[] = [];

afterEach(async () => {
	race.armed = false;
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it.each(["sol-pi", "sol-pi/session-1"])("rejects a linked %s ancestor before creating storage", async (ancestor) => {
	const sessionRoot = await mkdtemp(join(tmpdir(), "observation-ancestor-session-"));
	const externalRoot = await mkdtemp(join(tmpdir(), "observation-ancestor-external-"));
	roots.push(sessionRoot, externalRoot);
	const linkPath = join(sessionRoot, ancestor);
	await mkdir(join(sessionRoot, "sol-pi"), { recursive: true });
	if (ancestor === "sol-pi") await rm(linkPath, { recursive: true });
	await symlink(externalRoot, linkPath, process.platform === "win32" ? "junction" : "dir");
	const text = "sensitive observation bytes";
	const id = "obs_0123456789abcdef01234567";
	const observation: Observation = {
		id,
		contentHash: createHash("sha256").update(text).digest("hex"),
		filePath: join(sessionRoot, "sol-pi", "session-1", "observation-pack", "objects", `${id}.txt`),
		toolName: "bash",
		text,
		bytes: Buffer.byteLength(text),
		lines: 1,
		tokens: 7,
	};
	await expect(ensureStored(observation, sessionRoot)).rejects.toThrow(/directory/iu);
	expect(await readdir(externalRoot)).toEqual([]);
	const externalObjects = join(externalRoot, ancestor === "sol-pi" ? "session-1" : "", "observation-pack", "objects");
	await mkdir(externalObjects, { recursive: true });
	await writeFile(join(externalObjects, `${id}.txt`), text);
	await expect(ensureStored(observation, sessionRoot)).rejects.toThrow(/directory/iu);
	await expect(readRecallChunk(observation.filePath, 0, { maxBytes: 100, maxLines: 10 }, sessionRoot))
		.rejects.toThrow(/directory/iu);
});

it("revalidates the runtime-root ancestor after opening an object", async () => {
	const sessionRoot = await mkdtemp(join(tmpdir(), "observation-ancestor-race-"));
	const externalRoot = await mkdtemp(join(tmpdir(), "observation-ancestor-external-"));
	roots.push(sessionRoot, externalRoot);
	const runtimeRoot = join(sessionRoot, "sol-pi", "session-1");
	const text = "sensitive observation bytes";
	const id = "obs_0123456789abcdef01234567";
	await mkdir(join(externalRoot, "observation-pack", "objects"), { recursive: true });
	const filePath = join(runtimeRoot, "observation-pack", "objects", `${id}.txt`);
	Object.assign(race, {
		armed: true,
		objectPath: filePath,
		objectsDirectory: runtimeRoot,
		backupDirectory: `${runtimeRoot}.original`,
		externalDirectory: externalRoot,
		opensBeforeSwap: 0,
		restoreDirectory: false,
	});
	await expect(ensureStored({
		id, filePath, text, toolName: "bash", bytes: Buffer.byteLength(text), lines: 1, tokens: 7,
		contentHash: createHash("sha256").update(text).digest("hex"),
	}, sessionRoot)).rejects.toThrow(/directory/iu);
	await expect(readFile(join(externalRoot, "observation-pack", "objects", `${id}.txt`), "utf8")).resolves.toBe("");
});

it("does not write observation bytes through a replaced objects directory", async () => {
	const runtimeRoot = await mkdtemp(join(tmpdir(), "observation-race-runtime-"));
	const externalRoot = await mkdtemp(join(tmpdir(), "observation-race-external-"));
	roots.push(runtimeRoot, externalRoot);

	const text = "sensitive observation bytes";
	const id = "obs_0123456789abcdef01234567";
	const objectsDirectory = join(runtimeRoot, "observation-pack", "objects");
	const objectPath = join(objectsDirectory, `${id}.txt`);
	race.armed = true;
	race.objectPath = objectPath;
	race.objectsDirectory = objectsDirectory;
	race.backupDirectory = `${objectsDirectory}.original`;
	race.externalDirectory = externalRoot;
	race.opensBeforeSwap = 0;
	race.restoreDirectory = false;

	const observation: Observation = {
		id,
		contentHash: createHash("sha256").update(text).digest("hex"),
		filePath: objectPath,
		toolName: "bash",
		text,
		bytes: Buffer.byteLength(text),
		lines: 1,
		tokens: 7,
	};

	await expect(ensureStored(observation, runtimeRoot)).rejects.toThrow(/observation directory|changed while open/iu);
	await expect(readFile(join(externalRoot, `${id}.txt`), "utf8")).resolves.not.toContain(text);
});

it("rejects an opened object when its pathname is restored to a different file", async () => {
	const runtimeRoot = await mkdtemp(join(tmpdir(), "observation-race-runtime-"));
	const externalRoot = await mkdtemp(join(tmpdir(), "observation-race-external-"));
	roots.push(runtimeRoot, externalRoot);

	const text = "expected observation bytes";
	const id = "obs_89abcdef0123456789abcdef";
	const objectsDirectory = join(runtimeRoot, "observation-pack", "objects");
	const objectPath = join(objectsDirectory, `${id}.txt`);
	await mkdir(objectsDirectory, { recursive: true });
	await writeFile(objectPath, text);
	await writeFile(join(externalRoot, `${id}.txt`), text);

	race.armed = true;
	race.objectPath = objectPath;
	race.objectsDirectory = objectsDirectory;
	race.backupDirectory = `${objectsDirectory}.original`;
	race.externalDirectory = externalRoot;
	race.opensBeforeSwap = 1;
	race.restoreDirectory = true;

	const observation: Observation = {
		id,
		contentHash: createHash("sha256").update(text).digest("hex"),
		filePath: objectPath,
		toolName: "bash",
		text,
		bytes: Buffer.byteLength(text),
		lines: 1,
		tokens: 7,
	};

	await expect(ensureStored(observation, runtimeRoot)).rejects.toThrow(/changed while open/u);
});
