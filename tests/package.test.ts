/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface PackReport {
	files: Array<{ path: string }>;
}

function packedFiles(): string[] {
	const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
	const result = spawnSync(npmCommand, ["pack", "--dry-run", "--json"], {
		cwd: process.cwd(),
		encoding: "utf8",
	});
	if (result.status !== 0) throw new Error(result.stderr || result.stdout);
	// npm >= 12 reports a single object keyed by package name; earlier npm
	// versions reported an array of per-package objects.
	const report = JSON.parse(result.stdout) as PackReport[] | Record<string, PackReport>;
	const packages = Array.isArray(report) ? report : Object.values(report);
	return packages.flatMap((pkg) => pkg.files.map((file) => file.path));
}

describe("published package", () => {
	it("ships the default cache write/read ratio in the example config", () => {
		const config = JSON.parse(readFileSync("sol-pi.example.json", "utf8")) as Record<string, unknown>;
		expect(config.cacheWriteReadRatio).toBe(12.5);
		expect(config.evidencePreservingReducerProvider).toBe("provider-id");
		expect(config.evidencePreservingReducerModel).toBe("model-id");
	});

	it("contains the standalone entrypoint and no Pi monorepo source", () => {
		const files = packedFiles();
		expect(files).toContain("src/sol-pi/index.ts");
		expect(files).toContain("sol-pi.example.json");
		expect(files.some((file) => file.startsWith("packages/"))).toBe(false);
		expect(files.some((file) => file.startsWith("docs/superpowers/"))).toBe(false);
	});

	it("ships Online Context Compact from the standalone source tree", () => {
		const files = packedFiles();
		expect(files).toContain("src/sol-pi/extensions/online-context-compact/index.ts");
		expect(files).toContain("scripts/check-sol-pi-config.mjs");
		expect(files).toContain("agents-install.md");
		expect(files).not.toContain("AGENTS.md");
		expect(files).not.toContain("CLAUDE.md");
	});
});
