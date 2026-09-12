/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/sol-pi/config.ts";
import { createSolPiExtension } from "../src/sol-pi/index.ts";
import {
	REACHABILITY_EVENT_SCHEMA,
	REACHABILITY_EVENT_TYPE,
	inspectMechanismReachability,
	reachabilityFindings,
	readToolSurface,
	toolExposesThenRun,
	watchMechanismReachability,
	type ToolSurface,
} from "../src/sol-pi/reachability.ts";
import { FakePi, fakeContext } from "./helpers.ts";

const thenRunParameters = Type.Object({
	path: Type.String(),
	then_run: Type.Optional(Type.Object({ command: Type.String() })),
});

const plainParameters = Type.Object({
	code: Type.String(),
});

function surface(active: ToolSurface[], all: ToolSurface[] = active) {
	return { active, all };
}

function config(overrides: Partial<typeof DEFAULT_CONFIG> = {}) {
	return { ...DEFAULT_CONFIG, ...overrides };
}

function installToolSurface(
	pi: FakePi,
	all: ToolSurface[],
	active: string[] = all.map((tool) => tool.name),
): void {
	(pi as FakePi & { getAllTools: () => ToolSurface[]; getActiveTools: () => string[] }).getAllTools = () => all;
	(pi as FakePi & { getActiveTools: () => string[] }).getActiveTools = () => active;
}

