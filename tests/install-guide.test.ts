/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function rootFile(name: string): string {
	return readFileSync(join(process.cwd(), name), "utf8");
}

describe("agent installation instructions", () => {
	it("makes the canonical guide mandatory for Codex install and configuration work", () => {
		const instructions = rootFile("AGENTS.md");
		expect(instructions).toContain("agents-install.md");
		expect(instructions).toMatch(/read.+completely/is);
		expect(instructions).toMatch(/install|build|configur/i);
	});

	it("imports the same canonical guide for Claude Code", () => {
		const instructions = rootFile("CLAUDE.md");
		expect(instructions.split(/\r?\n/u)).toContain("@agents-install.md");
	});

	it("keeps the README pointed at the managed installation and configuration profile", () => {
		const readme = rootFile("README.md");
		expect(readme).toContain("[agent installation and configuration protocol](agents-install.md)");
		expect(readme).toContain("check-sol-pi-config.mjs --require-all-enabled");
	});

	it("defines a reproducible and all-enabled installation", () => {
		const guide = rootFile("agents-install.md");
		const requiredText = [
			"Node.js 22.19",
			"@earendil-works/pi-coding-agent@0.84.2",
			"npm ci --ignore-scripts",
			"npm run check",
			"npm audit",
			"pi install",
			'"actionFusion": true',
			'"observationPack": true',
			'"evidencePreservingReducer": true',
			'"evidencePreservingReducerProvider": "provider-id"',
			'"evidencePreservingReducerModel": "model-id"',
			'"onlineContextCompact": true',
			'"cacheWriteReadRatio": 12.5',
			"scripts/check-sol-pi-config.mjs",
			"pi list",
			"tests/all-mechanisms.test.ts",
		];

		for (const text of requiredText) expect(guide).toContain(text);
		expect(guide).toMatch(/do not (modify|patch|vendor).+upstream Pi/is);
		expect(guide).toMatch(/do not print.+secret/is);
	});

	it("documents one configured ratio and no active-model cost inference", () => {
		for (const name of [
			"README.md",
			"agents-install.md",
			"docs/configuration.md",
			"docs/compatibility.md",
		]) {
			const text = rootFile(name);
			expect(text, name).toContain("cacheWriteReadRatio");
			expect(text, name).not.toContain("Model.cost");
			expect(text, name).not.toContain("cache_read_price_per_million");
			expect(text, name).not.toContain("cache_write_price_per_million");
		}
	});
});
