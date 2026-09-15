/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { DIAGNOSTIC_COMMAND, recordValue } from "./config.ts";

/** Markers written by the action-fusion extension around a fused command's output. */
const THEN_RUN_SUCCEEDED = "[then_run:succeeded]";
const THEN_RUN_FAILED = "[then_run:failed]";

export interface ReducibleToolResult {
	readonly command: string;
	/** Undefined means the full log exceeds the character limit, not a usable preview. */
	readonly body: string | undefined;
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
 * Prefer the untruncated file pi wrote for a large bash result, so evidence is
 * checked against the exact bytes the command produced rather than a preview.
 */
async function exactBodyFromInline(inline: string, details: unknown, maxChars: number): Promise<string | undefined> {
	const detailsPath = detailsFullOutputPath(details);
	const inlineMatch = inline.match(/Full output:\s*([^\]\r\n]+)/u);
	const candidate = detailsPath ?? inlineMatch?.[1]?.trim();
	if (!candidate || !(await safePiBashTempPath(candidate))) return inline;
	let sourceOverLimit = false;
	try {
		const handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const stats = await handle.stat();
			if (!stats.isFile()) return inline;
			// UTF-8 uses at most three bytes per JavaScript UTF-16 code unit.
			// Keep a byte cap as well, including when the file grows after stat().
			const maxBytes = 3 * maxChars + 1;
			if (stats.size >= maxBytes) {
				sourceOverLimit = true;
				return undefined;
			}
			const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes));
			const decoder = new StringDecoder("utf8");
			let body = "";
			let totalBytes = 0;
			while (totalBytes < maxBytes) {
				const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, maxBytes - totalBytes), null);
				if (bytesRead === 0) {
					body += decoder.end();
					sourceOverLimit = body.length > maxChars;
					return sourceOverLimit ? undefined : body;
				}
				totalBytes += bytesRead;
				body += decoder.write(buffer.subarray(0, bytesRead));
				sourceOverLimit = body.length > maxChars;
				if (sourceOverLimit) return undefined;
			}
			sourceOverLimit = true;
			return undefined;
		} finally {
			await handle.close();
		}
	} catch {
		// Cleanup errors must not turn a rejected full log into an eligible preview.
		return sourceOverLimit ? undefined : inline;
	}
}

/**
 * Identify the log inside a tool result: either a plain bash result, or the
 * command output appended by a fused `edit`/`write` call.
 */
export async function reducibleToolResult(event: ToolResultEvent, maxChars: number): Promise<ReducibleToolResult | undefined> {
	if (event.toolName === "bash") {
		const command = typeof event.input.command === "string" ? event.input.command : "";
		if (!command || !DIAGNOSTIC_COMMAND.test(command)) return undefined;
		const inline = textContent(event);
		return {
			command,
			body: await exactBodyFromInline(inline, event.details, maxChars),
			projectReceipt: (receipt) => [{ type: "text", text: receipt }],
		};
	}
	if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
	const thenRun = recordValue(event.input, "then_run");
	const commandValue = recordValue(thenRun, "command");
	if (typeof commandValue !== "string" || !DIAGNOSTIC_COMMAND.test(commandValue)) return undefined;
	const marker = event.isError ? THEN_RUN_FAILED : THEN_RUN_SUCCEEDED;
	for (let index = 0; index < event.content.length; index++) {
		const block = event.content[index];
		if (!block || block.type !== "text") continue;
		const markerIndex = block.text.indexOf(marker);
		if (markerIndex < 0) continue;
		const suffixStart = markerIndex + marker.length;
		const suffix = block.text.slice(suffixStart);
		const separator = suffix.match(/^(?:\r?\n)+/u)?.[0] ?? "\n";
		const inline = suffix.slice(separator === "\n" && !suffix.startsWith("\n") ? 0 : separator.length);
		return {
			command: commandValue,
			body: await exactBodyFromInline(inline, event.details, maxChars),
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
