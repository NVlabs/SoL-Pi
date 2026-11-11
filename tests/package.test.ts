/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
		timeout: 25_000,
		// Windows resolves `npm` through npm.cmd, which Node only spawns through a shell.
		shell: process.platform === "win32",
	});
	if (result.status !== 0) throw new Error(result.stderr || result.stdout);
	const report = JSON.parse(result.stdout) as PackReport[];
	return report[0]?.files.map((file) => file.path) ?? [];
}

describe("published package", () => {
	let files: string[];
	beforeAll(() => {
		files = packedFiles();
	}, 30_000);

	it("ships the default cache write/read ratio in the example config", () => {
		const config = JSON.parse(readFileSync("sol-pi.example.json", "utf8")) as Record<string, unknown>;
		expect(config.cacheWriteReadRatio).toBe(12.5);
		expect(config.evidencePreservingReducerProvider).toBe("provider-id");
		expect(config.evidencePreservingReducerModel).toBe("model-id");
	});

	it("contains the standalone entrypoint and no Pi monorepo source", () => {
		expect(files).toContain("src/sol-pi/index.ts");
		expect(files).toContain("sol-pi.example.json");
		expect(files.some((file) => file.startsWith("packages/"))).toBe(false);
		expect(files.some((file) => file.startsWith("docs/superpowers/"))).toBe(false);
	});

	it("ships Online Context Compact from the standalone source tree", () => {
		expect(files).toContain("src/sol-pi/extensions/online-context-compact/index.ts");
		expect(files).toContain("scripts/check-sol-pi-config.mjs");
		expect(files).toContain("agents-install.md");
		expect(files).not.toContain("AGENTS.md");
		expect(files).not.toContain("CLAUDE.md");
	});
});

