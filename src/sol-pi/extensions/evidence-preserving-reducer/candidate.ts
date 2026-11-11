/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { lstat, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname } from "node:path";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { recordValue } from "./config.ts";

/** Markers written by the action-fusion extension around a fused command's output. */
const THEN_RUN_SUCCEEDED = "[then_run:succeeded]";
const THEN_RUN_FAILED = "[then_run:failed]";
/** Status line pi's bash appends to the inline text of a command that exited non-zero. */
const EXIT_STATUS_LINE = /(?:^|\n)Command exited with code (-?\d+)\s*$/u;

export interface ReducibleToolResult {
	readonly command: string;
	readonly body: string;
	/**
	 * Whether the result itself reports a failed command: a non-zero exit code or
	 * a `[then_run:failed]` marker. `undefined` when the result carries no signal.
	 */
	readonly exitFailed: boolean | undefined;
	/** Put the receipt back where the raw output was, leaving the rest of the result alone. */
	readonly projectReceipt: (receipt: string) => ToolResultEvent["content"];
}

function textContent(event: ToolResultEvent): string {
	return event.content
		.filter((item): item is { type: "text"; text: string } => item.type === "text")
		.map((item) => item.text)
		.join("\n");
}

export function detailsFullOutputPath(details: unknown): string | undefined {
	const value = recordValue(details, "fullOutputPath");
	return typeof value === "string" ? value : undefined;
}

async function safePiBashTempPath(path: string | undefined): Promise<boolean> {
	if (!path || !/^pi-bash-[^/\\]+\.log$/u.test(basename(path))) return false;
	try {
		const [candidate, root, status] = await Promise.all([realpath(path), realpath(tmpdir()), lstat(path)]);
		return status.isFile() && !status.isSymbolicLink() && dirname(candidate) === root;
	} catch {
		return false;
	}
}

/**
 * Read the exit status from the inline text. This must run on the text pi put
 * in the result, not on the full-output file: the file holds only the
 * command's output, without the status line.
 */
function inlineExitFailed(inline: string): boolean | undefined {
	const match = inline.match(EXIT_STATUS_LINE);
	return match ? Number(match[1]) !== 0 : undefined;
}

/** `structuredContent.exit_code` of a pi >= 0.99 bash result; absent on older pi. */
function structuredExitCode(event: ToolResultEvent): number | undefined {
	const value = recordValue((event as { structuredContent?: unknown }).structuredContent, "exit_code");
	return typeof value === "number" ? value : undefined;
}

/**
 * Prefer the untruncated file pi wrote for a large bash result, so evidence is
 * checked against the exact bytes the command produced rather than a preview.
 */
async function exactBodyFromInline(inline: string, details: unknown): Promise<string> {
	const detailsPath = detailsFullOutputPath(details);
	const inlineMatch = inline.match(/Full output:\s*([^\]\r\n]+)/u);
	const candidate = detailsPath ?? inlineMatch?.[1]?.trim();
	if (!candidate || !(await safePiBashTempPath(candidate))) return inline;
	try {
		return await readFile(candidate, "utf8");
	} catch {
		return inline;
	}
}

function firstIndex(left: number, right: number): number {
	return left < 0 ? right : right < 0 ? left : Math.min(left, right);
}

/**
 * Identify the log inside a tool result: either a plain bash result, or the
 * command output appended by a fused `edit`/`write` call.
 */
export async function reducibleToolResult(event: ToolResultEvent): Promise<ReducibleToolResult | undefined> {
	if (event.toolName === "bash") {
		const command = typeof event.input.command === "string" ? event.input.command : "";
		if (!command) return undefined;
		const inline = textContent(event);
		const exitCode = structuredExitCode(event);
		return {
			command,
			body: await exactBodyFromInline(inline, event.details),
			exitFailed: exitCode !== undefined ? exitCode !== 0 : inlineExitFailed(inline),
			projectReceipt: (receipt) => [{ type: "text", text: receipt }],
		};
	}
	if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
	const thenRun = recordValue(event.input, "then_run");
	const commandValue = recordValue(thenRun, "command");
	if (typeof commandValue !== "string" || !commandValue) return undefined;
	for (let index = 0; index < event.content.length; index++) {
		const block = event.content[index];
		if (!block || block.type !== "text") continue;
		// The first marker in the block is the one action-fusion wrote; the
		// command's own output may quote either marker later on.
		const markerIndex = firstIndex(block.text.indexOf(THEN_RUN_SUCCEEDED), block.text.indexOf(THEN_RUN_FAILED));
		if (markerIndex < 0) continue;
		const marker = block.text.startsWith(THEN_RUN_FAILED, markerIndex) ? THEN_RUN_FAILED : THEN_RUN_SUCCEEDED;
		const suffixStart = markerIndex + marker.length;
		const suffix = block.text.slice(suffixStart);
		const separator = suffix.match(/^(?:\r?\n)+/u)?.[0] ?? "\n";
		const inline = suffix.slice(separator === "\n" && !suffix.startsWith("\n") ? 0 : separator.length);
		return {
			command: commandValue,
			body: await exactBodyFromInline(inline, event.details),
			// Fused results carry no structured exit code, so pi's status line is
			// also trusted over a succeeded marker. This is deliberately conservative:
			// a passing command whose own last line reads `Command exited with code N`
			// is only left unreduced, while a misreported failure would otherwise get
			// a success receipt.
			exitFailed: marker === THEN_RUN_FAILED || inlineExitFailed(inline) === true,
			projectReceipt: (receipt) =>
				event.content.map((content, contentIndex) =>
					contentIndex === index && content.type === "text"
						? { ...content, text: `${content.text.slice(0, suffixStart)}${separator}${receipt}` }
						: content,
				),
		};
	}
	return undefined;
}
