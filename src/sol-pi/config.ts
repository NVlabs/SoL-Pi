/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_REDUCER_MODEL,
	DEFAULT_REDUCER_PROVIDER,
} from "./extensions/evidence-preserving-reducer/config.ts";
import {
	DEFAULT_REDACTION,
	compileRedaction,
	REDACTION_LIMITS,
	type RedactionContract,
} from "./redaction.ts";

export const DEFAULT_CACHE_WRITE_READ_RATIO = 12.5;

export interface SolPiConfig {
	readonly version: 1;
	readonly actionFusion: boolean;
	readonly observationPack: boolean;
	readonly evidencePreservingReducer: boolean;
	readonly evidencePreservingReducerModel: string;
	readonly evidencePreservingReducerProvider: string;
	readonly onlineContextCompact: boolean;
	readonly cacheWriteReadRatio: number;
	readonly redaction: RedactionContract;
	readonly storeRepairMismatch: boolean;
}

export const DEFAULT_CONFIG: SolPiConfig = Object.freeze({
	version: 1,
	actionFusion: false,
	observationPack: false,
	evidencePreservingReducer: false,
	evidencePreservingReducerModel: DEFAULT_REDUCER_MODEL,
	evidencePreservingReducerProvider: DEFAULT_REDUCER_PROVIDER,
	onlineContextCompact: false,
	cacheWriteReadRatio: DEFAULT_CACHE_WRITE_READ_RATIO,
	redaction: DEFAULT_REDACTION,
	storeRepairMismatch: false,
});

const FEATURE_KEYS = [
	"actionFusion",
	"observationPack",
	"evidencePreservingReducer",
	"onlineContextCompact",
] as const;
const STRING_KEYS = ["evidencePreservingReducerModel", "evidencePreservingReducerProvider"] as const;
const CONFIG_KEYS = new Set<string>([
	"version",
	...FEATURE_KEYS,
	...STRING_KEYS,
	"cacheWriteReadRatio",
	"redaction",
	"storeRepairMismatch",
]);

export function findConfigPath(
	cwd = process.cwd(),
	agentDir = getAgentDir(),
	allowProjectConfig = false,
): string | undefined {
	if (allowProjectConfig) {
		const projectPath = join(cwd, CONFIG_DIR_NAME, "sol-pi.json");
		if (existsSync(projectPath)) return projectPath;
	}

	const globalPath = join(agentDir, "sol-pi.json");
	return existsSync(globalPath) ? globalPath : undefined;
}

export function loadSolPiConfig(
	cwd = process.cwd(),
	agentDir = getAgentDir(),
	allowProjectConfig = false,
): SolPiConfig {
	const path = findConfigPath(cwd, agentDir, allowProjectConfig);
	if (!path) return DEFAULT_CONFIG;

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`Unable to read SoL-Pi config ${path}: ${reason}`);
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`SoL-Pi config must be a JSON object: ${path}`);
	}

	const record = parsed as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (!CONFIG_KEYS.has(key)) throw new Error(`Unknown SoL-Pi config key: ${key}`);
	}
	if (record.version !== 1) throw new Error(`SoL-Pi config version must be 1: ${path}`);

	for (const key of FEATURE_KEYS) {
		if (record[key] !== undefined && typeof record[key] !== "boolean") {
			throw new Error(`SoL-Pi config ${key} must be boolean: ${path}`);
		}
	}
	const cacheWriteReadRatio = Object.hasOwn(record, "cacheWriteReadRatio")
		? record.cacheWriteReadRatio
		: DEFAULT_CACHE_WRITE_READ_RATIO;
	if (
		typeof cacheWriteReadRatio !== "number" ||
		!Number.isFinite(cacheWriteReadRatio) ||
		cacheWriteReadRatio < 0
	) {
		throw new Error(`SoL-Pi config cacheWriteReadRatio must be a finite non-negative number: ${path}`);
	}
	const evidencePreservingReducerModel = stringConfigValue(
		record,
		"evidencePreservingReducerModel",
		DEFAULT_REDUCER_MODEL,
		path,
	);
	const evidencePreservingReducerProvider = stringConfigValue(
		record,
		"evidencePreservingReducerProvider",
		DEFAULT_REDUCER_PROVIDER,
		path,
	);

	return Object.freeze({
		...DEFAULT_CONFIG,
		...record,
		cacheWriteReadRatio,
		evidencePreservingReducerModel,
		evidencePreservingReducerProvider,
		redaction: redactionContract(record, path),
		storeRepairMismatch: booleanConfigValue(record, "storeRepairMismatch", false, path),
	}) as SolPiConfig;
}

function stringConfigValue(
	record: Record<string, unknown>,
	key: (typeof STRING_KEYS)[number],
	defaultValue: string,
	path: string,
): string {
	const value = Object.hasOwn(record, key) ? record[key] : defaultValue;
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`SoL-Pi config ${key} must be a non-empty string: ${path}`);
	}
	return value.trim();
}

function booleanConfigValue(
	record: Record<string, unknown>,
	key: string,
	defaultValue: boolean,
	path: string,
): boolean {
	const value = Object.hasOwn(record, key) ? record[key] : defaultValue;
	if (typeof value !== "boolean") throw new Error(`SoL-Pi config ${key} must be boolean: ${path}`);
	return value;
}

/**
 * The redaction contract is data: the deployment declares which patterns a
 * fleet class scrubs. Patterns are compiled at load so an invalid one stops
 * the extension, never silently scrubs nothing.
 */
function redactionContract(record: Record<string, unknown>, path: string): RedactionContract {
	const raw = Object.hasOwn(record, "redaction") ? record.redaction : undefined;
	if (raw === undefined) return DEFAULT_REDACTION;
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new Error(`SoL-Pi config redaction must be an object: ${path}`);
	}
	const value = raw as Record<string, unknown>;
	for (const key of Object.keys(value)) {
		if (key !== "enabled" && key !== "patterns" && key !== "replacement") {
			throw new Error(`SoL-Pi config redaction has an unknown key: ${key}`);
		}
	}
	const enabled = Object.hasOwn(value, "enabled") ? value.enabled : false;
	if (typeof enabled !== "boolean") throw new Error(`SoL-Pi config redaction.enabled must be boolean: ${path}`);
	const patterns = Object.hasOwn(value, "patterns") ? value.patterns : [];
	if (!Array.isArray(patterns)) throw new Error(`SoL-Pi config redaction.patterns must be an array: ${path}`);
	if (patterns.length > REDACTION_LIMITS.maxPatterns) {
		throw new Error(`SoL-Pi config redaction.patterns exceeds ${REDACTION_LIMITS.maxPatterns}: ${path}`);
	}
	for (const pattern of patterns) {
		if (typeof pattern !== "string") throw new Error(`SoL-Pi config redaction.patterns entries must be strings: ${path}`);
	}
	const replacement = Object.hasOwn(value, "replacement") ? value.replacement : DEFAULT_REDACTION.replacement;
	if (typeof replacement !== "string" || replacement.length === 0) {
		throw new Error(`SoL-Pi config redaction.replacement must be a non-empty string: ${path}`);
	}
	const contract: RedactionContract = Object.freeze({ enabled, patterns: [...patterns] as string[], replacement });
	compileRedaction(contract); // fail at load, not at the first capture
	return contract;
}