function runScript(script: string, args: string[]): { status: number | null; output: string } {
	const result = spawnSync(process.execPath, [script, ...args], { cwd: process.cwd(), encoding: "utf8" });
	return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function checkPiCompat(...args: string[]): { status: number | null; output: string } {
	return runScript("scripts/check-pi-compat.mjs", args);
}

// Every check starts a Node process that loads Pi; on slow shared file systems that takes longer than
// Vitest's 5 s default.
describe("Pi compatibility check", { timeout: 30_000 }, () => {
	const baseline = checkPiCompat();
	const detected = /^Pi: @earendil-works\/pi-coding-agent@(\S+) \((.+)\)$/m.exec(baseline.output);
	const roots: string[] = [];

	afterAll(() => {
		for (const root of roots) rmSync(root, { recursive: true, force: true });
	});

	function realPiDir(): string {
		const [, , realDir] = detected ?? [];
		if (!realDir) throw new Error(baseline.output);
		return realDir;
	}

	/** The installed Pi version, so a fake Pi with the real exports passes the VERSION check. */
	function realVersion(): string {
		const [, version] = detected ?? [];
		if (!version) throw new Error(baseline.output);
		return version;
	}

	function tempRoot(): string {
		const root = mkdtempSync(join(tmpdir(), "sol-pi-compat-"));
		roots.push(root);
		return root;
	}

	/**
	 * A Pi install whose pi-coding-agent claims `version` and re-exports `exports` from the real one.
	 * `body` is appended to its entry module; set `exports` to "" to replace the module entirely.
	 */
	function fakePi(version: string, exports: string, body = ""): string {
		const realDir = realPiDir();
		const root = tempRoot();
		const scope = join(root, "node_modules", "@earendil-works");
		const piDir = join(scope, "pi-coding-agent");
		mkdirSync(join(piDir, "dist"), { recursive: true });
		for (const sibling of ["pi-ai", "pi-tui"]) {
			symlinkSync(join(dirname(realDir), sibling), join(scope, sibling), "dir");
		}
		const realIndex = pathToFileURL(join(realDir, "dist", "index.js")).href;
		const manifest = {
			name: "@earendil-works/pi-coding-agent",
			version,
			type: "module",
			exports: { ".": { import: "./dist/index.js" } },
		};
		writeFileSync(join(piDir, "package.json"), JSON.stringify(manifest));
		const reexport = exports ? `export ${exports} from ${JSON.stringify(realIndex)};\n` : "";
		writeFileSync(join(piDir, "dist", "index.js"), `${reexport}${body}\n`);
		return root;
	}

	/** A SoL-Pi checkout with only the compat script, the given src/ files, and the real node_modules. */
	function fakeCheckout(sources: Record<string, string>): string {
		const root = tempRoot();
		mkdirSync(join(root, "scripts"));
		mkdirSync(join(root, "src"));
		copyFileSync("scripts/check-pi-compat.mjs", join(root, "scripts", "check-pi-compat.mjs"));
		for (const [name, source] of Object.entries(sources)) writeFileSync(join(root, "src", name), source);
		symlinkSync(dirname(dirname(realPiDir())), join(root, "node_modules"), "dir");
		return join(root, "scripts", "check-pi-compat.mjs");
	}

	it("passes on the installed Pi and reports its version, bash exit mode, and codemode availability", async () => {
		expect(baseline.status, baseline.output).toBe(0);
		const [, version, realDir] = detected ?? [];
		expect(version).toBeDefined();
		const pi = (await import("@earendil-works/pi-coding-agent")) as Record<string, unknown>;
		expect(pi.VERSION).toBe(version);
		expect(baseline.output).toContain("Pi compatibility: OK");
		expect(baseline.output).not.toContain("WARN:");
		const bash = (pi.createBashToolDefinition as (cwd: string) => { outputSchema?: unknown })(process.cwd());
		// Pi >= 0.99 returns isError with structuredContent for non-zero exits; older Pi throws.
		expect(baseline.output).toMatch(
			bash.outputSchema === undefined
				? /^bash non-zero exit: throws \(Pi <= 0\.98 behaviour\): Command exited with code 3$/m
				: /^bash non-zero exit: returns isError result/m,
		);
		expect(baseline.output).toContain(
			typeof pi.createCodemodeExtension === "function" ? "codemode: available" : "codemode: not available",
		);
		const explicit = checkPiCompat("--pi-root", realDir ?? "", "--strict");
		expect(explicit.status, explicit.output).toBe(0);
	});

	it("fails below the supported Pi floor", () => {
		const result = checkPiCompat("--pi-root", fakePi("0.80.0", "*"));
		expect(result.status, result.output).toBe(1);
		expect(result.output).toContain("Pi 0.80.0 is below the supported floor 0.84.2");
	});

	it("warns on untested Pi versions and fails them only under --strict", () => {
		const root = fakePi("9.0.0", "*");
		const relaxed = checkPiCompat("--pi-root", root);
		expect(relaxed.status, relaxed.output).toBe(0);
		expect(relaxed.output).toContain("WARN: Pi 9.0.0 is not in the tested set");
		const strict = checkPiCompat(`--pi-root=${root}`, "--strict");
		expect(strict.status, strict.output).toBe(1);
	});

	it("warns when Pi's internal packages come from another release", () => {
		// Pi before 1.3.0 depends on its internal packages with caret ranges, so a fresh install of
		// Pi 1.0.4 now gets pi-codemode 1.3.0 and fails to load.
		const version = realVersion();
		const root = fakePi(version, "*");
		const scope = join(root, "node_modules", "@earendil-works");
		const manifestPath = join(scope, "pi-coding-agent", "package.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
		writeFileSync(manifestPath, JSON.stringify({ ...manifest, dependencies: { "@earendil-works/pi-codemode": `^${version}` } }));
		mkdirSync(join(scope, "pi-codemode"));
		writeFileSync(join(scope, "pi-codemode", "package.json"), JSON.stringify({ name: "@earendil-works/pi-codemode", version: "99.0.0" }));
		const relaxed = checkPiCompat("--pi-root", root);
		expect(relaxed.status, relaxed.output).toBe(0);
		expect(relaxed.output).toContain(`WARN: Pi ${version} is installed with internal packages from other releases (pi-codemode 99.0.0)`);
		const strict = checkPiCompat("--pi-root", root, "--strict");
		expect(strict.status, strict.output).toBe(1);
	});

	it("fails when a Pi export SoL-Pi imports is missing", () => {
		const result = checkPiCompat("--pi-root", fakePi("1.0.4", "{ VERSION, CONFIG_DIR_NAME }"));
		expect(result.status, result.output).toBe(1);
		expect(result.output).toContain("Missing public Pi API: @earendil-works/pi-coding-agent getAgentDir");
		expect(result.output).toContain("Missing public Pi API: createBashToolDefinition");
	});

	it("checks only the Pi imports that survive TypeScript import elision", () => {
		const typeOnly = [
			'import { ExtensionAPI, getAgentDir, NotAPiType } from "@earendil-works/pi-coding-agent";',
			"export type Missing = NotAPiType;",
			"export const dir = (_pi: ExtensionAPI): string => getAgentDir();",
		].join("\n");
		const passing = runScript(fakeCheckout({ "type-only.ts": typeOnly }), ["--strict"]);
		expect(passing.status, passing.output).toBe(0);
		expect(passing.output).not.toContain("ExtensionAPI");
		expect(passing.output).not.toContain("NotAPiType");

		const valueUse = 'import { notAPiExport } from "@earendil-works/pi-coding-agent";\nexport const value = notAPiExport;';
		const failing = runScript(fakeCheckout({ "type-only.ts": typeOnly, "value.ts": valueUse }), []);
		expect(failing.status, failing.output).toBe(1);
		expect(failing.output).toContain("Missing public Pi API: @earendil-works/pi-coding-agent notAPiExport");
		expect(failing.output).not.toContain("ExtensionAPI");
	});

	it("reports the bash exit status line when bash throws on a non-zero exit", () => {
		const legacyBash = [
			"export function createBashToolDefinition() {",
			'\treturn { execute: async () => { throw new Error("out\\n\\nCommand exited with code 3"); } };',
			"}",
		].join("\n");
		const result = checkPiCompat("--pi-root", fakePi(realVersion(), "*", legacyBash), "--strict");
		expect(result.status, result.output).toBe(0);
		expect(result.output).toContain("bash non-zero exit: throws (Pi <= 0.98 behaviour): Command exited with code 3");
	});

	it("warns when the bash probe throws for a reason other than a non-zero exit", () => {
		const brokenBash = [
			"export function createBashToolDefinition() {",
			'\treturn { execute: async () => { throw new Error("spawn /bin/bash ENOENT"); } };',
			"}",
		].join("\n");
		const root = fakePi(realVersion(), "*", brokenBash);
		const relaxed = checkPiCompat("--pi-root", root);
		expect(relaxed.status, relaxed.output).toBe(0);
		expect(relaxed.output).toContain("bash non-zero exit: throws an unexpected error: spawn /bin/bash ENOENT");
		expect(relaxed.output).not.toContain("Pi <= 0.98 behaviour");
		expect(relaxed.output).toContain("WARN: bash probe threw for a reason other than a non-zero exit");
		const strict = checkPiCompat("--pi-root", root, "--strict");
		expect(strict.status, strict.output).toBe(1);
	});

	it("reports a Pi install that cannot be imported as a structured failure", () => {
		const result = checkPiCompat("--pi-root", fakePi(realVersion(), "", 'throw new Error("broken install");'));
		expect(result.status, result.output).toBe(1);
		expect(result.output).toContain("ERROR: Cannot load @earendil-works/pi-coding-agent: broken install");
		expect(result.output).toContain("Pi compatibility: FAIL");
		expect(result.output).not.toMatch(/^\s+at /m);
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
