/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it, vi } from "vitest";
import type * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ToolDefinition, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { createActionFusionExtension } from "../src/sol-pi/extensions/action-fusion/index.ts";
import { componentText, plainTheme } from "./helpers.ts";

/**
 * `renderCall` and `renderResult` are optional on Pi's `ToolDefinition`. A
 * Pi-compatible host may ship edit/write without them, so fuse against
 * built-ins that provide everything but the renderers.
 */
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const original = await importOriginal<typeof PiCodingAgent>();
	const stripRenderers = <TArgs extends never[], TTool extends object>(create: (...args: TArgs) => TTool) => {
		return (...args: TArgs): TTool => {
			const { renderCall: _call, renderResult: _result, ...rest } = create(...args) as TTool & ToolRenderers;
			return rest as unknown as TTool;
		};
	};
	return {
		...original,
		createEditToolDefinition: stripRenderers(original.createEditToolDefinition),
		createWriteToolDefinition: stripRenderers(original.createWriteToolDefinition),
	};
});

function loadFusedTools(): { edit: ToolDefinition; write: ToolDefinition } {
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

describe("action fusion renderers on a host without built-in renderers", () => {
	const cwd = process.cwd();
	const result = { content: [{ type: "text" as const, text: "ok" }], details: undefined };

	it("renders the savings banner for a fused call without the built-in renderers", () => {
		const { edit, write } = loadFusedTools();
		const cases = [
			{ tool: write, args: { path: "target.ts", content: "export {};\n", then_run: { command: "npm test" } } },
			{
				tool: edit,
				args: { path: "target.ts", edits: [{ oldText: "a", newText: "b" }], then_run: { command: "npm test" } },
			},
		];

		for (const { tool, args } of cases) {
			const context = { args, cwd, isError: false };
			const call = componentText(tool.renderCall!(args, plainTheme, context as never));
			const rendered = componentText(
				tool.renderResult!(result, { expanded: false, isPartial: false }, plainTheme, context as never),
			);

			expect(call).toContain("⚡ SoL-Pi · Action Fusion");
			expect(call).toContain("Money saved · 1 model round-trip avoided");
			expect(rendered).toContain("Money saved · 1 model round-trip avoided");
		}
	});

	it("renders nothing of its own for an unfused call without the built-in renderers", () => {
		const { write } = loadFusedTools();
		const args = { path: "target.ts", content: "export {};\n" };
		const context = { args, cwd, isError: false };

		expect(componentText(write.renderCall!(args, plainTheme, context as never))).toBe("");
		expect(
			componentText(write.renderResult!(result, { expanded: false, isPartial: false }, plainTheme, context as never)),
		).toBe("");
	});
});
