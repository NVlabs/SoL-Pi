/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "../src/sol-pi/config.ts";
import { registerConfiguredFeatures } from "../src/sol-pi/index.ts";
import { loadActionFusionBashOptions } from "../src/sol-pi/shell-options.ts";
import type { ToolExecuteContext } from "./helpers.ts";

const roots: string[] = [];
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "sol-pi-shell-options-"));
	roots.push(root);
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir);
	mkdirSync(cwd);
	return { agentDir, cwd };
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Action Fusion inherits Pi shell settings", () => {
	it("passes a non-default Windows Git Bash path and command prefix", () => {
		const { agentDir, cwd } = fixture();
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
			shellPath: "D:/Environment/Git/bin/bash.exe",
			shellCommandPrefix: "export CI=1",
		}));
		expect(loadActionFusionBashOptions(cwd, false, agentDir)).toEqual({
			shellPath: "D:/Environment/Git/bin/bash.exe",
			commandPrefix: "export CI=1",
		});
	});

	it("only honors project shell overrides after project trust", () => {
		const { agentDir, cwd } = fixture();
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ shellPath: "/global/bash" }));
		mkdirSync(join(cwd, CONFIG_DIR_NAME));
		writeFileSync(join(cwd, CONFIG_DIR_NAME, "settings.json"), JSON.stringify({
			shellPath: "/project/bash",
			shellCommandPrefix: "export PROJECT=1",
		}));
		expect(loadActionFusionBashOptions(cwd, false, agentDir)).toEqual({
			shellPath: "/global/bash", commandPrefix: undefined,
		});
		expect(loadActionFusionBashOptions(cwd, true, agentDir)).toEqual({
			shellPath: "/project/bash", commandPrefix: "export PROJECT=1",
		});
	});

	it("retains platform defaults when no shell override exists", () => {
		const { agentDir, cwd } = fixture();
		expect(loadActionFusionBashOptions(cwd, false, agentDir)).toEqual({
			shellPath: undefined, commandPrefix: undefined,
		});
	});

	it("does not silently fall back to WSL after malformed settings", () => {
		const { agentDir, cwd } = fixture();
		writeFileSync(join(agentDir, "settings.json"), "{not-json");
		expect(() => loadActionFusionBashOptions(cwd, false, agentDir)).toThrow("could not load Pi shell settings");
	});

	it("forwards shell options through configured feature registration into then_run", async () => {
		const { cwd } = fixture();
		const tools = new Map<string, ToolDefinition>();
		const commands: string[] = [];
		const pi = { registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool) } as unknown as ExtensionAPI;
		registerConfiguredFeatures(pi, { ...DEFAULT_CONFIG, actionFusion: true }, {
			commandPrefix: "export CI=1",
			operations: { exec: async (command, runCwd, { onData }) => {
				expect(runCwd).toBe(cwd);
				commands.push(command);
				onData(Buffer.from("native follow-up passed\n"));
				return { exitCode: 0 };
			} },
		});
		const tool = tools.get("write");
		if (!tool) throw new Error("write was not registered");
		const ctx = {
			mode: "json", hasUI: false, cwd, model: undefined, ui: {},
			sessionManager: { getSessionFile: () => undefined, getSessionId: () => "shell-options-test" },
		} as unknown as ToolExecuteContext;
		const result = await tool.execute("write-shell-options", {
			path: "native.txt", content: "native\n", then_run: { command: "printf native" },
		}, undefined, undefined, ctx);
		expect(commands).toEqual(["export CI=1\nprintf native"]);
		expect(result.content.some((block) => block.type === "text" && block.text.includes("[then_run:succeeded]"))).toBe(true);
	});
});
