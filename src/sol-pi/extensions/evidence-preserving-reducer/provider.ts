/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import type { Api, AssistantMessage, Context, Model, ProviderStreamOptions } from "@earendil-works/pi-ai";
import { complete as completeCompat } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ArchiveObject } from "./archive.ts";
import type { ReducerConfig } from "./config.ts";
import { reducerInput, reducerInstructions } from "./receipt.ts";

export type CompatComplete = typeof completeCompat;
type ResolvedCompatAuth =
	| {
			readonly ok: true;
			readonly apiKey?: string;
			readonly baseUrl?: string;
			readonly env?: Record<string, string>;
			readonly headers?: Record<string, string | null>;
	  }
	| { readonly ok: false; readonly error: string };
type CompatibleModelRegistry = {
	readonly find?: (provider: string, modelId: string) => Model<Api> | undefined;
	readonly complete?: (
		model: Model<Api>,
		context: Context,
		options?: ProviderStreamOptions,
	) => Promise<AssistantMessage>;
	readonly getApiKeyAndHeaders: (model: Model<Api>) => Promise<ResolvedCompatAuth>;
};

export interface NormalizedUsage {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly totalTokens: number;
}

export interface ProviderResult {
	readonly errorMessage: string | undefined;
	readonly model: string;
	readonly ok: boolean;
	readonly outputText: string;
	readonly provider: string;
	readonly stopReason: AssistantMessage["stopReason"];
	readonly usage: NormalizedUsage;
}

export class ReducerModelUnavailableError extends Error {
	override readonly name = "ReducerModelUnavailableError";
}

function responseOutputText(response: AssistantMessage): string {
	return response.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("");
}

function normalizedUsage(response: AssistantMessage): NormalizedUsage {
	return {
		input: response.usage.input,
		output: response.usage.output,
		cacheRead: response.usage.cacheRead,
		cacheWrite: response.usage.cacheWrite,
		totalTokens: response.usage.totalTokens,
	};
}

function stringHeaders(headers: Record<string, string | null> | undefined): Record<string, string> | undefined {
	if (headers === undefined) return undefined;
	return Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null));
}

function operationSignal(parent: AbortSignal | undefined, timeoutMs: number): {
	readonly cleanup: () => void;
	readonly signal: AbortSignal;
} {
	const controller = new AbortController();
	const relayAbort = () => controller.abort(parent?.reason);
	if (parent?.aborted) relayAbort();
	else parent?.addEventListener("abort", relayAbort, { once: true });
	const timer = setTimeout(
		() => controller.abort(new DOMException("Reducer model call timed out", "AbortError")),
		timeoutMs,
	);
	return {
		signal: controller.signal,
		cleanup: () => {
			clearTimeout(timer);
			parent?.removeEventListener("abort", relayAbort);
		},
	};
}

function resolveReducerModel(config: ReducerConfig, registry: CompatibleModelRegistry): Model<Api> {
	const model = registry.find?.(config.reducerProvider, config.reducerModel);
	if (!model) {
		throw new ReducerModelUnavailableError(
			`Reducer model is unavailable: ${config.reducerProvider}/${config.reducerModel}`,
		);
	}
	return model;
}

/** Use the configured reducer model and Pi-managed authentication for the reducer call. */
export async function callReducer(
	config: ReducerConfig,
	command: string,
	isError: boolean,
	archive: ArchiveObject,
	body: string,
	context: ExtensionContext,
	compatComplete: CompatComplete = completeCompat,
): Promise<ProviderResult> {
	const registry = context.modelRegistry as unknown as CompatibleModelRegistry;
	const model = resolveReducerModel(config, registry);
	const operation = operationSignal(context.signal, config.timeoutMs);
	try {
		const requestContext = {
			systemPrompt: reducerInstructions(),
			messages: [
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: reducerInput(command, isError, archive, body) }],
					timestamp: Date.now(),
				},
			],
		};
		const requestOptions = {
			cacheRetention: "none" as const,
			maxTokens: Math.min(config.maxOutputTokens, model.maxTokens),
			sessionId: config.runId,
			signal: operation.signal,
			timeoutMs: config.timeoutMs,
		};
		let response: AssistantMessage;
		if (typeof registry.complete === "function") {
			response = await registry.complete(model, requestContext, requestOptions);
		} else {
			const auth = await registry.getApiKeyAndHeaders(model);
			if (!auth.ok) throw new Error(auth.error);
			const legacyModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
			const headers = stringHeaders(auth.headers);
			response = await compatComplete(legacyModel, requestContext, {
				...requestOptions,
				...(auth.apiKey === undefined ? {} : { apiKey: auth.apiKey }),
				...(headers === undefined ? {} : { headers }),
				...(auth.env === undefined ? {} : { env: auth.env }),
			});
		}
		return {
			errorMessage: response.errorMessage,
			model: response.model,
			ok: response.stopReason === "stop" || response.stopReason === "length",
			outputText: responseOutputText(response),
			provider: response.provider,
			stopReason: response.stopReason,
			usage: normalizedUsage(response),
		};
	} finally {
		operation.cleanup();
	}
}
