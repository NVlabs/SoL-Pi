/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActionFusionExtension } from "../src/sol-pi/extensions/action-fusion/index.ts";

const { createBash, executeBash } = vi.hoisted(() => ({ createBash: vi.fn(), executeBash: vi.fn() }));

// Exercise returned errors even with Pi versions whose real bash tool throws.
// Keep the real edit/write definitions and file mutations in these tests.
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
	return { ...actual, createBashToolDefinition: createBash };
});

const tempDirs: string[] = [];

beforeEach(() => {
	executeBash.mockReset();
	createBash.mockReset().mockReturnValue({ execute: executeBash });
});

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function prepare(toolName: "edit" | "write", withThenRun = true) {
	const cwd = await mkdtemp(join(tmpdir(), "sol-pi-error-result-"));
	tempDirs.push(cwd);
	const path = join(cwd, "target.txt");
	await writeFile(path, "before\n");
	const tools = new Map<string, ToolDefinition>();
	createActionFusionExtension()({
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
	} as unknown as ExtensionAPI);
	const notify = vi.fn();
	const setStatus = vi.fn();
	const ctx = {
		cwd,
		mode: "tui",
		hasUI: true,
		ui: { notify, setStatus },
	} as unknown as ExtensionContext;
	const signal = new AbortController().signal;
	const thenRun = { command: "check the mutation", timeout: 12 };
	const mutation = toolName === "write"
		? { path, content: "after\n" }
		: { path, edits: [{ oldText: "before", newText: "after" }] };
	return {
		path, ctx, signal, thenRun, notify, setStatus,
		run: () => tools.get(toolName)!.execute(
			"fused-call",
			{ ...mutation, ...(withThenRun ? { then_run: thenRun } : {}) },
			signal,
			undefined,
			ctx as never,
		),
	};
}

describe("action fusion returned bash errors", () => {
	it.each(["edit", "write"] as const)("rejects a returned error after %s without undoing the mutation", async (toolName) => {
		const fixture = await prepare(toolName);
		executeBash.mockResolvedValue({
			content: [{ type: "text", text: "validation failed\nCommand exited with code 7" }],
			details: undefined,
			isError: true,
		});

		const call = fixture.run();
		await expect(call).rejects.toThrow("[then_run:failed]");
		await expect(call).rejects.toThrow("validation failed\nCommand exited with code 7");
		await expect(call).rejects.toThrow(toolName === "write" ? "Successfully wrote" : "Successfully replaced");
		const error = await call.catch((error: Error) => error);
		expect(String(error)).not.toContain("[then_run:succeeded]");
		expect(await readFile(fixture.path, "utf8")).toBe("after\n");
		expect(executeBash).toHaveBeenCalledExactlyOnceWith(
			"fused-call:then_run", fixture.thenRun, fixture.signal, undefined, fixture.ctx,
		);
		expect(fixture.notify).not.toHaveBeenCalled();
		expect(fixture.setStatus).not.toHaveBeenCalled();
	});

	it("rejects a returned error with no text output", async () => {
		const fixture = await prepare("write");
		executeBash.mockResolvedValue({ content: [], details: undefined, isError: true });
		await expect(fixture.run()).rejects.toThrow("[then_run:failed]\n\nCommand failed.");
		expect(await readFile(fixture.path, "utf8")).toBe("after\n");
	});

	it.each([
		{ label: "absent", flag: {} },
		{ label: "false", flag: { isError: false } },
	])("preserves success with an $label error flag, regardless of diagnostic-looking output", async ({ flag }) => {
		const fixture = await prepare("write");
		const output = "validation failed\nCommand exited with code 7";
		executeBash.mockResolvedValue({ content: [{ type: "text", text: output }], details: undefined, ...flag });
		const result = await fixture.run();
		expect(result.content.at(-1)).toEqual({ type: "text", text: `[then_run:succeeded]\n${output}` });
		expect(await readFile(fixture.path, "utf8")).toBe("after\n");
		expect(fixture.notify).toHaveBeenCalledTimes(1);
	});

	it("preserves the existing failure path for a throwing bash tool", async () => {
		const fixture = await prepare("write");
		executeBash.mockRejectedValue(new Error("legacy command failure"));
		await expect(fixture.run()).rejects.toThrow("[then_run:failed]\n\nlegacy command failure");
		expect(await readFile(fixture.path, "utf8")).toBe("after\n");
		expect(fixture.notify).not.toHaveBeenCalled();
	});

	it("does not construct or execute bash without then_run", async () => {
		const fixture = await prepare("write", false);
		const result = await fixture.run();
		expect(result.content).toHaveLength(1);
		expect(JSON.stringify(result)).not.toContain("[then_run:");
		expect(createBash).not.toHaveBeenCalled();
		expect(executeBash).not.toHaveBeenCalled();
		expect(await readFile(fixture.path, "utf8")).toBe("after\n");
	});
});
