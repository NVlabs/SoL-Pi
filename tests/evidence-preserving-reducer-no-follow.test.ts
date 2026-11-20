/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import type * as NodeFs from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof NodeFs>();
	return { ...actual, constants: { ...actual.constants, O_NOFOLLOW: 0 } };
});

import { archiveBody } from "../src/sol-pi/extensions/evidence-preserving-reducer/archive.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("fails closed on archive reuse without atomic no-follow support", async () => {
	const root = await mkdtemp(join(tmpdir(), "reducer-no-follow-"));
	roots.push(root);
	const body = "ERROR diagnostic output\n";
	const archived = await archiveBody(root, body);

	await expect(archiveBody(root, body)).rejects.toThrow();
	expect(await readFile(archived.path, "utf8")).toBe(body);
});
