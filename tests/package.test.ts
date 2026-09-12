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
	// child_process.spawnSync applies no PATHEXT resolution, and current
	// Node hardening can reject a direct `.cmd` spawn with EINVAL — so on
	// Windows run the static command line through cmd.exe instead (#16).
	// All arguments are literals; nothing here interpolates untrusted input.
	const command =
		process.platform === "win32"
			? { file: "cmd.exe", args: ["/d", "/s", "/c", "npm pack --dry-run --json"] }
			: { file: "npm", args: ["pack", "--dry-run", "--json"] };
	const result = spawnSync(command.file, command.args, {
		cwd: process.cwd(),
		encoding: "utf8",
	});
	if (result.status !== 0) throw new Error(result.stderr || result.stdout);
	const report = JSON.parse(result.stdout) as PackReport[];
	return report[0]?.files.map((file) => file.path) ?? [];
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
