/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { reducibleToolResult } from "../src/sol-pi/extensions/evidence-preserving-reducer/candidate.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof fs>();
	return { ...actual, lstat: vi.fn(actual.lstat), readFile: vi.fn(actual.readFile), open: vi.fn(actual.open) };
});

const paths: string[] = [];
const maxChars = 65_536;

afterEach(async () => {
	vi.restoreAllMocks();
	vi.clearAllMocks();
	await Promise.all(paths.splice(0).map((path) => fs.unlink(path)));
});

async function outputFile(body: string): Promise<string> {
	const path = join(tmpdir(), `pi-bash-${randomUUID()}.log`);
	paths.push(path);
	await fs.writeFile(path, body);
	return path;
}

function event(path: string, toolName = "bash", command = "npm test"): ToolResultEvent {
	return {
		type: "tool_result",
		toolCallId: "candidate-read",
		toolName,
		input: toolName === "bash" ? { command } : { then_run: { command } },
		content: [{ type: "text", text: toolName === "bash" ? "preview" : "[then_run:succeeded]\npreview" }],
		details: { fullOutputPath: path },
		isError: false,
	} as ToolResultEvent;
}

it.each(["bash", "write", "edit"])("skips filesystem access for non-diagnostic %s output", async (tool) => {
	const path = await outputFile("x".repeat(maxChars * 10));
	expect(await reducibleToolResult(event(path, tool, "cat large.txt"), maxChars)).toBeUndefined();
	expect(fs.lstat).not.toHaveBeenCalled();
	expect(fs.open).not.toHaveBeenCalled();
	expect(fs.readFile).not.toHaveBeenCalled();
});

it.each([
	"a".repeat(maxChars - 1) + "中",
	"中".repeat(maxChars),
	"😀".repeat(maxChars / 2),
])("preserves an eligible UTF-8 log at the character limit (%#)", async (body) => {
	const path = await outputFile(body);
	expect((await reducibleToolResult(event(path), maxChars))?.body).toBe(body);
});

it.each(["a".repeat(maxChars) + "中", "中".repeat(maxChars + 1), "😀".repeat(maxChars / 2) + "x"])(
	"rejects a UTF-8 log one character over the limit (%#)", async (body) => {
		const path = await outputFile(body);
		expect((await reducibleToolResult(event(path), maxChars))?.body).toBeUndefined();
	},
);

it("does not read a log whose size already proves it exceeds the limit", async () => {
	const path = await outputFile("x".repeat(3 * maxChars + 1));
	const handle = await fs.open(path, "r");
	vi.mocked(fs.open).mockResolvedValueOnce(handle);
	const read = vi.spyOn(handle, "read");
	const close = vi.spyOn(handle, "close");
	expect((await reducibleToolResult(event(path), maxChars))?.body).toBeUndefined();
	expect(read).not.toHaveBeenCalled();
	expect(close).toHaveBeenCalledOnce();
});

it.each([false, true])("preserves oversize rejection when closing fails (growing=%s)", async (growing) => {
	const path = await outputFile("x".repeat(4 * maxChars));
	const handle = await fs.open(path, "r");
	vi.mocked(fs.open).mockResolvedValueOnce(handle);
	if (growing) {
		const stats = await handle.stat();
		stats.size = 0;
		vi.spyOn(handle, "stat").mockResolvedValue(stats);
	}
	const close = handle.close.bind(handle);
	vi.spyOn(handle, "close").mockImplementationOnce(async () => {
		await close();
		throw new Error("close failed");
	});
	const candidate = await reducibleToolResult(event(path), maxChars);
	expect(candidate).toBeDefined();
	expect(candidate?.body).toBeUndefined();
});

it.each(["x", "中", "😀"])("rejects oversized %s logs without reading the whole file", async (character) => {
	const path = await outputFile(character.repeat(maxChars * 10));
	const open = vi.mocked(fs.open).getMockImplementation()!;
	let bytesRead = 0;
	const closes: ReturnType<typeof vi.spyOn>[] = [];
	vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
		const handle = await open(...args);
		// Simulate a log growing after stat so the read cap, not the size check, must stop it.
		const stats = await handle.stat();
		stats.size = 0;
		vi.spyOn(handle, "stat").mockResolvedValue(stats);
		const read = handle.read.bind(handle);
		vi.spyOn(handle, "read").mockImplementation(async (...readArgs: Parameters<typeof read>) => {
			const result = await read(...readArgs);
			bytesRead += result.bytesRead;
			return result;
		});
		closes.push(vi.spyOn(handle, "close"));
		return handle;
	});
	const candidate = await reducibleToolResult(event(path), maxChars);
	expect(candidate).toBeDefined();
	expect(candidate?.body).toBeUndefined();
	expect(fs.readFile).not.toHaveBeenCalled();
	expect(bytesRead).toBeLessThanOrEqual(3 * maxChars + 1);
	expect(closes).toHaveLength(1);
	for (const close of closes) expect(close).toHaveBeenCalledOnce();
});

it("closes the file and preserves the preview on a read failure", async () => {
	const path = await outputFile("diagnostic output");
	const open = vi.mocked(fs.open).getMockImplementation()!;
	const handle = await open(path, "r");
	vi.mocked(fs.open).mockResolvedValueOnce(handle);
	vi.spyOn(handle, "read").mockRejectedValueOnce(new Error("read failed"));
	const close = vi.spyOn(handle, "close");
	expect((await reducibleToolResult(event(path), maxChars))?.body).toBe("preview");
	expect(close).toHaveBeenCalledOnce();
});
