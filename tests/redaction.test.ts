/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createObservation, ensureStored, hash } from "../src/sol-pi/extensions/observation-pack/observation.ts";
import {
	compileRedaction,
	DEFAULT_REDACTION,
	makeScrubber,
	REDACTION_LIMITS,
	scrubText,
	type RedactionContract,
} from "../src/sol-pi/redaction.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

const CONTRACT: RedactionContract = {
	enabled: true,
	patterns: ["api_key=[^\\s]+", "Bearer [A-Za-z0-9._~-]+"],
	replacement: "[redacted]",
};

describe("SoL-Pi redaction", () => {
	it("is identity when the contract is disabled", () => {
		const scrub = makeScrubber(DEFAULT_REDACTION);
		expect(scrub("api_key=secret")).toBe("api_key=secret");
	});

	it("scrubs before capture so the payload never reaches the store raw", () => {
		const scrub = makeScrubber(CONTRACT);
		expect(scrub("x api_key=abc123 y")).toBe("x [redacted] y");
		expect(scrub("Authorization: Bearer eyJhbGc")).toBe("Authorization: [redacted]");
	});

	it("treats the replacement text literally, not as a backreference", () => {
		const scrub = makeScrubber({ enabled: true, patterns: ["secret=(\\S+)"], replacement: "$1$&" });
		expect(scrub("secret=abc")).toBe("$1$&");
	});

	it("replaces every occurrence, not just the first", () => {
		const scrub = makeScrubber(CONTRACT);
		expect(scrub("api_key=a api_key=b")).toBe("[redacted] [redacted]");
	});

	it("refuses a pattern matching the empty string (infinite/zero-width scrub)", () => {
		expect(() => compileRedaction({ enabled: true, patterns: ["a*"], replacement: "[redacted]" })).toThrow(
			/matches the empty string/u,
		);
	});

	it("refuses an invalid regex loudly", () => {
		expect(() => compileRedaction({ enabled: true, patterns: ["("], replacement: "[redacted]" })).toThrow(
			/invalid pattern/u,
		);
	});

	it("enforces the pattern count and source length bounds", () => {
		const many = Array.from({ length: REDACTION_LIMITS.maxPatterns + 1 }, () => "x");
		expect(() => compileRedaction({ enabled: true, patterns: many, replacement: "[redacted]" })).toThrow(
			/at most 32 patterns/u,
		);
		expect(() => compileRedaction({ enabled: true, patterns: ["y".repeat(201)], replacement: "[redacted]" })).toThrow(
			/at most 200 characters/u,
		);
	});

	it("compiles once and applies the same patterns to every capture", () => {
		const scrub = makeScrubber(CONTRACT);
		expect(scrub("one api_key=x")).toBe("one [redacted]");
		expect(scrub("two api_key=y")).toBe("two [redacted]");
	});

	it("preserves non-secret bytes exactly", () => {
		const scrub = makeScrubber(CONTRACT);
		const text = "line1\nline2\n";
		expect(scrub(text)).toBe(text);
	});

	it("the compiled list is reusable across captures", () => {
		const patterns = compileRedaction(CONTRACT);
		const first = scrubText("api_key=a", patterns, "[redacted]");
		const second = scrubText("api_key=b", patterns, "[redacted]");
		expect(first).toBe("[redacted]");
		expect(second).toBe("[redacted]");
	});
});

describe("SoL-Pi redaction at the capture boundary", () => {
	function root(): string {
		const dir = mkdtempSync(join(tmpdir(), "sol-pi-redaction-"));
		roots.push(dir);
		return dir;
	}

	const largeBody = (secret: string) => `line\n${secret}\n${"payload\n".repeat(3000)}`;

	it("createObservation hashes the SCRUBBED payload, not the raw one", async () => {
		const dir = root();
		const scrub = makeScrubber(CONTRACT);
		const raw = largeBody("api_key=abcdef");
		const message = { role: "toolResult", toolName: "bash", toolCallId: "call-1", content: [{ type: "text", text: raw }] } as never;
		const observation = createObservation(message, dir, scrub);
        expect(observation).toBeDefined();
        const scrubbed = scrub(raw);
        expect(observation!.text).toBe(scrubbed);
        expect(observation!.contentHash).toBe(hash(scrubbed));
        expect(observation!.contentHash).not.toBe(hash(raw));
	});

	it("ensureStored writes the scrubbed bytes and verifies against the scrubbed hash", async () => {
		const dir = root();
		const scrub = makeScrubber(CONTRACT);
		const raw = largeBody("api_key=abcdef");
		const message = { role: "toolResult", toolName: "bash", toolCallId: "call-1", content: [{ type: "text", text: raw }] } as never;
		const observation = createObservation(message, dir, scrub)!;
		await ensureStored(observation);
		const stored = readFileSync(observation.filePath, "utf8");
		expect(stored).not.toContain("api_key=abcdef");
		expect(stored).toContain("[redacted]");
		expect(hash(stored)).toBe(observation.contentHash);
	});

	it("raw capture with a disabled contract round-trips byte-identically", async () => {
		const dir = root();
		const raw = largeBody("api_key=abcdef");
		const message = { role: "toolResult", toolName: "bash", toolCallId: "call-1", content: [{ type: "text", text: raw }] } as never;
		const observation = createObservation(message, dir)!;
		await ensureStored(observation);
		expect(readFileSync(observation.filePath, "utf8")).toBe(raw);
	});
});
