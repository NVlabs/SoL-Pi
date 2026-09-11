/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { resolveToolPath } from "../src/sol-pi/extensions/action-fusion/file-queue.ts";
import { createActionFusionExtension, type ActionFusionOptions } from "../src/sol-pi/extensions/action-fusion/index.ts";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "action-fusion-paths-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function loadTools(options: ActionFusionOptions = {}): Map<string, ToolDefinition> {
	const tools = new Map<string, ToolDefinition>();
	createActionFusionExtension(options)({ registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool) } as unknown as ExtensionAPI);
	return tools;
}

function context(cwd: string): ExtensionContext {
	return {
		cwd,
		mode: "json",
		hasUI: false,
		model: undefined,
		sessionManager: { getSessionId: () => "action-fusion-paths", getSessionFile: () => undefined },
		ui: {},
	} as ExtensionContext;
}

describe("Action Fusion file URL paths", () => {
	it.each(["target.txt", "space and #hash %.txt"])("resolves a file URL and @file URL for %s", (name) => {
		const cwd = join(tmpdir(), "action-fusion-cwd");
		const target = resolve(tmpdir(), name);
		const url = pathToFileURL(target).href;
		expect(resolveToolPath(cwd, url)).toBe(target);
		expect(resolveToolPath(cwd, `@${url}`)).toBe(target);
	});

	it("preserves ordinary relative and absolute path semantics", () => {
		const cwd = join(tmpdir(), "action-fusion-cwd");
		const target = join(cwd, "target.txt");
		expect(resolveToolPath(cwd, "target.txt")).toBe(target);
		expect(resolveToolPath(cwd, "@target.txt")).toBe(target);
		expect(resolveToolPath(cwd, target)).toBe(target);
	});

	it.each([
		{ name: "write", prefix: "" }, { name: "edit", prefix: "" },
		{ name: "write", prefix: "@" }, { name: "edit", prefix: "@" },
	])("runs then_run after a real $name through an escaped $prefix file URL", async ({ name, prefix }) => {
		const cwd = await createTempDir();
		const target = join(cwd, "space and #hash %.txt");
		if (name === "edit") await writeFile(target, "before\n");
		const commands: string[] = [];
		const tools = loadTools({
			bashOptions: { operations: { exec: async (command, commandCwd) => {
				commands.push(command);
				expect(commandCwd).toBe(cwd);
				expect(await readFile(target, "utf8")).toBe("after\n");
				return { exitCode: 0 };
			} } },
		});
		const input = {
			path: `${prefix}${pathToFileURL(target).href}`,
			...(name === "write" ? { content: "after\n" } : { edits: [{ oldText: "before", newText: "after" }] }),
			then_run: { command: "check target" },
		};
		const result = await tools.get(name)!.execute("file-url", input, undefined, undefined, context(cwd));
		expect(commands).toEqual(["check target"]);
		expect(result.content).toContainEqual({
			type: "text",
			text: expect.stringMatching(/^\[then_run:succeeded\](?:\n|$)/),
		});
		expect(await readFile(target, "utf8")).toBe("after\n");
	});

	it("executes a real bash follow-up after writing through a file URL", async () => {
		const cwd = await createTempDir();
		const target = join(cwd, "real-command.txt");
		const result = await loadTools().get("write")!.execute("real-command", {
			path: pathToFileURL(target).href,
			content: "written\n",
			then_run: { command: "printf FILE_URL_THEN_RUN_OK" },
		}, undefined, undefined, context(cwd));
		const output = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
		expect(output).toContain("[then_run:succeeded]");
		expect(output).toContain("FILE_URL_THEN_RUN_OK");
		expect(await readFile(target, "utf8")).toBe("written\n");
	});

	it("serializes a file URL and ordinary path to the same file through then_run", async () => {
		const cwd = await createTempDir();
		const target = join(cwd, "shared file.txt");
		const events: string[] = [];
		let signalStarted!: () => void;
		let releaseCommand!: () => void;
		const started = new Promise<void>((resolveStarted) => { signalStarted = resolveStarted; });
		const blocked = new Promise<void>((resolveBlocked) => { releaseCommand = resolveBlocked; });
		const tools = loadTools({
			writeOptions: { operations: { mkdir: async () => {}, writeFile: async (path, content) => {
				events.push(`write:${content}`);
				await writeFile(path, content);
			} } },
			bashOptions: { operations: { exec: async () => {
				events.push("command:start");
				signalStarted();
				await blocked;
				events.push("command:end");
				return { exitCode: 0 };
			} } },
		});
		const write = tools.get("write")!;
		const first = write.execute("url", { path: pathToFileURL(target).href, content: "first", then_run: { command: "block" } }, undefined, undefined, context(cwd));
		// Propagate an early failure instead of waiting forever for the command.
		await Promise.race([started, first]);
		const second = write.execute("ordinary", { path: target, content: "second" }, undefined, undefined, context(cwd));
		try {
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
			expect(events).toEqual(["write:first", "command:start"]);
		} finally {
			releaseCommand();
			await Promise.all([first, second]);
		}
		expect(events).toEqual(["write:first", "command:start", "command:end", "write:second"]);
		expect(await readFile(target, "utf8")).toBe("second");
	});

	it("does not run a command or create a file for an invalid encoded file URL", async () => {
		const cwd = await createTempDir();
		let mutations = 0;
		let commands = 0;
		const tools = loadTools({
			writeOptions: { operations: { mkdir: async () => {}, writeFile: async () => { mutations++; } } },
			bashOptions: { operations: { exec: async () => { commands++; return { exitCode: 0 }; } } },
		});
		const invalidUrl = `${pathToFileURL(cwd).href}/bad%2Fname.txt`;
		await expect(tools.get("write")!.execute("invalid", { path: invalidUrl, content: "unused", then_run: { command: "must not run" } }, undefined, undefined, context(cwd))).rejects.toThrow();
		expect(mutations).toBe(0);
		expect(commands).toBe(0);
	});
});
