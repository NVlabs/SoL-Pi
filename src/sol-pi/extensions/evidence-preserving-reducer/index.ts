/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * Evidence-Preserving Reducer - delegate the first read of a long build or test
 * log to the configured reducer model, then verify what comes back.
 *
 * In build and test trajectories only a few lines of a long log change the next
 * decision. This extension archives the raw log, sends it through the reducer
 * provider/model selected by the top-level SoL-Pi config, and accepts the
 * resulting receipt only when every quoted line is found byte for byte in the
 * archive. A receipt that cannot be checked is discarded and the original
 * output reaches the frontier agent untouched.
 *
 * Delegation therefore never requires trusting a fluent summary.
 *
 * The top-level SoL-Pi config enables this mechanism. Provider selection and
 * authentication remain with Pi; storage and run identity come from the session.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { runtimeRoot } from "../../runtime-paths.ts";
import { formatSavingsBytes, showSolPiSavings } from "../../tui.ts";
import { archiveBody, archiveRoot } from "./archive.ts";
import { ReceiptCache } from "./cache.ts";
import { reducibleToolResult } from "./candidate.ts";
import {
	DIAGNOSTIC_COMMAND,
	isRecord,
	LIKELY_SECRET,
	loadReducerConfig,
	REDUCER_RECEIPT_SCHEMA,
	type ReducerConfig,
	type ReducerConfigOptions,
	sha256,
} from "./config.ts";
import { createJournal, type Journal } from "./journal.ts";
import { callReducer, type ProviderResult } from "./provider.ts";
import { receiptText, reducerInstructions, validateReceipt } from "./receipt.ts";

export interface ReducedToolResult {
	readonly content: ToolResultEvent["content"];
	readonly details: Record<string, unknown>;
	readonly isError: boolean;
}

export type EvidencePreservingReducerOptions = ReducerConfigOptions;

function errorName(error: unknown): string | undefined {
	return isRecord(error) && typeof error.name === "string" ? error.name : undefined;
}

