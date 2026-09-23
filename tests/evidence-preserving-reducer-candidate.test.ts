/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reducibleToolResult } from "../src/sol-pi/extensions/evidence-preserving-reducer/candidate.ts";

// Recovering the untruncated bash output reads a file that Pi wrote; the
// candidate check must not pay for that read before it knows the command is a
// diagnostic one.
const recorded = vi.hoisted(() => ({ reads: [] as string[] }));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		readFile: (path: unknown, ...rest: unknown[]) => {
			recorded.reads.push(String(path));
			return (actual.readFile as (...args: unknown[]) => unknown)(path, ...rest);
		},
	};
});

const fullOutputPaths: string[] = [];

beforeEach(() => {
	recorded.reads.length = 0;
});

afterEach(async () => {
	await Promise.all(fullOutputPaths.splice(0).map((path) => rm(path, { force: true })));
});

/** A file shaped like the one Pi writes when a bash result is truncated. */
async function pendingFullOutput(body: string): Promise<string> {
	const path = join(tmpdir(), `pi-bash-${randomUUID()}.log`);
	fullOutputPaths.push(path);
	await writeFile(path, body, "utf8");
	return path;
}

function bashResult(command: string, fullOutputPath: string): ToolResultEvent {
	return {
		type: "tool_result",
		toolName: "bash",
		toolCallId: "call-1",
		input: { command },
		content: [{ type: "text", text: "truncated preview\n[Full output: elsewhere]" }],
		details: { fullOutputPath },
		isError: false,
	} as ToolResultEvent;
}

describe("reducible tool result", () => {
	it("recovers the untruncated body for a diagnostic command", async () => {
		const body = `FAILED tests/test_math.py::test_addition\n${"pytest output\n".repeat(200)}`;
		const path = await pendingFullOutput(body);

		const reducible = await reducibleToolResult(bashResult("pytest -q", path));

		expect(reducible?.body).toBe(body);
		expect(recorded.reads).toContain(path);
	});

	it("does not read the full-output file for a command it will never reduce", async () => {
		const path = await pendingFullOutput(`${"git status output\n".repeat(200)}`);

		const reducible = await reducibleToolResult(bashResult("git status --porcelain", path));

		expect(reducible).toBeUndefined();
		expect(recorded.reads).not.toContain(path);
	});

	it("does not read the full-output file for a fused mutation whose command it will never reduce", async () => {
		const path = await pendingFullOutput(`${"server log line\n".repeat(200)}`);
		const event = {
			type: "tool_result",
			toolName: "write",
			toolCallId: "write-1",
			input: { path: "server.ts", content: "export {};\n", then_run: { command: "node server.js" } },
			content: [{ type: "text", text: "Successfully wrote 12 bytes to server.ts\n[then_run:succeeded]\nstarted" }],
			details: { fullOutputPath: path },
			isError: false,
		} as ToolResultEvent;

		const reducible = await reducibleToolResult(event);

		expect(reducible).toBeUndefined();
		expect(recorded.reads).not.toContain(path);
	});
});
