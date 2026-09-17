/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * Action Fusion - fuse a file mutation and its follow-up command into one turn.
 *
 * Base pi rollouts repeatedly showed the same pair of turns: edit or write a
 * file, then run a command to test, build, or start it. This extension replaces
 * the built-in `edit` and `write` tools with versions that take an optional
 * `then_run` object, apply the mutation, run the command, and return one
 * combined observation. The model decision between the two turns disappears.
 *
 * Everything else about `edit` and `write` is inherited from the built-in
 * definitions: their schemas, prompt text, argument shims, and renderers.
 *
 * This standalone version composes only Pi's public tool definitions.
 */

import {
	type BashToolOptions,
	createEditToolDefinition,
	createWriteToolDefinition,
	type EditToolDetails,
	type EditToolOptions,
	type ExtensionAPI,
	type ExtensionFactory,
	type WriteToolOptions,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveToolPath } from "./file-queue.ts";
import { renderSolPiTool, showSolPiSavings } from "../../tui.ts";
import {
	createThenRunSchema,
	executeMutationThenRun,
	THEN_RUN_SUCCEEDED,
	type ThenRunInput,
} from "./then-run.ts";

const EDIT_THEN_RUN_DESCRIPTION =
	"Command to run next on this file after the edit succeeds — e.g. run, build, start/restart, install, or check it; optional timeout in seconds. Skipped if the edit fails; a non-zero exit is reported but keeps the edit.";
const WRITE_THEN_RUN_DESCRIPTION =
	"Command to run next on this file after the write succeeds — e.g. run, build, start/restart, install, or check it; optional timeout in seconds. Skipped if the write fails; a non-zero exit is reported but keeps the write.";

export interface ActionFusionOptions {
	/** Optional programmatic bash overrides, primarily for tests and embedded runtimes. */
	readonly bashOptions?: BashToolOptions;
	/** Overrides for the underlying built-in `edit` tool. */
	readonly editOptions?: EditToolOptions;
	/** Overrides for the underlying built-in `write` tool. */
	readonly writeOptions?: WriteToolOptions;
}

/**
 * Built-in tool definitions capture their cwd in closures, so keep one per
 * working directory instead of rebuilding them on every call and every redraw.
 */
function memoizeByCwd<T>(create: (cwd: string) => T): (cwd: string) => T {
	const cache = new Map<string, T>();
	return (cwd) => {
		const cached = cache.get(cwd);
		if (cached) return cached;
		const created = create(cwd);
		cache.set(cwd, created);
		return created;
	};
}

/**
 * The built-in tool's own parameter properties, which the fused tool re-declares
 * alongside `then_run`.
 *
 * Pi publishes them as a TypeBox `Type.Object`; compatible hosts may expose
 * either a plain JSON Schema object or a callable `toJsonSchema()` value.
 * Preserve JSON Schema's `required` list when rebuilding optional properties.
 * Invalid or throwing host introspection must leave the built-in tool intact.
 */
export function hostToolProperties(parameters: unknown): Record<string, unknown> {
	try {
		if (!parameters || (typeof parameters !== "object" && typeof parameters !== "function")) return {};
		let json = parameters as { properties?: unknown; required?: unknown; toJsonSchema?: () => unknown };
		if ((!json.properties || (typeof json.properties === "object" && Object.keys(json.properties).length === 0)) && typeof json.toJsonSchema === "function") {
			json = json.toJsonSchema() as typeof json;
		}
		if (!json || typeof json !== "object" || !json.properties || typeof json.properties !== "object" || Array.isArray(json.properties)) return {};
		if (json.required !== undefined && (!Array.isArray(json.required) || !json.required.every((key: unknown) => typeof key === "string"))) return {};
		const required = new Set(json.required as string[] | undefined);
		const entries = Object.entries(json.properties);
		if (entries.some(([, schema]) => !schema || typeof schema !== "object" || Array.isArray(schema))) return {};
		return Object.fromEntries(entries.map(([key, schema]) => [
			key,
			required.has(key) ? schema : Type.Optional(schema as never),
		]));
	} catch {
		return {};
	}
}