export async function reduceToolResult(
	journal: Journal,
	config: ReducerConfig,
	event: ToolResultEvent,
	context: ExtensionContext,
	cache?: ReceiptCache,
): Promise<ReducedToolResult | undefined> {
	const reducible = await reducibleToolResult(event);
	if (!reducible || !DIAGNOSTIC_COMMAND.test(reducible.command)) return undefined;
	const { body, command } = reducible;
	if (Buffer.byteLength(body, "utf8") < config.minBytes) return undefined;
	if (body.length > config.maxChars) {
		journal("fallback", { reason: "source-over-max-chars", sourceChars: body.length, maxChars: config.maxChars });
		return undefined;
	}
	if (LIKELY_SECRET.test(body)) {
		journal("fallback", { reason: "likely-secret" });
		return undefined;
	}

	const archive = await archiveBody(archiveRoot(config), body);
	journal("candidate", {
		toolCallId: event.toolCallId,
		commandSha256: sha256(command),
		isError: event.isError,
		sourceSha256: archive.hash,
		sourceBytes: archive.bytes,
		sourceLines: archive.lines,
		sourcePath: archive.path,
	});

	const cacheKey = sha256(JSON.stringify([
		config.storeRoot,
		archive.hash,
		command,
		event.isError,
		config.reducerProvider,
		config.reducerModel,
		config.maxOutputTokens,
		REDUCER_RECEIPT_SCHEMA,
		reducerInstructions(),
	]));
	const cached = cache?.get(cacheKey);
	let provider: ProviderResult;
	try {
		provider = cached ?? (await callReducer(config, command, event.isError, archive, body, context));
	} catch (error) {
		const name = errorName(error);
		journal("fallback", {
			toolCallId: event.toolCallId,
			sourceSha256: archive.hash,
			reason:
				name === "AbortError"
					? "model-call-timeout"
					: name === "ReducerModelUnavailableError"
						? "reducer-model-unavailable"
						: "model-call-exception",
		});
		return undefined;
	}

	journal(cached ? "cache_hit" : "provider_response", {
		toolCallId: event.toolCallId,
		sourceSha256: archive.hash,
		provider: provider.provider,
		model: provider.model,
		stopReason: provider.stopReason,
		errorMessage: provider.errorMessage,
		usage: provider.usage,
	});
	if (!provider.ok) {
		journal("fallback", {
			toolCallId: event.toolCallId,
			sourceSha256: archive.hash,
			reason: "model-response-error",
			stopReason: provider.stopReason,
			errorMessage: provider.errorMessage,
		});
		return undefined;
	}

	const checked = validateReceipt(provider.outputText, archive, body, event.isError);
	if (!checked.ok) {
		cache?.delete(cacheKey);
		journal("fallback", {
			toolCallId: event.toolCallId,
			sourceSha256: archive.hash,
			reason: checked.reason,
			usage: provider.usage,
		});
		return undefined;
	}
	const receipt = receiptText(command, archive, checked.value, provider);
	const receiptBytes = Buffer.byteLength(receipt, "utf8");
	if (receiptBytes >= archive.bytes) {
		cache?.delete(cacheKey);
		journal("fallback", {
			toolCallId: event.toolCallId,
			sourceSha256: archive.hash,
			reason: "receipt-not-smaller",
			receiptBytes,
			sourceBytes: archive.bytes,
			usage: provider.usage,
		});
		return undefined;
	}
	if (!cached) cache?.set(cacheKey, provider);
	journal("applied", {
		toolCallId: event.toolCallId,
		commandSha256: sha256(command),
		sourceSha256: archive.hash,
		sourceBytes: archive.bytes,
		receiptSha256: sha256(receipt),
		receiptBytes,
		evidenceCount: checked.value.evidence.length,
		uncertain: checked.value.uncertain,
		cacheHit: cached !== undefined,
		usage: provider.usage,
	});
	showSolPiSavings(context, "Luna Delegating", formatSavingsBytes(archive.bytes - receiptBytes));
	return {
		content: reducible.projectReceipt(receipt),
		isError: event.isError,
		details: {
			...(isRecord(event.details) ? event.details : {}),
			evidencePreservingReducer: {
				schema: REDUCER_RECEIPT_SCHEMA,
				sourceSha256: archive.hash,
				sourceBytes: archive.bytes,
				receiptSha256: sha256(receipt),
				receiptBytes,
				evidenceCount: checked.value.evidence.length,
				uncertain: checked.value.uncertain,
			},
		},
	};
}

export function createEvidencePreservingReducerExtension(options: EvidencePreservingReducerOptions = {}): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		const states = new Map<string, { config: ReducerConfig; journal: Journal; cache: ReceiptCache }>();
		pi.on("tool_result", (event, context) => {
			let root: string;
			try {
				root = runtimeRoot(context);
			} catch {
				return undefined;
			}
			let state = states.get(root);
			if (!state) {
				const config = loadReducerConfig(root, options);
				state = { config, journal: createJournal(pi, config), cache: new ReceiptCache() };
				states.set(root, state);
			}
			return reduceToolResult(state.journal, state.config, event, context, state.cache);
		});
	};
}

export type { ArchiveObject } from "./archive.ts";
export {
	DIAGNOSTIC_COMMAND,
	loadReducerConfig,
	REDUCER_EVENT_SCHEMA,
	REDUCER_EVENT_TYPE,
	REDUCER_RECEIPT_PREFIX,
	REDUCER_RECEIPT_SCHEMA,
	type ReducerConfigOptions,
	type ReducerConfig,
} from "./config.ts";
export { validateReceipt } from "./receipt.ts";

export function registerEvidencePreservingReducer(
	pi: ExtensionAPI,
	options: EvidencePreservingReducerOptions = {},
): void {
	createEvidencePreservingReducerExtension(options)(pi);
}

export default registerEvidencePreservingReducer;
