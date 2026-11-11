/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type BashToolOptions, createBashToolDefinition, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { withFusedFileQueue } from "./file-queue.ts";

export const THEN_RUN_SUCCEEDED = "[then_run:succeeded]";
export const THEN_RUN_FAILED = "[then_run:failed]";
export const THEN_RUN_SKIPPED = "[then_run:skipped]";

/**
 * The context Pi passes to tool `execute()`: `ExtensionContext` before Pi 0.99,
 * `ExtensionToolContext` since then. Derived so it compiles against both.
 */
type ToolExecuteContext = Parameters<ToolDefinition["execute"]>[4];

/**
 * What happened to the follow-up command of a returned fused result. Thrown
 * results carry the status in their message instead.
 */
export type ThenRunStatus = "none" | "succeeded" | "failed" | "skipped";

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

function resultText(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

const THEN_RUN_SKIPPED_REASON = "The file mutation did not complete successfully; the command was not run.";

function thenRunSkippedError(error: unknown): Error {
	return new Error(`${errorText(error)}\n\n${THEN_RUN_SKIPPED} ${THEN_RUN_SKIPPED_REASON}`);
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
export async function executeMutationThenRun<TDetails>(
	options: FusedMutationOptions<TDetails>,
): Promise<AgentToolResult<TDetails>> {
	return (await runFusedMutation(options)).result;
}

interface FusedMutationOptions<TDetails> {
	toolCallId: string;
	absolutePath: string;
	thenRun: ThenRunInput | undefined;
	mutate: () => Promise<AgentToolResult<TDetails>>;
	bashOptions: BashToolOptions | undefined;
	signal: AbortSignal | undefined;
	ctx: ToolExecuteContext;
}

/**
 * {@link executeMutationThenRun} plus the status of the follow-up command, so
 * callers never have to infer success from text the command itself printed.
 *
 * A failing command is reported in one of two shapes, depending on Pi's bash:
 * before Pi 0.99 it throws on a non-zero exit, and so do later versions on a
 * timeout, an abort, or a missing exit code. Those failures throw an error
 * that keeps the mutation output. Since Pi 0.99 a non-zero exit comes back as
 * an `isError` result; it is returned as an `isError` result that keeps the
 * mutation's details, so the edit diff still renders. Both carry
 * `[then_run:failed]` followed by the command output.
 */
export async function runFusedMutation<TDetails>({
	toolCallId,
	absolutePath,
	thenRun,
	mutate,
	bashOptions,
	signal,
	ctx,
}: FusedMutationOptions<TDetails>): Promise<{ result: AgentToolResult<TDetails>; status: ThenRunStatus }> {
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
			return { result: mutationResult, status: "none" };
		}
		if (isErrorResult(mutationResult)) {
			return {
				result: appendThenRunText(mutationResult, `${THEN_RUN_SKIPPED} ${THEN_RUN_SKIPPED_REASON}`, true),
				status: "skipped",
			};
		}

		await assertUnchangedBeforeCommand(absolutePath);
		const bash = createBashToolDefinition(ctx.cwd, bashOptions);
		let bashResult: AgentToolResult<unknown>;
		try {
			bashResult = await bash.execute(`${toolCallId}:then_run`, thenRun, signal, undefined, ctx);
		} catch (error) {
			const mutationOutput = resultText(mutationResult);
			throw new Error([mutationOutput, THEN_RUN_FAILED, errorText(error)].filter(Boolean).join("\n\n"));
		}
		const output = resultText(bashResult);
		if (isErrorResult(bashResult)) {
			return {
				result: appendThenRunText(mutationResult, output ? `${THEN_RUN_FAILED}\n${output}` : THEN_RUN_FAILED, true),
				status: "failed",
			};
		}
		return {
			result: appendThenRunText(
				mutationResult,
				output ? `${THEN_RUN_SUCCEEDED}\n${output}` : THEN_RUN_SUCCEEDED,
				false,
			),
			status: "succeeded",
		};
	});
}

/** Pi 0.99+ results may report a failure with `isError` instead of throwing; 0.84 has no such field. */
type MaybeErrorResult<TDetails> = AgentToolResult<TDetails> & { isError?: boolean };

function isErrorResult(result: AgentToolResult<unknown>): boolean {
	return (result as MaybeErrorResult<unknown>).isError === true;
}

/**
 * Add the follow-up report to the mutation result. Only the mutation's own
 * fields are kept: bash `details` and `structuredContent` describe a different
 * tool and would confuse the edit and write renderers.
 */
function appendThenRunText<TDetails>(
	mutationResult: AgentToolResult<TDetails>,
	text: string,
	isError: boolean,
): AgentToolResult<TDetails> {
	const result: MaybeErrorResult<TDetails> = {
		...mutationResult,
		content: [...mutationResult.content, { type: "text", text }],
	};
	if (isError) result.isError = true;
	return result;
}
