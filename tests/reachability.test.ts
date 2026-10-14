/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/sol-pi/config.ts";
import { createSolPiExtension } from "../src/sol-pi/index.ts";
import { registerActionFusion } from "../src/sol-pi/extensions/action-fusion/index.ts";
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

const fusedPi = new FakePi();
registerActionFusion(fusedPi.asExtensionApi());
const thenRunParameters = fusedPi.registeredTools.find((tool) => tool.name === "edit")!.parameters;

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
	it.each(["edit", "write"])("accepts active fused %s as a reducer path without bash", (name) => {
		const tool = fusedPi.registeredTools.find((tool) => tool.name === name)!;
		expect(reachabilityFindings(config({ actionFusion: true, evidencePreservingReducer: true }),
			surface([tool]))).toEqual([]);
	});

	it.each(["fabric_exec", "edit", "write"])("rejects unrelated %s with its own then_run", (name) => {
		const parameters = Type.Object({ then_run: Type.Optional(Type.String()) });
		const findings = reachabilityFindings(config({ actionFusion: true, evidencePreservingReducer: true }),
			surface([{ name, parameters }], [{ name, parameters }, ...fusedPi.registeredTools]));
		expect(findings.map((finding) => finding.reason)).toEqual([
			"then_run-not-on-active-tools", "reducer-path-absent",
		]);
	});

	it("does not persist provisional session-start warnings", async () => {
		const pi = new FakePi();
		installToolSurface(pi, [{ name: "fabric_exec", parameters: plainParameters }]);
		createSolPiExtension(() => config({ actionFusion: true, evidencePreservingReducer: true }))(pi.asExtensionApi());
		pi.on("session_start", () => installToolSurface(pi, pi.registeredTools));
		const ctx = fakeContext(pi.sessionManager);
		await pi.emit("session_start", {}, ctx);
		expect(pi.sessionManager.customEntryData()).toEqual([]);
		await pi.emit("before_provider_request", {}, ctx);
		expect(pi.sessionManager.customEntryData()).toEqual([]);
	});

	it("re-appends on a new branch and keeps inherited warnings deduplicated", async () => {
		const pi = new FakePi();
		installToolSurface(pi, [{ name: "fabric_exec", parameters: plainParameters }]);
		const ctx = fakeContext(pi.sessionManager);
		watchMechanismReachability(pi.asExtensionApi(), config({ actionFusion: true }));
		await pi.emit("before_provider_request", {}, ctx);
		const originalBranch = [...pi.sessionManager.entries];
		// Model tree navigation to an ancestor that does not contain the warning.
		pi.sessionManager.entries.splice(0);
		await pi.emit("session_tree", {}, ctx);
		await pi.emit("before_provider_request", {}, ctx);
		expect(pi.sessionManager.customEntryData()).toHaveLength(1);
		// Navigating back to the original branch must not duplicate its warning.
		pi.sessionManager.entries.splice(0, pi.sessionManager.entries.length, ...originalBranch);
		await pi.emit("session_tree", {}, ctx);
		await pi.emit("before_provider_request", {}, ctx);
		expect(pi.sessionManager.customEntryData()).toHaveLength(1);
	});

	it("skips incomplete inspection APIs instead of reporting missing paths", () => {
		const pi = new FakePi();
		installToolSurface(pi, [{ name: "bash" }]);
		(pi as unknown as { getAllTools: () => never }).getAllTools = () => { throw new Error("not ready"); };
		expect(readToolSurface(pi.asExtensionApi())).toBeUndefined();
	});

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
				message: "Action Fusion is enabled but no active SoL-Pi edit/write tool exposes then_run",
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

	it("reports a missing reducer path when neither bash nor fused edit/write is available", () => {
		expect(
			reachabilityFindings(
				config({ evidencePreservingReducer: true }),
				surface([{ name: "edit", parameters: plainParameters }]),
			),
		).toEqual([
			expect.objectContaining({
				mechanism: "evidencePreservingReducer",
				reason: "reducer-path-absent",
				message: "Reducer is enabled but no configured bash or active SoL-Pi fused edit/write path is available",
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
			"⚡ SoL-Pi · Action Fusion is enabled but no active SoL-Pi edit/write tool exposes then_run",
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
			expect.objectContaining({ reason: "reducer-path-absent" }),
		);
	});

	it("checks the final surface at each provider request and deduplicates on the branch", async () => {
		const pi = new FakePi();
		installToolSurface(pi, [{ name: "edit", parameters: thenRunParameters }], ["edit"]);
		const ctx = fakeContext(pi.sessionManager);

		watchMechanismReachability(pi.asExtensionApi(), config({ actionFusion: true }));
		expect(pi.sessionManager.customEntryData()).toEqual([]);
		expect([...pi.handlers.keys()]).toContain("before_provider_request");
		await pi.emit("before_provider_request", {}, ctx);
		expect(pi.sessionManager.customEntryData()).toEqual([]);

		installToolSurface(
			pi,
			[
				{ name: "fabric_exec", parameters: plainParameters },
				{ name: "edit", parameters: thenRunParameters },
			],
			["fabric_exec"],
		);
		await pi.emit("before_provider_request", { type: "before_provider_request" }, ctx);
		await pi.emit("before_provider_request", { type: "before_provider_request" }, ctx);

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
		expect(pi.sessionManager.customEntryData()).toEqual([]);
		await pi.emit("before_provider_request", {}, fakeContext(pi.sessionManager));
		expect(pi.sessionManager.customEntryData()).toContainEqual(
			expect.objectContaining({ reason: "then_run-not-on-active-tools" }),
		);
		expect([...pi.handlers.keys()]).toContain("before_provider_request");
	});
});
