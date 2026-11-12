/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { atomicWrite, objectExists, readObject } from "../src/sol-pi/atomic.ts";
import { archiveBody } from "../src/sol-pi/extensions/evidence-preserving-reducer/archive.ts";
import { ensureStored, hash, type Observation } from "../src/sol-pi/extensions/observation-pack/observation.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function storeRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "sol-pi-atomic-"));
	roots.push(root);
	return root;
}

function observationFixture(root: string, text: string): Observation {
	const id = "obs_0123456789abcdef01234567";
	return {
		id,
		contentHash: hash(text),
		filePath: join(root, "observation-pack", "objects", `${id}.txt`),
		toolName: "bash",
		text,
		bytes: Buffer.byteLength(text, "utf8"),
		lines: 1,
		tokens: 2,
	};
}

describe("SoL-Pi atomic writes", () => {
	it("creates an object and reports created", async () => {
		const root = storeRoot();
		const path = join(root, "objects", "ab", "payload.txt");
		expect(await atomicWrite(path, "hello")).toBe("created");
		expect(await readObject(path)).toBe("hello");
	});

	it("reuses an identical object without rewriting", async () => {
		const root = storeRoot();
		const path = join(root, "objects", "ab", "payload.txt");
		await atomicWrite(path, "hello");
		expect(await atomicWrite(path, "hello")).toBe("reused");
	});

	it("refuses a mismatched object by default (integrity signal, not a cache hit)", async () => {
		const root = storeRoot();
		const path = join(root, "objects", "ab", "payload.txt");
		await atomicWrite(path, "complete");
		writeFileSync(path, "truncated");
		await expect(atomicWrite(path, "complete")).rejects.toThrow(/holds a different payload/u);
	});

	it("repairs a torn object when repairMismatch is opted in", async () => {
		const root = storeRoot();
		const path = join(root, "objects", "ab", "payload.txt");
		await atomicWrite(path, "complete");
		writeFileSync(path, "truncated");
		expect(await atomicWrite(path, "complete", { repairMismatch: true })).toBe("repaired");
		expect(await readObject(path)).toBe("complete");
	});

	it("leaves no temp file behind after a create or a repair", async () => {
		const root = storeRoot();
		const path = join(root, "objects", "ab", "payload.txt");
		await atomicWrite(path, "a");
		writeFileSync(path, "b");
		await atomicWrite(path, "a", { repairMismatch: true });
		const names = readdirSync(join(root, "objects", "ab"));
		expect(names.filter((name) => name.startsWith(".sol-pi-tmp-"))).toHaveLength(0);
		expect(names).toEqual(["payload.txt"]);
	});

	it("refuses a directory that is a symlink (the mount is the trust edge)", async () => {
		const root = storeRoot();
		const realDir = join(root, "real");
		mkdirSync(realDir, { recursive: true });
		const linkDir = join(root, "linked");
		(await import("node:fs")).symlinkSync(realDir, linkDir);
		await expect(atomicWrite(join(linkDir, "payload.txt"), "a")).rejects.toThrow(/not a regular directory/u);
	});

	it("refuses a symlinked target file", async () => {
		const root = storeRoot();
		const dir = join(root, "objects", "ab");
		mkdirSync(dir, { recursive: true });
		const realFile = join(root, "real.txt");
		writeFileSync(realFile, "secret");
		(await import("node:fs")).symlinkSync(realFile, join(dir, "payload.txt"));
		await expect(atomicWrite(join(dir, "payload.txt"), "a")).rejects.toThrow(/not a regular file \(symlink target\)/u);
	});

	it("writes mode 0600 on created objects", async () => {
		if (process.platform === "win32") return;
		const root = storeRoot();
		const path = join(root, "objects", "ab", "payload.txt");
		await atomicWrite(path, "hello");
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("archiveBody names the object by the payload hash and returns the outcome", async () => {
		const root = storeRoot();
		const object = await archiveBody(root, "diagnostic\npayload\n");
		expect(object.outcome).toBe("created");
		expect(object.path.endsWith(`${object.hash}.txt`)).toBe(true);
		expect(await readObject(object.path)).toBe("diagnostic\npayload\n");
	});

	it("archiveBody refuses a torn archive; repair opts through", async () => {
		const root = storeRoot();
		const body = "diagnostic\npayload\n";
		const object = await archiveBody(root, body);
		writeFileSync(object.path, "diagnostic\n");
		await expect(archiveBody(root, body)).rejects.toThrow(/different payload/u);
		const repaired = await archiveBody(root, body, { repairMismatch: true });
		expect(repaired.outcome).toBe("repaired");
		expect(await objectExists(object.path)).toBe(true);
		expect(readFileSync(object.path, "utf8")).toBe(body);
	});

	it("ensureStored refuses a size-equal but hash-mismatched object", async () => {
		const root = storeRoot();
		const text = "payload";
		const observation = observationFixture(root, text);
		mkdirSync(join(root, "observation-pack", "objects"), { recursive: true });
		writeFileSync(observation.filePath, "x".repeat(Buffer.byteLength(text, "utf8")));
		await expect(ensureStored(observation)).rejects.toThrow(/hash mismatch/u);
	});

	it("ensureStored repairs a torn object when opted in", async () => {
		const root = storeRoot();
		const text = "payload";
		const observation = observationFixture(root, text);
		mkdirSync(join(root, "observation-pack", "objects"), { recursive: true });
		writeFileSync(observation.filePath, "pa");
		await ensureStored(observation, { repairMismatch: true });
		expect(await readObject(observation.filePath)).toBe(text);
	});

	it("ensureStored reuses an identical object", async () => {
		const root = storeRoot();
		const observation = observationFixture(root, "payload");
		await ensureStored(observation);
		await ensureStored(observation);
		expect(await readObject(observation.filePath)).toBe("payload");
	});
});
