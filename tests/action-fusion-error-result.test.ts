/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createActionFusionExtension } from "../src/sol-pi/extensions/action-fusion/index.ts";

// Pi >= 1.0 resolves a non-zero shell exit as a tool result with `isError: true`
// instead of rejecting. Shim the bash tool so this contract is covered on every
// supported Pi release, not only on releases that already use the result form.
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return {
		...actual,
		createBashToolDefinition: () => ({
			name: "bash",
			execute: async () => ({
				content: [{ type: "text", text: "Command exited with code 7" }],
				details: undefined,
				isError: true,
			}),
		}),
	};
});

type FusedTools = { edit: ToolDefinition; write: ToolDefinition };

function loadFusedTools(): FusedTools {
	const registered = new Map<string, ToolDefinition>();
	const pi = {
		registerTool: (tool: ToolDefinition) => registered.set(tool.name, tool),
	} as unknown as ExtensionAPI;
	createActionFusionExtension()(pi);
	const edit = registered.get("edit");
	const write = registered.get("write");
	if (!edit || !write) throw new Error("action fusion did not register edit and write");
	return { edit, write };
}

function createContext(cwd: string): ExtensionContext {
	return {
		mode: "json",
		hasUI: false,
		cwd,
		model: undefined,
		sessionManager: {
			getSessionFile: () => undefined,
			getSessionId: () => "action-fusion-error-result-test",
		},
		ui: {},
	} as unknown as ExtensionContext;
}

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-then-run-error-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	vi.restoreAllMocks();
});

describe("then_run failure reported as an error result", () => {
	it("fails the fused call and keeps the mutation when bash resolves isError", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "preserved.txt");
		const { write } = loadFusedTools();

		await expect(
			write.execute(
				"write-error-result",
				{ path: filePath, content: "keep me\n", then_run: { command: "exit 7" } },
				undefined,
				undefined,
				createContext(dir),
			),
		).rejects.toThrow("[then_run:failed]");
		expect(await readFile(filePath, "utf8")).toBe("keep me\n");
	});
});