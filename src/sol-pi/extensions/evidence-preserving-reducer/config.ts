/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { createHash } from "node:crypto";
import { join } from "node:path";

export const REDUCER_EVENT_TYPE = "sol-pi-evidence-preserving-reducer-v1" as const;
export const REDUCER_EVENT_SCHEMA = "sol-pi-evidence-preserving-reducer/1" as const;
export const REDUCER_RECEIPT_SCHEMA = "sol-pi-evidence-receipt/1" as const;
export const REDUCER_RECEIPT_PREFIX = "sol_pi_evidence_receipt_v1" as const;

export const MAX_EVIDENCE_ITEMS = 12;
export const MAX_QUOTE_CHARS = 600;

const DEFAULT_MIN_BYTES = 4_096;
const DEFAULT_MAX_CHARS = 600_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 2_048;
const DEFAULT_TIMEOUT_MS = 90_000;

export const DEFAULT_REDUCER_PROVIDER = ["openai", "codex"].join("-");
export const DEFAULT_REDUCER_MODEL = ["gpt-5.6", "luna"].join("-");

const NON_CARGO_DIAGNOSTIC_COMMAND =
	/^(?:lake\0build|lake\0env\0lean|lean|coq|zig\0build|pytest|python(?:3)?\0-m\0(?:pytest|unittest|py_compile)|ctest|cmake\0--build|ninja|make|npm\0test|pnpm\0test|yarn\0test|go\0test|bazel\0test)(?:\0|$)/i;

const CARGO_DIAGNOSTIC_SUBCOMMANDS = new Set(["build", "check", "test"]);
const CARGO_GLOBAL_FLAGS = new Set([
	"--frozen",
	"--locked",
	"--offline",
	"--quiet",
	"--verbose",
	"-q",
]);
const CARGO_COLOR_VALUES = new Set(["always", "auto", "never"]);
const CARGO_GLOBAL_VALUE_OPTIONS = new Set(["--config", "-C", "-Z"]);
const MAX_COMMAND_TOKENS = 4_096;

function shellCommandSegments(command: string): readonly (readonly string[])[] | undefined {
	const segments: string[][] = [];
	let segment: string[] = [];
	let token = "";
	let tokenStarted = false;
	let quote: "\"" | "'" | undefined;
	let escaped = false;
	let comment = false;
	let tokenCount = 0;

	const pushToken = (): boolean => {
		if (!tokenStarted) return true;
		segment.push(token);
		token = "";
		tokenStarted = false;
		tokenCount += 1;
		return tokenCount <= MAX_COMMAND_TOKENS;
	};
	const pushSegment = (): void => {
		if (segment.length > 0) segments.push(segment);
		segment = [];
	};

	for (const character of command) {
		if (comment) {
			if (character === "\n") {
				comment = false;
				pushSegment();
			}
			continue;
		}
		if (escaped) {
			escaped = false;
			if (character === "\n") continue;
			if (quote === "\"" && !"$`\"\\".includes(character)) token += "\\";
			token += character;
			tokenStarted = true;
			continue;
		}
		if (quote !== undefined) {
			if (character === quote) quote = undefined;
			else if (quote === "\"" && character === "\\") escaped = true;
			else token += character;
			continue;
		}
		if (character === "\\") {
			escaped = true;
			continue;
		}
		if (character === "\"" || character === "'") {
			tokenStarted = true;
			quote = character;
			continue;
		}
		if (character === "#" && !tokenStarted) {
			comment = true;
			continue;
		}
		if (character === "\n" || ";|&()".includes(character)) {
			if (!pushToken()) return undefined;
			pushSegment();
			continue;
		}
		if (/\s/u.test(character)) {
			if (!pushToken()) return undefined;
			continue;
		}
		token += character;
		tokenStarted = true;
	}

	if (escaped || quote !== undefined || !pushToken()) return undefined;
	pushSegment();
	return segments;
}

function isShellAssignment(token: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*=/u.test(token);
}

function segmentRunsDiagnostic(tokens: readonly string[]): boolean {
	let index = 0;
	while (isShellAssignment(tokens[index] ?? "")) index += 1;
	// NUL separates argv entries without treating whitespace inside an entry as a boundary.
	if (NON_CARGO_DIAGNOSTIC_COMMAND.test(tokens.slice(index).join("\0"))) return true;
	if ((tokens[index] ?? "").toLowerCase() !== "cargo") return false;
	index += 1;

	if (/^\+[\w.-]+$/u.test(tokens[index] ?? "")) index += 1;
	while (index < tokens.length) {
		const token = tokens[index] ?? "";
		const normalized = token.toLowerCase();
		if (CARGO_DIAGNOSTIC_SUBCOMMANDS.has(normalized)) return true;
		if (CARGO_GLOBAL_FLAGS.has(token) || /^-v+$/u.test(token)) {
			index += 1;
			continue;
		}
		if (token === "--color") {
			if (!CARGO_COLOR_VALUES.has((tokens[index + 1] ?? "").toLowerCase())) return false;
			index += 2;
			continue;
		}
		if (CARGO_GLOBAL_VALUE_OPTIONS.has(token)) {
			index += 2;
			continue;
		}
		if (
			(token.startsWith("--color=") && CARGO_COLOR_VALUES.has(token.slice("--color=".length).toLowerCase())) ||
			(token.startsWith("--config=") && token.length > "--config=".length) ||
			((token.startsWith("-C") || token.startsWith("-Z")) && token.length > 2)
		) {
			index += 1;
			continue;
		}
		return false;
	}
	return false;
}

function isDiagnosticCommand(command: string): boolean {
	if (command.includes("\0")) return false;
	return shellCommandSegments(command)?.some(segmentRunsDiagnostic) ?? false;
}

export const DIAGNOSTIC_COMMAND = Object.freeze({ test: isDiagnosticCommand });

export const FAILURE_SIGNAL = /error|failed|failure|fatal|exception|panic|timeout|unsolved|type mismatch|assert/i;
export const LIKELY_SECRET = /(?:api[_-]?key|authorization|bearer|access[_-]?token|secret)[^\n]{0,32}[=:][^\n]+/i;

export interface ReducerConfig {
	readonly maxChars: number;
	readonly maxOutputTokens: number;
	readonly minBytes: number;
	readonly reducerModel: string;
	readonly reducerProvider: string;
	readonly runId: string;
	readonly storeRoot: string;
	readonly timeoutMs: number;
}

export interface ReducerConfigOptions {
	readonly reducerModel?: string;
	readonly reducerProvider?: string;
}

export function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function recordValue(value: unknown, key: string): unknown {
	return isRecord(value) ? value[key] : undefined;
}

export function loadReducerConfig(runtimeDirectory: string, options: ReducerConfigOptions = {}): ReducerConfig {
	return Object.freeze({
		maxChars: DEFAULT_MAX_CHARS,
		maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
		minBytes: DEFAULT_MIN_BYTES,
		reducerModel: options.reducerModel ?? DEFAULT_REDUCER_MODEL,
		reducerProvider: options.reducerProvider ?? DEFAULT_REDUCER_PROVIDER,
		runId: sha256(runtimeDirectory).slice(0, 16),
		storeRoot: join(runtimeDirectory, "evidence-preserving-reducer"),
		timeoutMs: DEFAULT_TIMEOUT_MS,
	});
}
