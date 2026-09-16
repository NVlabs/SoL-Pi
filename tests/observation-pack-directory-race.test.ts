/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { createHash } from "node:crypto";
import type { Mode, PathLike } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
				await actual.symlink(race.externalDirectory, race.objectsDirectory, "dir");
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

import { ensureStored, type Observation } from "../src/sol-pi/extensions/observation-pack/observation.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
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

	await expect(ensureStored(observation)).rejects.toThrow(/observation directory|changed while open/iu);
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

	await expect(ensureStored(observation)).rejects.toThrow(/changed while open/u);
});