describe("mechanism reachability", () => {
	it("detects then_run on a TypeBox tool schema", () => {
		expect(toolExposesThenRun({ name: "edit", parameters: thenRunParameters })).toBe(true);
		expect(toolExposesThenRun({ name: "fabric_exec", parameters: plainParameters })).toBe(false);
		expect(toolExposesThenRun({ name: "edit" })).toBe(false);
	});

	it("keeps Action Fusion reachable when an active tool exposes then_run", () => {
		expect(
			reachabilityFindings(
				config({ actionFusion: true }),
				surface(
					[{ name: "edit", parameters: thenRunParameters }],
					[
						{ name: "edit", parameters: thenRunParameters },
						{ name: "bash", parameters: Type.Object({ command: Type.String() }) },
					],
				),
			),
		).toEqual([]);
	});

	it("reports Action Fusion inert when the model-visible tools omit then_run", () => {
		expect(
			reachabilityFindings(
				config({ actionFusion: true }),
				surface(
					[{ name: "fabric_exec", parameters: plainParameters }],
					[
						{ name: "fabric_exec", parameters: plainParameters },
						{ name: "edit", parameters: thenRunParameters },
						{ name: "write", parameters: thenRunParameters },
						{ name: "bash" },
					],
				),
			),
		).toEqual([
			expect.objectContaining({
				mechanism: "actionFusion",
				reason: "then_run-not-on-active-tools",
				message: "Action Fusion is enabled but the tool the model calls does not expose then_run",
				activeTools: ["fabric_exec"],
			}),
		]);
	});

	it("treats inactive bash as enough for the reducer", () => {
		expect(
			reachabilityFindings(
				config({ evidencePreservingReducer: true }),
				surface([{ name: "fabric_exec", parameters: plainParameters }], [
					{ name: "fabric_exec", parameters: plainParameters },
					{ name: "bash" },
				]),
			),
		).toEqual([]);
	});

	it("reports the reducer inert when no tool is named bash", () => {
		expect(
			reachabilityFindings(
				config({ evidencePreservingReducer: true }),
				surface([{ name: "edit", parameters: thenRunParameters }]),
			),
		).toEqual([
			expect.objectContaining({
				mechanism: "evidencePreservingReducer",
				reason: "bash-tool-absent",
				message: "Reducer is enabled but no tool in this session reports as bash",
			}),
		]);
	});

	it("skips inspection when the tool-surface APIs are missing", () => {
		const pi = new FakePi();
		const ctx = fakeContext(pi.sessionManager);
		expect(readToolSurface(pi.asExtensionApi())).toBeUndefined();
		expect(inspectMechanismReachability(pi.asExtensionApi(), config({ actionFusion: true }), ctx)).toEqual([]);
		expect(pi.sessionManager.customEntryData()).toEqual([]);
	});

	it("writes one session entry and a TUI warning when Action Fusion is unreachable", () => {
		const pi = new FakePi();
		installToolSurface(
			pi,
			[
				{ name: "fabric_exec", parameters: plainParameters },
				{ name: "edit", parameters: thenRunParameters },
				{ name: "bash" },
			],
			["fabric_exec"],
		);
		const notify = vi.fn();
		const ctx = fakeContext(pi.sessionManager, {
			mode: "tui",
			ui: { notify } as unknown as ExtensionContext["ui"],
		});

		const findings = inspectMechanismReachability(
			pi.asExtensionApi(),
			config({ actionFusion: true }),
			ctx,
		);

		expect(findings).toHaveLength(1);
		expect(pi.sessionManager.customEntryData()).toEqual([
			expect.objectContaining({
				schema: REACHABILITY_EVENT_SCHEMA,
				kind: "warning",
				reason: "then_run-not-on-active-tools",
			}),
		]);
		expect(pi.sessionManager.entries[0]).toMatchObject({ customType: REACHABILITY_EVENT_TYPE });
		expect(notify).toHaveBeenCalledWith(
			"⚡ SoL-Pi · Action Fusion is enabled but the tool the model calls does not expose then_run",
			"warning",
		);
	});

	it("does not notify outside TUI mode", () => {
		const pi = new FakePi();
		installToolSurface(pi, [{ name: "edit" }], ["edit"]);
		const notify = vi.fn();
		const ctx = fakeContext(pi.sessionManager, {
			mode: "json",
			ui: { notify } as unknown as ExtensionContext["ui"],
		});

		inspectMechanismReachability(pi.asExtensionApi(), config({ evidencePreservingReducer: true }), ctx);

		expect(notify).not.toHaveBeenCalled();
		expect(pi.sessionManager.customEntryData()).toContainEqual(
			expect.objectContaining({ reason: "bash-tool-absent" }),
		);
	});

	it("rechecks on the first before_agent_start after another extension replaces the surface", async () => {
		const pi = new FakePi();
		installToolSurface(pi, [{ name: "edit", parameters: thenRunParameters }], ["edit"]);
		const ctx = fakeContext(pi.sessionManager);

		watchMechanismReachability(pi.asExtensionApi(), config({ actionFusion: true }), ctx);
		expect(pi.sessionManager.customEntryData()).toEqual([]);
		expect([...pi.handlers.keys()]).toContain("before_agent_start");

		installToolSurface(
			pi,
			[
				{ name: "fabric_exec", parameters: plainParameters },
				{ name: "edit", parameters: thenRunParameters },
			],
			["fabric_exec"],
		);
		await pi.emit("before_agent_start", { type: "before_agent_start" }, ctx);
		await pi.emit("before_agent_start", { type: "before_agent_start" }, ctx);

		expect(pi.sessionManager.customEntryData()).toEqual([
			expect.objectContaining({ reason: "then_run-not-on-active-tools" }),
		]);
	});

	it("wires the probe from session_start when Action Fusion is enabled", async () => {
		const pi = new FakePi();
		installToolSurface(pi, [{ name: "fabric_exec", parameters: plainParameters }], ["fabric_exec"]);
		createSolPiExtension(() => config({ actionFusion: true }))(pi.asExtensionApi());

		await pi.emit("session_start", { type: "session_start" }, fakeContext(pi.sessionManager));

		expect(pi.registeredTools.map((tool) => tool.name)).toEqual(["edit", "write"]);
		expect(pi.sessionManager.customEntryData()).toContainEqual(
			expect.objectContaining({ reason: "then_run-not-on-active-tools" }),
		);
		expect([...pi.handlers.keys()]).toContain("before_agent_start");
	});
});
