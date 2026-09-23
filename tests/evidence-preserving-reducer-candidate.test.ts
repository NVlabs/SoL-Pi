/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { reducibleToolResult } from "../src/sol-pi/extensions/evidence-preserving-reducer/candidate.ts";
import { loadReducerConfig, reduceToolResult } from "../src/sol-pi/extensions/evidence-preserving-reducer/index.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof fs>();
	return { ...actual, lstat: vi.fn(actual.lstat), realpath: vi.fn(actual.realpath), readFile: vi.fn(actual.readFile), open: vi.fn(actual.open) };
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

it.each(["open", "stat", "read", "close"] as const)("rejects the preview when full-output %s fails", async (operation) => {
	const path = await outputFile("diagnostic output");
	if (operation === "open") {
		vi.mocked(fs.open).mockRejectedValueOnce(new Error("open failed"));
		expect((await reducibleToolResult(event(path), maxChars))?.body).toBeUndefined();
		return;
	}
	const open = vi.mocked(fs.open).getMockImplementation()!;
	const handle = await open(path, "r");
	vi.mocked(fs.open).mockResolvedValueOnce(handle);
	const realClose = handle.close.bind(handle);
	const close = vi.spyOn(handle, "close");
	if (operation === "close") {
		close.mockImplementationOnce(async () => {
			await realClose();
			throw new Error("close failed");
		});
	} else {
		vi.spyOn(handle, operation).mockRejectedValueOnce(new Error(`${operation} failed`));
	}
	expect((await reducibleToolResult(event(path), maxChars))?.body).toBeUndefined();
	expect(close).toHaveBeenCalledOnce();
});

it("rejects a log truncated after the first read even when its prefix fits the limit", async () => {
	const path = await outputFile("x".repeat(100_000));
	const handle = await fs.open(path, "r");
	vi.mocked(fs.open).mockResolvedValueOnce(handle);
	const read = handle.read.bind(handle);
	vi.spyOn(handle, "read").mockImplementationOnce(async (...args: Parameters<typeof read>) => {
		const result = await read(...args);
		expect(result.bytesRead).toBe(65_536);
		await fs.truncate(path, result.bytesRead);
		return result;
	});
	const close = vi.spyOn(handle, "close");
	expect((await reducibleToolResult(event(path), maxChars))?.body).toBeUndefined();
	expect(close).toHaveBeenCalledOnce();
});

it.each(["grow", "truncate", "rewrite", "stat failure"])("rejects full-output changes at EOF: %s", async (change) => {
	const path = await outputFile("diagnostic output");
	const handle = await fs.open(path, "r");
	vi.mocked(fs.open).mockResolvedValueOnce(handle);
	const read = handle.read.bind(handle);
	vi.spyOn(handle, "read").mockImplementation(async (...args: Parameters<typeof read>) => {
		const result = await read(...args);
		if (result.bytesRead === 0) {
			if (change === "grow") await fs.appendFile(path, "more output");
			else if (change === "truncate") await fs.truncate(path, 1);
			else if (change === "rewrite") {
				await fs.writeFile(path, "DIAGNOSTIC OUTPUT");
				await fs.utimes(path, new Date(0), new Date(0));
			} else vi.spyOn(handle, "stat").mockRejectedValueOnce(new Error("stat failed"));
		}
		return result;
	});
	const close = vi.spyOn(handle, "close");
	expect((await reducibleToolResult(event(path), maxChars))?.body).toBeUndefined();
	expect(close).toHaveBeenCalledOnce();
});

it.each(["lstat", "realpath"] as const)("rejects the preview if Pi output path validation fails at %s", async (operation) => {
	const path = await outputFile("diagnostic output");
	vi.mocked(fs[operation]).mockRejectedValueOnce(new Error(`${operation} failed`));
	expect((await reducibleToolResult(event(path), maxChars))?.body).toBeUndefined();
	expect(fs.open).not.toHaveBeenCalled();
});

it.each(["bash", "write", "edit"])("does not archive or reduce a long %s preview when full-output open fails", async (tool) => {
	const path = await outputFile("diagnostic output");
	vi.mocked(fs.open).mockRejectedValueOnce(new Error("open failed"));
	const input = event(path, tool);
	if (tool !== "bash") input.details = {};
	input.content[0] = { type: "text", text: `${tool === "bash" ? "" : "[then_run:succeeded]\n"}${"preview\n".repeat(1000)}[Full output: ${path}]` };
	const journal = vi.fn();
	const config = loadReducerConfig(tmpdir());
	const context = new Proxy({} as ExtensionContext, {
		get() { throw new Error("unavailable source must not reach model context"); },
	});
	expect(await reduceToolResult(journal, config, input, context)).toBeUndefined();
	expect(journal.mock.calls).toEqual([
		["fallback", { reason: "source-unavailable-or-over-max-chars", maxChars: config.maxChars }],
	]);
});

it("accepts a stable log delivered through short reads before EOF", async () => {
	const body = "diagnostic output 中😀";
	const path = await outputFile(body);
	const handle = await fs.open(path, "r");
	vi.mocked(fs.open).mockResolvedValueOnce(handle);
	const read = handle.read.bind(handle);
	vi.spyOn(handle, "read").mockImplementation(async (buffer) => {
		if (!Buffer.isBuffer(buffer)) throw new Error("expected a read buffer");
		return read(buffer, 0, 7, null);
	});
	expect((await reducibleToolResult(event(path), maxChars))?.body).toBe(body);
});
