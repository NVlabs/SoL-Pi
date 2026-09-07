/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { renderSolPiTool } from "../../tui.ts";
import { PLAN_STATUSES, type PlanStep } from "./plan.ts";

export type PlanProgress = {
	readonly files_changed: readonly string[];
	readonly verification: readonly string[];
	readonly decisions: readonly string[];
};

export type PlanUpdateInput = {
	readonly toolCallId: string;
	readonly steps: readonly PlanStep[];
	readonly progress: PlanProgress | undefined;
	readonly signal: AbortSignal | undefined;
	readonly context: ExtensionContext;
};

export type OnlineToolHandlers = {
	readonly updatePlan: (input: PlanUpdateInput) => Promise<AgentToolResult<Readonly<Record<string, unknown>>>>;
};

const progressSchema = Type.Object(
	{
		files_changed: Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 128 }),
		verification: Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 64 }),
		decisions: Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 64 }),
	},
	{ additionalProperties: false },
);

const planStepSchema = Type.Object(
	{
		id: Type.String({ minLength: 1, maxLength: 16_384 }),
		goal: Type.String({ minLength: 1, maxLength: 16_384 }),
		status: Type.Union(PLAN_STATUSES.map((status) => Type.Literal(status))),
	},
	{ additionalProperties: false },
);

export function registerOnlineTools(pi: ExtensionAPI, handlers: OnlineToolHandlers): void {
	pi.registerTool({
		name: "update_plan",
		label: "Update plan",
		description:
			"Replace the complete working plan. A newly completed step becomes a safe point where SoL-Pi may compact context if doing so is economical.",
		promptSnippet: "Keep the working plan current",
		promptGuidelines: [
			"Send the complete plan on every update_plan call.",
			"Keep at most one step in_progress and mark finished steps completed.",
			"When completing a step, include concise progress evidence when available.",
		],
		renderShell: "self",
		parameters: Type.Object(
			{
				steps: Type.Array(planStepSchema, { minItems: 1, maxItems: 128 }),
				progress: Type.Optional(progressSchema),
			},
			{ additionalProperties: false },
		),
		executionMode: "sequential",
		execute: async (toolCallId, params, signal, _onUpdate, context) =>
			await handlers.updatePlan({
				toolCallId,
				steps: params.steps,
				progress: params.progress,
				signal,
				context,
			}),
		renderCall(params, theme) {
			const completed = params.steps.filter((step) => step.status === "completed").length;
			return renderSolPiTool(
				theme,
				"Online Context Compact",
				"compacts only when projected savings are positive",
				new Text(theme.fg("dim", `Plan: ${params.steps.length} steps, ${completed} completed`), 0, 0),
			);
		},
		renderResult(result, { isPartial }, theme) {
			const boundary = (result.details as { boundary?: boolean } | undefined)?.boundary === true;
			return renderSolPiTool(
				theme,
				"Online Context Compact",
				"compacts only when projected savings are positive",
				new Text(
					theme.fg(isPartial ? "warning" : "dim", isPartial ? "Updating plan..." : boundary ? "Progress boundary recorded" : "Plan recorded"),
					0,
					0,
				),
			);
		},
	});
}