export function createActionFusionExtension(options: ActionFusionOptions = {}): ExtensionFactory {
	const baseEdit = memoizeByCwd((cwd: string) => createEditToolDefinition(cwd, options.editOptions));
	const baseWrite = memoizeByCwd((cwd: string) => createWriteToolDefinition(cwd, options.writeOptions));

	return (pi: ExtensionAPI) => {
		const editTemplate = baseEdit(process.cwd());
		const writeTemplate = baseWrite(process.cwd());

		// Unchecked cast: on a TypeBox host these are exactly the built-in tool's
		// own properties; on a reduced host they are rebuilt from the same schema,
		// so the fused tool keeps the built-in argument contract either way.
		const editProperties = hostToolProperties(
			editTemplate.parameters,
		) as typeof editTemplate.parameters.properties;
		const writeProperties = hostToolProperties(
			writeTemplate.parameters,
		) as typeof writeTemplate.parameters.properties;

		const editParameters = Type.Object({
			...editProperties,
			then_run: createThenRunSchema(EDIT_THEN_RUN_DESCRIPTION),
		});
		const writeParameters = Type.Object({
			...writeProperties,
			then_run: createThenRunSchema(WRITE_THEN_RUN_DESCRIPTION),
		});

		// The fused queue and the pre-command hash check are keyed on one target
		// file, so only replace a mutation tool that names its target with `path`.
		// A host whose edit tool takes a different shape (a multi-file patch, say)
		// keeps its built-in tool rather than getting a fused one that cannot
		// resolve a target.
		if ("path" in editProperties) {
			pi.registerTool<typeof editParameters, EditToolDetails | undefined>({
				...editTemplate,
				parameters: editParameters,
				async execute(toolCallId, input, signal, onUpdate, ctx) {
					const { then_run, ...editInput } = input as typeof input & { then_run?: ThenRunInput };
					const result = await executeMutationThenRun({
						toolCallId,
						absolutePath: resolveToolPath(ctx.cwd, input.path),
						thenRun: then_run,
						bashOptions: options.bashOptions,
						signal,
						ctx,
						mutate: () => baseEdit(ctx.cwd).execute(toolCallId, editInput, signal, onUpdate, ctx),
					});
					if (
						then_run &&
						result.content.some((block) => block.type === "text" && block.text.includes(THEN_RUN_SUCCEEDED))
					) {
						showSolPiSavings(ctx, "Action Fusion", "1 model round-trip avoided");
					}
					return result;
				},
				renderCall: (args, theme, context) => {
					const base = baseEdit(context.cwd).renderCall!(args, theme, context);
					return args.then_run
						? renderSolPiTool(theme, "Action Fusion", "1 model round-trip avoided", base)
						: base;
				},
				renderResult: (result, resultOptions, theme, context) => {
					const base = baseEdit(context.cwd).renderResult!(result, resultOptions, theme, context);
					return context.args.then_run
						? renderSolPiTool(theme, "Action Fusion", "1 model round-trip avoided", base)
						: base;
				},
			});
		}

		if (!("path" in writeProperties)) return;

		pi.registerTool<typeof writeParameters, undefined>({
			...writeTemplate,
			parameters: writeParameters,
			async execute(toolCallId, input, signal, onUpdate, ctx) {
				const { then_run, ...writeInput } = input as typeof input & { then_run?: ThenRunInput };
				const result = await executeMutationThenRun({
					toolCallId,
					absolutePath: resolveToolPath(ctx.cwd, input.path),
					thenRun: then_run,
					bashOptions: options.bashOptions,
					signal,
					ctx,
					mutate: () => baseWrite(ctx.cwd).execute(toolCallId, writeInput, signal, onUpdate, ctx),
				});
				if (
					then_run &&
					result.content.some((block) => block.type === "text" && block.text.includes(THEN_RUN_SUCCEEDED))
				) {
					showSolPiSavings(ctx, "Action Fusion", "1 model round-trip avoided");
				}
				return result;
			},
			renderCall: (args, theme, context) => {
				const base = baseWrite(context.cwd).renderCall!(args, theme, context);
				return args.then_run ? renderSolPiTool(theme, "Action Fusion", "1 model round-trip avoided", base) : base;
			},
			renderResult: (result, resultOptions, theme, context) => {
				const base = baseWrite(context.cwd).renderResult!(result, resultOptions, theme, context);
				return context.args.then_run
					? renderSolPiTool(theme, "Action Fusion", "1 model round-trip avoided", base)
					: base;
			},
		});
	};
}

export type { ThenRunInput } from "./then-run.ts";
export {
	assertUnchangedBeforeCommand,
	executeMutationThenRun,
	THEN_RUN_FAILED,
	THEN_RUN_SKIPPED,
	THEN_RUN_SUCCEEDED,
} from "./then-run.ts";

export function registerActionFusion(pi: ExtensionAPI): void {
	createActionFusionExtension()(pi);
}

export default registerActionFusion;
