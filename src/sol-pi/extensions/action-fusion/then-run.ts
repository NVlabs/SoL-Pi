/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type BashToolOptions, createBashToolDefinition, type ExtensionContext, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { withFusedFileQueue } from "./file-queue.ts";

export const THEN_RUN_SUCCEEDED = "[then_run:succeeded]";
export const THEN_RUN_FAILED = "[then_run:failed]";
export const THEN_RUN_SKIPPED = "[then_run:skipped]";

export interface ThenRunInput {
	command: string;
	timeout?: number;
}

export function createThenRunSchema(description: string) {
	return Type.Optional(
		Type.Object(
			{
				command: Type.String({ description: "Bash command to run" }),
				timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
			},
			{ description },
		),
	);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Fill in a shell path from the session's settings when the caller did not
 * supply one, so a bash installed outside Pi's default locations (and set via
 * ``shellPath`` in settings.json) is honoured by the fused command. A caller
 * provided ``shellPath`` wins; any settings lookup failure falls back to
 * Pi's normal shell discovery.
 */
export function resolveShellPath(
	ctx: ExtensionContext,
	bashOptions: BashToolOptions | undefined,
): BashToolOptions | undefined {
	if (bashOptions?.shellPath) return bashOptions;
	try {
		const settings = SettingsManager.create(ctx.cwd, getAgentDir(), {
			projectTrusted: ctx.isProjectTrusted(),
		});
		if (settings.drainErrors().length > 0) return bashOptions;
		const shellPath = settings.getShellPath();
		if (!shellPath) return bashOptions;
		return { ...bashOptions, shellPath };
	} catch {
		return bashOptions;
	}
}

function resultText(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function thenRunSkippedError(error: unknown): Error {
	return new Error(
		`${errorText(error)}\n\n${THEN_RUN_SKIPPED} The file mutation did not complete successfully; the command was not run.`,
	);
}

async function fileSha256(path: string): Promise<string> {
	return createHash("sha256").update(await readFile(path)).digest("hex");
}

export async function assertUnchangedBeforeCommand(
	path: string,
	yieldForInterference: () => Promise<void> = () => new Promise<void>((resolve) => setImmediate(resolve)),
): Promise<void> {
	try {
		const mutationHash = await fileSha256(path);
		await yieldForInterference();
		const commandHash = await fileSha256(path);
		if (mutationHash !== commandHash) {
			throw new Error("target content changed after the fused mutation");
		}
	} catch (error) {
		throw new Error(`${THEN_RUN_SKIPPED} ${errorText(error)}; the command was not run.`);
	}
}

/**
 * Apply a file mutation and, when the model asked for one, run its follow-up
 * command before returning a single observation.
 *
 * Both steps run inside one SoL-Pi queue slot for `absolutePath`, so another
 * fused mutation of the same file cannot interleave. Pi's built-in mutation
 * tool keeps its own queue; the two queues are not nested.
 */
export async function executeMutationThenRun<TDetails>({
	toolCallId,
	absolutePath,
	thenRun,
	mutate,
	bashOptions,
	signal,
	ctx,
}: {
	toolCallId: string;
	absolutePath: string;
	thenRun: ThenRunInput | undefined;
	mutate: () => Promise<AgentToolResult<TDetails>>;
	bashOptions: BashToolOptions | undefined;
	signal: AbortSignal | undefined;
	ctx: ExtensionContext;
}): Promise<AgentToolResult<TDetails>> {
	return withFusedFileQueue(absolutePath, async () => {
		let mutationResult: AgentToolResult<TDetails>;
		try {
			mutationResult = await mutate();
		} catch (error) {
			if (thenRun !== undefined) {
				throw thenRunSkippedError(error);
			}
			throw error;
		}

		if (thenRun === undefined) {
			return mutationResult;
		}

		await assertUnchangedBeforeCommand(absolutePath);
		const bash = createBashToolDefinition(ctx.cwd, resolveShellPath(ctx, bashOptions));
		try {
			const bashResult = await bash.execute(`${toolCallId}:then_run`, thenRun, signal, undefined, ctx);
			const output = resultText(bashResult);
			return {
				...mutationResult,
				content: [
					...mutationResult.content,
					{ type: "text", text: output ? `${THEN_RUN_SUCCEEDED}\n${output}` : THEN_RUN_SUCCEEDED },
				],
			};
		} catch (error) {
			const mutationOutput = resultText(mutationResult);
			throw new Error([mutationOutput, THEN_RUN_FAILED, errorText(error)].filter(Boolean).join("\n\n"));
		}
	});
}
