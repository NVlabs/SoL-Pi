/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SolPiConfig } from "./config.ts";

export const REACHABILITY_EVENT_TYPE = "sol-pi-reachability-v1" as const;
export const REACHABILITY_EVENT_SCHEMA = "sol-pi-reachability/1" as const;

export interface ToolSurface {
	readonly name: string;
	readonly parameters?: unknown;
}

export interface ToolSurfaceSnapshot {
	readonly active: readonly ToolSurface[];
	readonly all: readonly ToolSurface[];
}

export interface ReachabilityFinding {
	readonly mechanism: "actionFusion" | "evidencePreservingReducer";
	readonly reason: "then_run-not-on-active-tools" | "bash-tool-absent";
	readonly message: string;
	readonly activeTools: readonly string[];
	readonly allTools: readonly string[];
}

type ReachabilityConfig = Pick<SolPiConfig, "actionFusion" | "evidencePreservingReducer">;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toolExposesThenRun(tool: ToolSurface): boolean {
	if (!isRecord(tool.parameters)) return false;
	const properties = tool.parameters.properties;
	return isRecord(properties) && Object.hasOwn(properties, "then_run");
}

function actionFusionReachable(surface: ToolSurfaceSnapshot): boolean {
	if (surface.active.some(toolExposesThenRun)) return true;
	const sawSchema = surface.active.some((tool) => isRecord(tool.parameters));
	if (sawSchema) return false;
	return surface.active.some((tool) => tool.name === "edit" || tool.name === "write");
}

function callOrEmpty<T>(fn: (() => T) | undefined): T | undefined {
	if (typeof fn !== "function") return undefined;
	try {
		return fn();
	} catch {
		return undefined;
	}
}

/**
 * Read the tools the model can call (`getActiveTools`) and the full configured
 * set (`getAllTools`). Missing or throwing APIs are treated as "not ready"
 * rather than as an empty surface, so Pi 0.81.1 and test doubles without these
 * methods do not emit false warnings.
 */
export function readToolSurface(pi: ExtensionAPI): ToolSurfaceSnapshot | undefined {
	const getAllTools = callOrEmpty(pi.getAllTools?.bind(pi));
	const getActiveTools = callOrEmpty(pi.getActiveTools?.bind(pi));
	if (getAllTools === undefined && getActiveTools === undefined) return undefined;

	const all = Array.isArray(getAllTools) ? getAllTools : [];
	const allByName = new Map(all.map((tool) => [tool.name, tool] as const));
	const activeNames = Array.isArray(getActiveTools) ? getActiveTools : all.map((tool) => tool.name);
	const active = activeNames.map((name) => allByName.get(name) ?? { name });
	if (all.length === 0 && active.length === 0) return undefined;
	return { active, all };
}

export function reachabilityFindings(
	config: ReachabilityConfig,
	surface: ToolSurfaceSnapshot,
): ReachabilityFinding[] {
	const activeTools = surface.active.map((tool) => tool.name);
	const allTools = surface.all.map((tool) => tool.name);
	const findings: ReachabilityFinding[] = [];

	if (config.actionFusion && !actionFusionReachable(surface)) {
		findings.push({
			mechanism: "actionFusion",
			reason: "then_run-not-on-active-tools",
			message: "Action Fusion is enabled but the tool the model calls does not expose then_run",
			activeTools,
			allTools,
		});
	}

	if (config.evidencePreservingReducer && !surface.all.some((tool) => tool.name === "bash")) {
		findings.push({
			mechanism: "evidencePreservingReducer",
			reason: "bash-tool-absent",
			message: "Reducer is enabled but no tool in this session reports as bash",
			activeTools,
			allTools,
		});
	}

	return findings;
}

function emitFinding(pi: ExtensionAPI, ctx: ExtensionContext, finding: ReachabilityFinding): void {
	try {
		pi.appendEntry(REACHABILITY_EVENT_TYPE, {
			schema: REACHABILITY_EVENT_SCHEMA,
			kind: "warning",
			...finding,
		});
	} catch {
		// Ephemeral sessions have nowhere to persist the diagnostic.
	}
	if (ctx.mode !== "tui") return;
	try {
		ctx.ui.notify(`⚡ SoL-Pi · ${finding.message}`, "warning");
	} catch {
		// Presentation is best-effort; the session entry is the durable record.
	}
}

export function inspectMechanismReachability(
	pi: ExtensionAPI,
	config: ReachabilityConfig,
	ctx: ExtensionContext,
	warned: Set<string> = new Set(),
): ReachabilityFinding[] {
	if (!config.actionFusion && !config.evidencePreservingReducer) return [];
	const surface = readToolSurface(pi);
	if (!surface) return [];
	const emitted: ReachabilityFinding[] = [];
	for (const finding of reachabilityFindings(config, surface)) {
		if (warned.has(finding.reason)) continue;
		warned.add(finding.reason);
		emitFinding(pi, ctx, finding);
		emitted.push(finding);
	}
	return emitted;
}

/**
 * Inspect once after SoL-Pi registers its tools, then once more on the first
 * `before_agent_start`. The second pass catches a later-loaded extension that
 * replaces the model-visible tool surface after `session_start`.
 */
export function watchMechanismReachability(
	pi: ExtensionAPI,
	config: ReachabilityConfig,
	ctx: ExtensionContext,
): void {
	if (!config.actionFusion && !config.evidencePreservingReducer) return;
	const warned = new Set<string>();
	inspectMechanismReachability(pi, config, ctx, warned);
	let probed = false;
	pi.on("before_agent_start", (_event, agentCtx) => {
		if (probed) return;
		probed = true;
		inspectMechanismReachability(pi, config, agentCtx, warned);
	});
}
