/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { archiveBody } from "../src/sol-pi/extensions/evidence-preserving-reducer/archive.ts";
import {
	createEvidencePreservingReducerExtension,
	loadReducerConfig,
	REDUCER_RECEIPT_SCHEMA,
} from "../src/sol-pi/extensions/evidence-preserving-reducer/index.ts";
import {
	callReducer,
	type CompatComplete,
} from "../src/sol-pi/extensions/evidence-preserving-reducer/provider.ts";
import { FakePi, FakeSessionManager, fakeContext } from "./helpers.ts";

const ACTIVE_MODEL = {
	id: ["gpt-5.6", "sol"].join("-"),
	name: "GPT-5.6 SoL",
	api: "openai-responses",
	provider: "openai-codex",
	baseUrl: "https://example.invalid/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 16_384,
} satisfies Model<"openai-responses">;

const REDUCER_MODEL = {
	id: ["gpt-5.6", "luna"].join("-"),
	name: "GPT-5.6 Luna",
	api: "openai-responses",
	provider: "openai-codex",
	baseUrl: "https://example.invalid/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32_768,
	maxTokens: 4_096,
} satisfies Model<"openai-responses">;

type Complete = (
	model: Model<string>,
	context: Context,
	options?: Record<string, unknown>,
) => Promise<AssistantMessage>;

interface CapturedCall {
	readonly model: Model<string>;
	readonly options: Record<string, unknown>;
}

function contextInput(context: Context): string {
	const message = context.messages[0];
	if (message?.role !== "user") throw new Error("reducer request omitted its user message");
	if (typeof message.content === "string") return message.content;
	return message.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n");
}

function sourceHash(input: string): string {
	const match = input.match(/source_sha256=([a-f0-9]{64})/u);
	if (!match?.[1]) throw new Error("request omitted source hash");
	return match[1];
}

function reducerComplete(onCall: (call: CapturedCall) => void): Complete {
	return async (model, context, options = {}) => {
		onCall({ model, options });
		const input = contextInput(context);
		return {
			role: "assistant",
			content: [
				{
					type: "text",
					text: JSON.stringify({
						schema: REDUCER_RECEIPT_SCHEMA,
						source_sha256: sourceHash(input),
						status: "failure",
						uncertain: false,
						evidence: [{ kind: "failure", quote: "ERROR stress failure" }],
					}),
				},
			],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 10,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 20,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
	};
}

function bashEvent(body: string, toolCallId: string): ToolResultEvent {
	return {
		type: "tool_result",
		toolName: "bash",
		toolCallId,
		input: { command: "pytest -q" },
		content: [{ type: "text", text: body }],
		details: undefined,
		isError: true,
	} as ToolResultEvent;
}

describe("SoL-Pi regression stress", () => {
	it("keeps EPR reducer routing on the configured Luna model under repeated calls", async () => {
		const root = await mkdtemp(join(tmpdir(), "sol-pi-epr-stress-"));
		try {
			for (let i = 0; i < 200; i++) {
				const config = loadReducerConfig(join(root, `runtime-${i}`));
				const body = `ERROR stress failure\ncase=${i}\n${"diagnostic line\n".repeat(360 + (i % 20))}`;
				const archive = await archiveBody(config.storeRoot, body);
				let call: CapturedCall | undefined;
				let authModel: Model<string> | undefined;
				const context = fakeContext(new FakeSessionManager([], `epr-stress-${i}`, root), {
					model: ACTIVE_MODEL,
					modelRegistry: {
						find: (provider: string, modelId: string) =>
							provider === REDUCER_MODEL.provider && modelId === REDUCER_MODEL.id ? REDUCER_MODEL : undefined,
						getApiKeyAndHeaders: async (model: Model<string>) => {
							authModel = model;
							return { ok: true, apiKey: "test-key", headers: {}, env: {}, baseUrl: "https://stress.invalid/v1" };
						},
					} as unknown as ExtensionContext["modelRegistry"],
				});

				const result = await callReducer(
					config,
					"pytest -q",
					true,
					archive,
					body,
					context,
					reducerComplete((value) => {
						call = value;
					}) as CompatComplete,
				);

				expect(result.ok).toBe(true);
				expect(authModel).toBe(REDUCER_MODEL);
				expect(call?.model).toMatchObject({ provider: REDUCER_MODEL.provider, id: REDUCER_MODEL.id });
				expect(call?.model).not.toMatchObject({ provider: ACTIVE_MODEL.provider, id: ACTIVE_MODEL.id });
				expect(call?.options).toMatchObject({ cacheRetention: "none", maxTokens: 2_048, timeoutMs: 90_000 });
				expect(result.model).toBe(REDUCER_MODEL.id);
				expect(result.provider).toBe(REDUCER_MODEL.provider);
				expect(result.outputText).toContain("ERROR stress failure");
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("fails open without calling a model when the configured reducer model is unavailable", async () => {
		const root = await mkdtemp(join(tmpdir(), "sol-pi-epr-missing-stress-"));
		try {
			for (let i = 0; i < 100; i++) {
				const manager = new FakeSessionManager([], `epr-missing-${i}`, root);
				const pi = new FakePi(manager);
				createEvidencePreservingReducerExtension()(pi.asExtensionApi());
				let calls = 0;
				const context = fakeContext(manager, {
					model: ACTIVE_MODEL,
					modelRegistry: {
						find: () => undefined,
						complete: async () => {
							calls++;
							throw new Error("unexpected model call");
						},
					} as unknown as ExtensionContext["modelRegistry"],
				});
				const body = `ERROR stress failure\ncase=${i}\n${"diagnostic line\n".repeat(360 + (i % 20))}`;

				expect(await pi.emit("tool_result", bashEvent(body, `call-${i}`), context)).toBeUndefined();
				expect(calls).toBe(0);
				expect(manager.customEntryData()).toContainEqual(
					expect.objectContaining({ kind: "fallback", reason: "reducer-model-unavailable" }),
				);
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
