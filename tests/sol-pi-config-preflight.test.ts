/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = join(process.cwd(), "scripts/check-sol-pi-config.mjs");

let directory: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "sol-pi-config-preflight-"));
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

function writeConfig(value: unknown): string {
	const path = join(directory, "sol-pi.json");
	writeFileSync(path, JSON.stringify(value));
	return path;
}

function run(config: string, requireAllEnabled = true) {
	const args = [SCRIPT, "--config", config];
	if (requireAllEnabled) args.push("--require-all-enabled");
	return spawnSync(process.execPath, args, {
		cwd: process.cwd(),
		encoding: "utf8",
	});
}

const DEFAULT_EPR_PROVIDER = ["openai", "codex"].join("-");
const DEFAULT_EPR_MODEL = ["gpt-5.6", "luna"].join("-");

const ALL_ENABLED = {
	version: 1,
	actionFusion: true,
	observationPack: true,
	evidencePreservingReducer: true,
	evidencePreservingReducerProvider: DEFAULT_EPR_PROVIDER,
	evidencePreservingReducerModel: DEFAULT_EPR_MODEL,
	onlineContextCompact: true,
	cacheWriteReadRatio: 12.5,
};

describe("SoL-Pi configuration preflight", () => {
	it("accepts the exact all-enabled configuration", () => {
		const result = run(writeConfig(ALL_ENABLED));
		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({
			ok: true,
			all_enabled: true,
			effective_config: {
				cacheWriteReadRatio: 12.5,
				evidencePreservingReducerProvider: DEFAULT_EPR_PROVIDER,
				evidencePreservingReducerModel: DEFAULT_EPR_MODEL,
			},
		});
	});

	it("applies the default ratio when the field is omitted", () => {
		const { cacheWriteReadRatio: _ratio, ...withoutRatio } = ALL_ENABLED;
		const result = run(writeConfig(withoutRatio));
		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout).effective_config.cacheWriteReadRatio).toBe(12.5);
	});

	it("applies default EPR reducer provider/model when those fields are omitted", () => {
		const {
			evidencePreservingReducerModel: _model,
			evidencePreservingReducerProvider: _provider,
			...withoutReducerRoute
		} = ALL_ENABLED;
		const result = run(writeConfig(withoutReducerRoute));
		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout).effective_config).toMatchObject({
			evidencePreservingReducerProvider: DEFAULT_EPR_PROVIDER,
			evidencePreservingReducerModel: DEFAULT_EPR_MODEL,
		});
	});

	it.each([null, "12.5", -1])("rejects an invalid ratio: %j", (cacheWriteReadRatio) => {
		const result = run(writeConfig({ ...ALL_ENABLED, cacheWriteReadRatio }));
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("cacheWriteReadRatio must be a finite non-negative number");
	});

	it.each([
		["evidencePreservingReducerProvider", ""],
		["evidencePreservingReducerProvider", null],
		["evidencePreservingReducerModel", ""],
		["evidencePreservingReducerModel", null],
	] as const)("rejects an invalid reducer route: %s=%j", (key, value) => {
		const result = run(writeConfig({ ...ALL_ENABLED, [key]: value }));
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(`${key} must be a non-empty string`);
	});

	it("rejects a disabled or missing mechanism", () => {
		for (const config of [
			{ ...ALL_ENABLED, onlineContextCompact: false },
			{ version: 1, actionFusion: true, observationPack: true, evidencePreservingReducer: true },
		]) {
			const result = run(writeConfig(config));
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("onlineContextCompact must be true");
		}
	});

	it("accepts a valid partially enabled config when all-enabled mode is not requested", () => {
		const result = run(writeConfig({ version: 1, actionFusion: true }), false);
		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({ all_enabled: false });
	});

	it("rejects unknown configuration keys", () => {
		const result = run(writeConfig({ ...ALL_ENABLED, provider: "custom" }));
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("unknown key: provider");
	});
});
