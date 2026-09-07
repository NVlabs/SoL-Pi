/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const FEATURE_KEYS = [
	"actionFusion",
	"observationPack",
	"evidencePreservingReducer",
	"onlineContextCompact",
];
const DEFAULT_CACHE_WRITE_READ_RATIO = 12.5;
const DEFAULT_EPR_REDUCER_PROVIDER = ["openai", "codex"].join("-");
const DEFAULT_EPR_REDUCER_MODEL = ["gpt-5.6", "luna"].join("-");
const STRING_KEYS = ["evidencePreservingReducerModel", "evidencePreservingReducerProvider"];
const CONFIG_KEYS = new Set(["version", ...FEATURE_KEYS, ...STRING_KEYS, "cacheWriteReadRatio"]);

function fail(message) {
	throw new Error(message);
}

function parseArguments(argv) {
	const options = { config: undefined, requireAllEnabled: false };
	const seen = new Set();
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (seen.has(argument)) fail(`duplicate option: ${argument}`);
		if (argument === "--require-all-enabled") {
			seen.add(argument);
			options.requireAllEnabled = true;
			continue;
		}
		if (argument !== "--config") fail(`unknown option: ${argument}`);
		seen.add(argument);
		const value = argv[index + 1];
		if (!value || value.startsWith("--")) fail("missing value for --config");
		options.config = value;
		index += 1;
	}
	if (!options.config) fail("--config is required");
	return options;
}

function readConfig(path) {
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		fail(`unable to read config ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	try {
		return JSON.parse(text);
	} catch (error) {
		fail(`invalid JSON in config ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function validateConfig(value, requireAllEnabled) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		fail("config must be a JSON object");
	}
	for (const key of Object.keys(value)) {
		if (!CONFIG_KEYS.has(key)) fail(`unknown key: ${key}`);
	}
	if (value.version !== 1) fail("version must be 1");

	const effective = { version: 1 };
	for (const key of FEATURE_KEYS) {
		const configured = value[key];
		if (configured !== undefined && typeof configured !== "boolean") fail(`${key} must be boolean`);
		effective[key] = configured ?? false;
		if (requireAllEnabled && effective[key] !== true) fail(`${key} must be true`);
	}
	const cacheWriteReadRatio = Object.hasOwn(value, "cacheWriteReadRatio")
		? value.cacheWriteReadRatio
		: DEFAULT_CACHE_WRITE_READ_RATIO;
	if (
		typeof cacheWriteReadRatio !== "number" ||
		!Number.isFinite(cacheWriteReadRatio) ||
		cacheWriteReadRatio < 0
	) {
		fail("cacheWriteReadRatio must be a finite non-negative number");
	}
	effective.cacheWriteReadRatio = cacheWriteReadRatio;
	effective.evidencePreservingReducerModel = stringConfigValue(
		value,
		"evidencePreservingReducerModel",
		DEFAULT_EPR_REDUCER_MODEL,
	);
	effective.evidencePreservingReducerProvider = stringConfigValue(
		value,
		"evidencePreservingReducerProvider",
		DEFAULT_EPR_REDUCER_PROVIDER,
	);

	return {
		ok: true,
		all_enabled: FEATURE_KEYS.every((key) => effective[key] === true),
		effective_config: effective,
	};
}

function stringConfigValue(value, key, defaultValue) {
	const configured = Object.hasOwn(value, key) ? value[key] : defaultValue;
	if (typeof configured !== "string" || configured.trim().length === 0) fail(`${key} must be a non-empty string`);
	return configured;
}

try {
	const options = parseArguments(process.argv.slice(2));
	const configPath = resolve(options.config);
	const result = validateConfig(readConfig(configPath), options.requireAllEnabled);
	console.log(JSON.stringify({ ...result, config: configPath }, null, 2));
} catch (error) {
	console.error(`SoL-Pi configuration preflight failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}
