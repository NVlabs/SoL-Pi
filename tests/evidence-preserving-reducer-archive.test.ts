/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { archiveBody } from "../src/sol-pi/extensions/evidence-preserving-reducer/archive.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function archiveRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "reducer-archive-test-"));
	roots.push(root);
	return root;
}

describe("reducer archive integrity", () => {
	it.each(["", "ERROR build failed\n", "错误：构建失败 🧪 \uFFFD\n"])(
		"reuses an unchanged archive for %j",
		async (body) => {
			const root = await archiveRoot();
			const original = await archiveBody(root, body);

			expect(await archiveBody(root, body)).toEqual(original);
			const bytes = await readFile(original.path);
			expect(bytes).toEqual(Buffer.from(body, "utf8"));
			expect(createHash("sha256").update(bytes).digest("hex")).toBe(original.hash);
		},
	);

	it("rejects changed text without overwriting the existing object", async () => {
		const root = await archiveRoot();
		const body = "ERROR original diagnostic\n";
		const archive = await archiveBody(root, body);
		const damaged = Buffer.from("ERROR modified diagnostic\n");
		await writeFile(archive.path, damaged);

		await expect(archiveBody(root, body)).rejects.toThrow("Reducer archive integrity failure:");
		expect(await readFile(archive.path)).toEqual(damaged);
	});

	it("rejects changed bytes even when UTF-8 replacement decoding preserves the text", async () => {
		const root = await archiveRoot();
		const prefix = "diagnostic line\n".repeat(400) + "ERROR result: ";
		const body = `${prefix}\uFFFD`;
		const archive = await archiveBody(root, body);
		// An incomplete four-byte sequence decodes to the same U+FFFD as EF BF BD.
		const damaged = Buffer.concat([Buffer.from(prefix), Buffer.from([0xf0, 0x9f, 0x92])]);
		expect(damaged.length).toBe(archive.bytes);
		expect(damaged.toString("utf8")).toBe(body);
		expect(createHash("sha256").update(damaged).digest("hex")).not.toBe(archive.hash);
		await writeFile(archive.path, damaged);

		await expect(archiveBody(root, body)).rejects.toThrow("Reducer archive integrity failure:");
		expect(await readFile(archive.path)).toEqual(damaged);
	});
});
