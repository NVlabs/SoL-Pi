/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import type { AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createEvidencePreservingReducerExtension,
	DIAGNOSTIC_COMMAND,
	loadReducerConfig,
	REDUCER_RECEIPT_SCHEMA,
} from "../src/sol-pi/extensions/evidence-preserving-reducer/index.ts";
import { archiveBody } from "../src/sol-pi/extensions/evidence-preserving-reducer/archive.ts";
import {
	callReducer,
	type CompatComplete,
} from "../src/sol-pi/extensions/evidence-preserving-reducer/provider.ts";
import { runtimeRoot } from "../src/sol-pi/runtime-paths.ts";
import { FakePi, FakeSessionManager, fakeContext } from "./helpers.ts";

const cleanupPaths: string[] = [];

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

interface ModelReceipt {
	schema: string;
	source_sha256: string;
	status: "success" | "failure";
	uncertain: boolean;
	evidence: { kind: string; quote: string }[];
}

interface CapturedCall {
	readonly context: Context;
	readonly model: Model<string>;
	readonly options: Record<string, unknown>;
}

afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function storeRoot(): Promise<string> {
	const value = await mkdtemp(join(tmpdir(), "evidence-preserving-reducer-test-"));
	cleanupPaths.push(value);
	return value;
}

function bashEvent(body: string, overrides: Partial<ToolResultEvent> = {}): ToolResultEvent {
	return {
		type: "tool_result",
		toolName: "bash",
		toolCallId: "call-1",
		input: { command: "pytest -q" },
		content: [{ type: "text", text: body }],
		details: undefined,
		isError: true,
		...overrides,
	} as ToolResultEvent;
}

