/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

/**
 * Redaction contract for store captures.
 *
 * SoL-Pi persists RAW tool output (observation-pack objects, reducer archives),
 * and a repository-shared store is readable by every workflow of that repo.
 * The durable fleet publisher redacts independently; the extension had no
 * scrub pass. This module supplies one: every payload is scrubbed BEFORE it is
 * hashed, stored, or fed to the reducer, so content addressing, recall, and
 * receipt validation all describe the same (scrubbed) bytes.
 *
 * The contract is config-level data (the deployment decides which patterns a
 * fleet class scrubs), not a hard-coded list.
 */

export interface RedactionContract {
	readonly enabled: boolean;
	readonly patterns: readonly string[];
	readonly replacement: string;
}

export const DEFAULT_REDACTION: RedactionContract = Object.freeze({
	enabled: false,
	patterns: [],
	replacement: "[redacted]",
});

const MAX_PATTERNS = 32;
const MAX_PATTERN_SOURCE = 200;
const MAX_REPLACEMENT = 64;

/** Compile the contract once; invalid patterns are an input error, never a silent pass. */
export function compileRedaction(contract: RedactionContract): readonly RegExp[] {
	if (!contract.enabled) return [];
	if (contract.patterns.length > MAX_PATTERNS) {
		throw new Error(`SoL-Pi redaction: at most ${MAX_PATTERNS} patterns are supported`);
	}
	if (contract.enabled && contract.replacement.length > MAX_REPLACEMENT) {
		throw new Error(`SoL-Pi redaction: replacement must be at most ${MAX_REPLACEMENT} characters`);
	}
	const compiled: RegExp[] = [];
	for (const source of contract.patterns) {
		if (typeof source !== "string" || source.length === 0 || source.length > MAX_PATTERN_SOURCE) {
			throw new Error("SoL-Pi redaction: each pattern must be a non-empty string of at most 200 characters");
		}
		let regex: RegExp;
		try {
			regex = new RegExp(source, "gu");
		} catch (error) {
			throw new Error(
				`SoL-Pi redaction: invalid pattern ${JSON.stringify(source)}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		// Zero-width matches would loop or inject text without removing a secret.
		if (new RegExp(source, "u").test("")) {
			throw new Error(`SoL-Pi redaction: pattern ${JSON.stringify(source)} matches the empty string`);
		}
		compiled.push(regex);
	}
	return compiled;
}

export function scrubText(text: string, patterns: readonly RegExp[], replacement: string): string {
	if (patterns.length === 0) return text;
	let scrubbed = text;
	// Function replacement: a `$` in the configured text is literal, not a
	// backreference to the secret it replaces.
	for (const pattern of patterns) scrubbed = scrubbed.replace(pattern, () => replacement);
	return scrubbed;
}

/** A one-shot scrubber the mechanisms receive; identity when redaction is off. */
export function makeScrubber(contract: RedactionContract): (text: string) => string {
	const patterns = compileRedaction(contract);
	return (text) => scrubText(text, patterns, contract.replacement);
}

export const REDACTION_LIMITS = Object.freeze({
	maxPatterns: MAX_PATTERNS,
	maxPatternSource: MAX_PATTERN_SOURCE,
	maxReplacement: MAX_REPLACEMENT,
});
