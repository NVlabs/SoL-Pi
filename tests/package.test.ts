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

interface PackageManifest {
	peerDependencies: Record<string, string>;
}

const piPackages = [
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
];

function compareVersions(left: string, right: string): number {
	const leftParts = left.split(".").map(Number);
	const rightParts = right.split(".").map(Number);
	for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index++) {
		const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}

function documentedFloor(): string {
	const match = /the declared floor is (\d+\.\d+\.\d+)/u.exec(readFileSync("docs/compatibility.md", "utf8"));
	if (!match?.[1]) throw new Error("docs/compatibility.md declares no peer dependency floor");
	return match[1];
}

function declaredFloor(range: string): string {
	const match = /\d+\.\d+\.\d+/u.exec(range);
	if (!match) throw new Error(`Peer range declares no version floor: ${range}`);
	return match[0];
}

function packedFiles(): string[] {
	const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
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

describe("declared Pi compatibility", () => {
	function manifest(): PackageManifest {
		return JSON.parse(readFileSync("package.json", "utf8")) as PackageManifest;
	}

	function piPeerRanges(): string[] {
		const peers = manifest().peerDependencies;
		return piPackages.map((name) => {
			const range = peers[name];
			if (range === undefined) throw new Error(`Missing Pi peer dependency: ${name}`);
			return range;
		});
	}

	it("requires the documented Pi floor from every shared-release Pi package", () => {
		const ranges = piPeerRanges();
		const floor = documentedFloor();

		expect(new Set(ranges).size).toBe(1);
		for (const range of ranges) {
			expect(range).not.toBe("*");
			expect(declaredFloor(range), range).toBe(floor);
		}
	});

	it("keeps the lockfile root peers in step with the manifest", () => {
		const lockfile = JSON.parse(readFileSync("package-lock.json", "utf8")) as {
			packages: Record<string, Partial<PackageManifest>>;
		};
		const locked = piPackages.map((name) => lockfile.packages[""]?.peerDependencies?.[name]);

		expect(locked).toEqual(piPeerRanges());
	});

	it("excludes the Pi release that satisfies the range but cannot load SoL-Pi", () => {
		const incompatible = "0.79.10";
		for (const range of piPeerRanges()) {
			expect(compareVersions(declaredFloor(range), incompatible), range).toBeGreaterThan(0);
		}
	});
});