function fusedEvent(body: string, failed: boolean): ToolResultEvent {
	const marker = failed ? "[then_run:failed]" : "[then_run:succeeded]";
	const confirmation = "Successfully wrote 12 bytes to target.ts";
	return {
		type: "tool_result",
		toolName: "write",
		toolCallId: "write-1",
		input: { path: "target.ts", content: "export {};\n", then_run: { command: "npm test" } },
		content: failed
			? [{ type: "text", text: `${confirmation}\n\n${marker}\n\n${body}` }]
			: [
					{ type: "text", text: confirmation },
					{ type: "text", text: `${marker}\n${body}` },
				],
		details: { patch: "test patch" },
		isError: failed,
	} as ToolResultEvent;
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

function modelComplete(
	body: string,
	receiptFactory: (input: string) => ModelReceipt,
	stopReason: AssistantMessage["stopReason"] = "stop",
	onCall?: (call: CapturedCall) => void,
): Complete {
	return async (model, context, options = {}) => {
		onCall?.({ model, context, options });
		const input = contextInput(context);
		const receipt = receiptFactory(input);
		return {
			role: "assistant",
			content: stopReason === "error" ? [] : [{ type: "text", text: JSON.stringify(receipt) }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: Math.ceil(body.length / 4),
				output: 90,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: Math.ceil(body.length / 4) + 90,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason,
			...(stopReason === "error" ? { errorMessage: "model call failed" } : {}),
			timestamp: Date.now(),
		};
	};
}

function load(
	root: string,
	complete: Complete,
	model: Model<string> | null = ACTIVE_MODEL,
	overrides: Partial<ExtensionContext> = {},
): { context: ExtensionContext; manager: FakeSessionManager; pi: FakePi } {
	const manager = new FakeSessionManager([], "reducer", root);
	const pi = new FakePi(manager);
	createEvidencePreservingReducerExtension()(pi.asExtensionApi());
	const context = fakeContext(manager, {
		model: model ?? undefined,
		modelRegistry: {
			find: (provider: string, modelId: string) =>
				provider === REDUCER_MODEL.provider && modelId === REDUCER_MODEL.id ? REDUCER_MODEL : undefined,
			complete,
		} as unknown as ExtensionContext["modelRegistry"],
		...overrides,
	});
	return { context, manager, pi };
}

describe("evidence-preserving reducer", () => {
	it("registers without an extension-specific credential", () => {
		const pi = new FakePi();
		expect(() => createEvidencePreservingReducerExtension()(pi.asExtensionApi())).not.toThrow();
		expect(pi.handlers.get("tool_result")).toHaveLength(1);
	});

	it("keeps the SoL-Pi identifiers that are written to disk", async () => {
		const root = await storeRoot();
		const signal = "ERROR test target failed";
		const body = `${signal}\n${"diagnostic output\n".repeat(400)}`;
		const { context, manager, pi } = load(
			root,
			modelComplete(body, (input) => ({
				schema: REDUCER_RECEIPT_SCHEMA,
				source_sha256: sourceHash(input),
				status: "failure",
				uncertain: false,
				evidence: [{ kind: "failure", quote: signal }],
			})),
		);

		const result = (await pi.emit("tool_result", bashEvent(body), context)) as {
			content: { type: string; text: string }[];
			details: Record<string, unknown>;
		};

		expect(result.content[0]?.text ?? "").toMatch(/^sol_pi_evidence_receipt_v1\n/u);
		expect(REDUCER_RECEIPT_SCHEMA).toBe("sol-pi-evidence-receipt/1");
		expect(Object.keys(result.details)).toContain("evidencePreservingReducer");
		expect(manager.entries.map((entry) => entry.type === "custom" && entry.customType)).toContain(
			"sol-pi-evidence-preserving-reducer-v1",
		);
		expect(
			manager.customEntryData().every((entry) => entry.schema === "sol-pi-evidence-preserving-reducer/1"),
		).toBe(true);
	});

	it("keeps the diagnostic command trigger generic", () => {
		expect(DIAGNOSTIC_COMMAND.test("pytest -q")).toBe(true);
		expect(DIAGNOSTIC_COMMAND.test("lake build")).toBe(true);
		expect(DIAGNOSTIC_COMMAND.test("cargo test --all")).toBe(true);
		expect(DIAGNOSTIC_COMMAND.test("rg test src")).toBe(false);
	});

	it("loads a configured reducer provider/model route", async () => {
		const root = await storeRoot();
		const config = loadReducerConfig(root, {
			reducerProvider: "test-provider",
			reducerModel: "test-reducer-model",
		});

		expect(config.reducerProvider).toBe("test-provider");
		expect(config.reducerModel).toBe("test-reducer-model");
	});

	it("uses the Luna reducer model and accepts only verified exact quotes", async () => {
		vi.useFakeTimers();
		const root = await storeRoot();
		const fatal = "E   AssertionError: expected 4 but received 5";
		const body = ["pytest session starts", fatal, "FAILED tests/test_math.py::test_addition", ".".repeat(6000)].join(
			"\n",
		);
		let call: CapturedCall | undefined;
		const notify = vi.fn();
		const setStatus = vi.fn();
		const { context, manager, pi } = load(
			root,
			modelComplete(
				body,
				(input) => ({
					schema: REDUCER_RECEIPT_SCHEMA,
					source_sha256: sourceHash(input),
					status: "failure",
					uncertain: false,
					evidence: [
						{ kind: "failure", quote: fatal },
						{ kind: "target", quote: "FAILED tests/test_math.py::test_addition" },
					],
				}),
				"stop",
				(value) => {
					call = value;
				},
			),
			ACTIVE_MODEL,
			{ mode: "tui", hasUI: true, ui: { notify, setStatus } as never },
		);

		const result = (await pi.emit("tool_result", bashEvent(body), context)) as {
			content: { type: string; text: string }[];
		};

		expect(call?.model).toBe(REDUCER_MODEL);
		expect(call?.context.systemPrompt).toContain("lossless test/build output reducer");
		expect(contextInput(call!.context)).toContain("<untrusted_log>");
		expect(call?.options).toMatchObject({ cacheRetention: "none", maxTokens: 2_048, timeoutMs: 90_000 });
		expect(call?.options.signal).toBeInstanceOf(AbortSignal);
		const receipt = result.content[0]?.text ?? "";
		expect(receipt).toMatch(/status=failure/u);
		expect(receipt).toMatch(/line=2/u);
		expect(receipt).toMatch(/reducer_provider=openai-codex/u);
		expect(receipt).toContain(`reducer_model=${REDUCER_MODEL.id}`);
		expect(receipt).toMatch(/authority=Sol retains diagnosis/u);
		expect(Buffer.byteLength(receipt)).toBeLessThan(Buffer.byteLength(body));

		const events = manager.customEntryData();
		const candidate = events.find((entry) => entry.kind === "candidate");
		expect(candidate).toBeTruthy();
		const sourcePath = String(candidate?.sourcePath);
		const localSourcePath = relative(join(runtimeRoot(context), "evidence-preserving-reducer"), sourcePath);
		expect(localSourcePath.length > 0 && !localSourcePath.startsWith("..") && !isAbsolute(localSourcePath)).toBe(true);
		expect(await readFile(sourcePath, "utf8")).toBe(body);
		expect((await stat(sourcePath)).mode & 0o777).toBe(0o600);
		expect(events.filter((entry) => entry.kind === "applied")).toHaveLength(1);
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0]?.[0]).toMatch(
			/^⚡ SoL-Pi · Luna Delegating\nMoney saved · .+ removed from future prompts$/u,
		);
	});

	it("uses Pi-resolved authentication on a fork-shaped model registry", async () => {
		const root = await storeRoot();
		const config = loadReducerConfig(join(root, "session-runtime"));
		const body = `ERROR fork compatibility\n${"diagnostic\n".repeat(400)}`;
		const archive = await archiveBody(config.storeRoot, body);
		let call: CapturedCall | undefined;
		const completion = modelComplete(
			body,
			(input) => ({
				schema: REDUCER_RECEIPT_SCHEMA,
				source_sha256: sourceHash(input),
				status: "failure",
				uncertain: false,
				evidence: [{ kind: "failure", quote: "ERROR fork compatibility" }],
			}),
			"stop",
			(value) => {
				call = value;
			},
		) as CompatComplete;
		let authModel: Model<string> | undefined;
		const context = fakeContext(new FakeSessionManager([], "fork-session", root), {
			model: ACTIVE_MODEL,
			modelRegistry: {
				find: (provider: string, modelId: string) =>
					provider === REDUCER_MODEL.provider && modelId === REDUCER_MODEL.id ? REDUCER_MODEL : undefined,
				getApiKeyAndHeaders: async (model: Model<string>) => {
					authModel = model;
					return {
					ok: true,
					apiKey: "fork-test-key",
					headers: { "x-test-header": "fork" },
					env: { TEST_REGION: "test" },
					baseUrl: "https://fork.example.invalid/v1",
					};
				},
			} as unknown as ExtensionContext["modelRegistry"],
		});

		const result = await callReducer(config, "pytest -q", true, archive, body, context, completion);

		expect(result.ok).toBe(true);
		expect(authModel).toBe(REDUCER_MODEL);
		expect(call?.model.baseUrl).toBe("https://fork.example.invalid/v1");
		expect(call?.options).toMatchObject({
			apiKey: "fork-test-key",
			headers: { "x-test-header": "fork" },
			env: { TEST_REGION: "test" },
		});
	});

	it.each([false, true])(
		"reduces fused command output while preserving the mutation confirmation (failed=%s)",
		async (failed) => {
			const root = await storeRoot();
			const signal = failed ? "ERROR test target failed" : "PASS test target completed";
			const body = `${signal}\n${"diagnostic output\n".repeat(400)}`;
			const { context, manager, pi } = load(
				root,
				modelComplete(body, (input) => ({
					schema: REDUCER_RECEIPT_SCHEMA,
					source_sha256: sourceHash(input),
					status: failed ? "failure" : "success",
					uncertain: false,
					evidence: [{ kind: failed ? "failure" : "summary", quote: signal }],
				})),
			);

			const result = (await pi.emit("tool_result", fusedEvent(body, failed), context)) as {
				content: Array<{ type: string; text?: string }>;
				details: Record<string, unknown>;
				isError: boolean;
			};

			const projected = result.content.map((content) => content.text ?? "").join("\n");
			expect(projected).toMatch(/Successfully wrote 12 bytes to target\.ts/u);
			expect(projected).toMatch(failed ? /\[then_run:failed\]/u : /\[then_run:succeeded\]/u);
			expect(projected).toMatch(/sol_pi_evidence_receipt_v1/u);
			expect(projected).not.toContain("diagnostic output");
			expect(result.isError).toBe(failed);
			expect(result.details.patch).toBe("test patch");
			const candidate = manager.customEntryData().find((entry) => entry.kind === "candidate");
			expect(await readFile(String(candidate?.sourcePath), "utf8")).toBe(body);
		},
	);

	it.each(["invented", "model-error"] as const)("fails open on %s", async (mode) => {
		const root = await storeRoot();
		const body = `ERROR real failure\n${"x".repeat(5000)}`;
		const { context, manager, pi } = load(
			root,
			modelComplete(
				body,
				(input) => ({
					schema: REDUCER_RECEIPT_SCHEMA,
					source_sha256: sourceHash(input),
					status: "failure",
					uncertain: false,
					evidence: [{ kind: "failure", quote: "ERROR invented failure" }],
				}),
				mode === "model-error" ? "error" : "stop",
			),
		);

		const result = await pi.emit("tool_result", bashEvent(body), context);

		expect(result).toBeUndefined();
		const fallbacks = manager.customEntryData().filter((entry) => entry.kind === "fallback");
		expect(
			fallbacks.some((entry) =>
				mode === "model-error"
					? entry.reason === "model-response-error" && entry.stopReason === "error"
					: entry.reason === "unverifiable-quote",
			),
		).toBe(true);
	});

	it("fails open when Pi cannot complete the nested model call", async () => {
		const root = await storeRoot();
		const body = `ERROR real failure\n${"x".repeat(5000)}`;
		const { context, manager, pi } = load(root, async () => {
			throw new Error("authentication is not configured");
		});

		expect(await pi.emit("tool_result", bashEvent(body), context)).toBeUndefined();
		expect(manager.customEntryData()).toContainEqual(
			expect.objectContaining({ kind: "fallback", reason: "model-call-exception" }),
		);
	});

	it("fails open when the configured reducer model is unavailable", async () => {
		const root = await storeRoot();
		const body = `ERROR real failure\n${"x".repeat(5000)}`;
		let calls = 0;
		const { context, manager, pi } = load(
			root,
			async () => {
				calls++;
				throw new Error("unexpected model call");
			},
			ACTIVE_MODEL,
			{
				modelRegistry: {
					find: () => undefined,
					complete: async () => {
						calls++;
						throw new Error("unexpected model call");
					},
				} as unknown as ExtensionContext["modelRegistry"],
			},
		);

		expect(await pi.emit("tool_result", bashEvent(body), context)).toBeUndefined();
		expect(calls).toBe(0);
		expect(manager.customEntryData()).toContainEqual(
			expect.objectContaining({ kind: "fallback", reason: "reducer-model-unavailable" }),
		);
	});

	it("fails open when Pi has no persistent session directory", async () => {
		const manager = new FakeSessionManager([], "ephemeral-session", "");
		const pi = new FakePi(manager);
		createEvidencePreservingReducerExtension()(pi.asExtensionApi());
		let calls = 0;
		const context = fakeContext(manager, {
			model: ACTIVE_MODEL,
			modelRegistry: {
				complete: async () => {
					calls++;
					throw new Error("unexpected model call");
				},
			} as unknown as ExtensionContext["modelRegistry"],
		});
		const body = `ERROR no session storage\n${"x".repeat(5000)}`;

		expect(await pi.emit("tool_result", bashEvent(body), context)).toBeUndefined();
		expect(calls).toBe(0);
	});

	it("reads only Pi output files in the system temporary directory", async () => {
		const root = await storeRoot();
		const fullBody = `ERROR full output\n${"full diagnostic\n".repeat(400)}`;
		const outputPath = join(tmpdir(), `pi-bash-${randomUUID()}.log`);
		await writeFile(outputPath, fullBody, { mode: 0o600 });
		cleanupPaths.push(outputPath);
		let input = "";
		const { context, manager, pi } = load(
			root,
			modelComplete(fullBody, (value) => {
				input = value;
				return {
					schema: REDUCER_RECEIPT_SCHEMA,
					source_sha256: sourceHash(value),
					status: "failure",
					uncertain: false,
					evidence: [{ kind: "failure", quote: "ERROR full output" }],
				};
			}),
		);

		await pi.emit(
			"tool_result",
			bashEvent("ERROR truncated", { details: { fullOutputPath: outputPath } }),
			context,
		);
		expect(input).toContain(fullBody);
		const candidate = manager.customEntryData().find((entry) => entry.kind === "candidate");
		expect(await readFile(String(candidate?.sourcePath), "utf8")).toBe(fullBody);

		const outsidePath = join(root, `pi-bash-${randomUUID()}.log`);
		await writeFile(outsidePath, `ERROR outside file\n${"outside\n".repeat(600)}`);
		const inlineBody = `ERROR inline output\n${"inline diagnostic\n".repeat(400)}`;
		input = "";
		await pi.emit(
			"tool_result",
			bashEvent(inlineBody, { toolCallId: "call-2", details: { fullOutputPath: outsidePath } }),
			context,
		);
		expect(input).toContain(inlineBody);
		expect(input).not.toContain("ERROR outside file");
	});

	it("does not delegate small or non-diagnostic output", async () => {
		const root = await storeRoot();
		let calls = 0;
		const { context, manager, pi } = load(root, async () => {
			calls++;
			throw new Error("unexpected model call");
		});

		const shortBody = "ERROR short";
		expect(await pi.emit("tool_result", bashEvent(shortBody), context)).toBeUndefined();
		expect(
			await pi.emit(
				"tool_result",
				bashEvent("x".repeat(5000), { input: { command: "rg symbol src" } }),
				context,
			),
		).toBeUndefined();
		expect(calls).toBe(0);
		expect(manager.customEntryData()).toEqual([
			expect.objectContaining({
				kind: "fallback",
				reason: "source-under-min-bytes",
				bytes: Buffer.byteLength(shortBody, "utf8"),
				minBytes: 4_096,
			}),
		]);
	});
});
