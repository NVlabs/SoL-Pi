/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createObservationPackExtension,
	FULL_SENDS,
	THRESHOLD_BYTES,
} from "../src/sol-pi/extensions/observation-pack/index.ts";
import { componentText, FakePi, FakeSessionManager, fakeContext, fakeToolContext, plainTheme } from "./helpers.ts";
import { runtimeRoot } from "../src/sol-pi/runtime-paths.ts";

const roots: string[] = [];
const SESSION_ID = "session-a";

afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
	vi.restoreAllMocks();
});

async function sessionRoot(): Promise<string> {
	const value = await mkdtemp(join(tmpdir(), "observationpack-test-"));
	roots.push(value);
	return value;
}

let symlinkSupport: Promise<boolean> | undefined;
/** Windows without Developer Mode / admin rights cannot create symlinks; probe once and cache. */
function canCreateSymlinks(): Promise<boolean> {
	symlinkSupport ??= (async () => {
		const dir = await sessionRoot();
		const target = join(dir, "probe-target.txt");
		await writeFile(target, "probe");
		try {
			await symlink(target, join(dir, "probe-link.txt"));
			return true;
		} catch {
			return false;
		}
	})();
	return symlinkSupport;
}

function observationPackPi(): FakePi {
	const pi = new FakePi();
	createObservationPackExtension()(pi.asExtensionApi());
	return pi;
}

function repeatPastThreshold(line: string): string {
	return line.repeat(Math.ceil((THRESHOLD_BYTES + 1) / Buffer.byteLength(line, "utf8")));
}

function toolResult(text: string, overrides: Partial<ToolResultMessage> = {}): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 1,
		...overrides,
	};
}

function resultText(message: AgentMessage): string {
	if (message.role !== "toolResult") throw new Error("expected tool result");
	return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

function observationId(message: ToolResultMessage): string {
	const contentHash = createHash("sha256").update(resultText(message)).digest("hex");
	const identity = `${message.toolName}\0${message.toolCallId}\0${contentHash}`;
	return `obs_${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
}

function observationPath(sessionDir: string, id: string): string {
	return join(sessionDir, "sol-pi", SESSION_ID, "observation-pack", "objects", `${id}.txt`);
}

function observationObjectsDirectory(sessionDir: string): string {
	return join(sessionDir, "sol-pi", SESSION_ID, "observation-pack", "objects");
}

async function project(pi: FakePi, message: ToolResultMessage, sessionDir: string, count: number): Promise<string[]> {
	const projected: string[] = [];
	for (let index = 0; index < count; index += 1) {
		const messages = await pi.emitContext([message], fakeContext(sessionDir));
		const result = messages[0];
		if (!result) throw new Error("missing projection");
		projected.push(resultText(result));
	}
	return projected;
}

function captureConsoleErrors(): string[] {
	const errors: string[] = [];
	vi.spyOn(console, "error").mockImplementation((...values: unknown[]) => {
		errors.push(values.map(String).join(" "));
	});
	return errors;
}

describe("observation pack", () => {
	it("archives and recalls large observations without a session directory", async () => {
		const manager = SessionManager.inMemory();
		const context = fakeContext("", { sessionManager: manager });
		const root = runtimeRoot(context);
		roots.push(root);
		const body = `in-memory observation\n${repeatPastThreshold("recall bytes\n")}`;
		const message = toolResult(body);
		const pi = observationPackPi();
		for (let index = 0; index < FULL_SENDS; index++) {
			expect(resultText((await pi.emitContext([message], context))[0]!)).toBe(body);
		}
		const placeholder = resultText((await pi.emitContext([message], context))[0]!);
		const id = placeholder.match(/id: (obs_[a-f0-9]{24})/u)?.[1];
		expect(id).toBeTruthy();
		expect(await readFile(join(root, "observation-pack", "objects", `${id}.txt`), "utf8")).toBe(body);
		const recalled = await observationPackPi().tool("obs_recall").execute(
			"recall-memory", { id, offset: 0 }, undefined, undefined,
			fakeToolContext("", { sessionManager: manager }),
		);
		expect(recalled.content).toEqual(expect.arrayContaining([
			expect.objectContaining({ type: "text", text: expect.stringContaining("in-memory observation") }),
		]));
		expect(manager.getSessionFile()).toBeUndefined();
	});

	it("registers its public surface without legacy environment flags", () => {
		const pi = observationPackPi();
		expect(pi.handlers.has("context")).toBe(true);
		expect(pi.registeredTools.map((tool) => tool.name)).toEqual(["obs_recall"]);
	});

	it("renders observation recall as an English lightning savings call", () => {
		const recall = observationPackPi().tool("obs_recall");
		const args = { id: "obs_0123456789abcdef01234567", offset: 0 };
		const rendered = recall.renderCall!(args, plainTheme, { args, cwd: process.cwd() } as never);

		expect(componentText(rendered)).toContain("⚡ SoL-Pi · Observation Pack");
		expect(componentText(rendered)).toContain("Money saved");
	});

	it("keeps the first two requests full and reuses one stable placeholder afterwards", async () => {
		const sessionDir = await sessionRoot();
		const body = `head line\n${repeatPastThreshold("middle line\n")}tail line\n`;
		const message = toolResult(body);
		const projected = await project(observationPackPi(), message, sessionDir, 4);

		expect(FULL_SENDS).toBe(2);
		expect(projected[0]).toBe(body);
		expect(projected[1]).toBe(body);
		expect(projected[2]).not.toBe(body);
		expect(projected[2]).toBe(projected[3]);
		expect(projected[2]).toMatch(/^\[large tool result replaced/u);
		expect(projected[2]).toMatch(/head line/u);
		expect(projected[2]).toMatch(/tail line/u);
		expect(resultText(message)).toBe(body);

		const id = projected[2]?.match(/id: (obs_[a-f0-9]{24})/u)?.[1];
		expect(id).toBeTruthy();
		expect(await readFile(observationPath(sessionDir, id!), "utf8")).toBe(body);
	});

	it("announces the first measured placeholder saving only in TUI mode", async () => {
		vi.useFakeTimers();
		const sessionDir = await sessionRoot();
		const body = `head line\n${repeatPastThreshold("middle line\n")}tail line\n`;
		const message = toolResult(body);
		const pi = observationPackPi();
		const notify = vi.fn();
		const setStatus = vi.fn();
		const context = fakeContext(sessionDir, {
			mode: "tui",
			hasUI: true,
			ui: { notify, setStatus } as never,
		});

		await pi.emitContext([message], context);
		await pi.emitContext([message], context);
		await pi.emitContext([message], context);
		await pi.emitContext([message], context);

		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0]?.[0]).toMatch(
			/^⚡ SoL-Pi · Observation Pack\nMoney saved · [\d,]+ context tokens avoided$/u,
		);
	});

	it("isolates objects and send counters by Pi session", async () => {
		const sessionDir = await sessionRoot();
		const body = `session isolation\n${repeatPastThreshold("separate bytes\n")}`;
		const message = toolResult(body);
		const id = observationId(message);
		const pi = observationPackPi();
		const contextA = fakeContext(new FakeSessionManager([], "session-a", sessionDir));
		const contextB = fakeContext(new FakeSessionManager([], "session-b", sessionDir));

		for (const context of [contextA, contextB]) {
			expect(resultText((await pi.emitContext([message], context))[0]!)).toBe(body);
			expect(resultText((await pi.emitContext([message], context))[0]!)).toBe(body);
			expect(resultText((await pi.emitContext([message], context))[0]!)).toMatch(/^\[large tool result replaced/u);
		}

		expect(await readFile(join(sessionDir, "sol-pi", "session-a", "observation-pack", "objects", `${id}.txt`), "utf8")).toBe(body);
		expect(await readFile(join(sessionDir, "sol-pi", "session-b", "observation-pack", "objects", `${id}.txt`), "utf8")).toBe(body);
	});

	it("breaks the prefix once per observation without remutating older placeholders", async () => {
		const sessionDir = await sessionRoot();
		const pi = observationPackPi();
		const first = toolResult(`first\n${"a".repeat(THRESHOLD_BYTES + 100)}\n`, { toolCallId: "first" });
		const second = toolResult(`second\n${"b".repeat(THRESHOLD_BYTES + 100)}\n`, { toolCallId: "second" });
		const firstSends = await project(pi, first, sessionDir, 3);
		const oldPlaceholder = firstSends[2];
		expect(oldPlaceholder).toBeTruthy();

		const combined: string[][] = [];
		for (let index = 0; index < 3; index += 1) {
			const messages = await pi.emitContext([first, second], fakeContext(sessionDir));
			combined.push(messages.map(resultText));
		}

		expect(combined[0]?.[0]).toBe(oldPlaceholder);
		expect(combined[1]?.[0]).toBe(oldPlaceholder);
		expect(combined[2]?.[0]).toBe(oldPlaceholder);
		expect(combined[0]?.[1]).toBe(resultText(second));
		expect(combined[1]?.[1]).toBe(resultText(second));
		expect(combined[2]?.[1]).not.toBe(resultText(second));
	});

	it("keeps mid-conversation system messages in place while packing", async () => {
		const sessionDir = await sessionRoot();
		const pi = observationPackPi();
		const body = `system order\n${repeatPastThreshold("packed line\n")}`;
		const system = (content: string): AgentMessage =>
			({ role: "system", content, timestamp: 1 }) as unknown as AgentMessage;
		const assistant = (text: string): AgentMessage =>
			({ role: "assistant", content: [{ type: "text", text }], timestamp: 1 }) as unknown as AgentMessage;
		const conversation: AgentMessage[] = [
			system("prompt"),
			{ role: "user", content: "go", timestamp: 1 },
			toolResult(body),
			assistant("first"),
			system("tool declaration delta"),
			{ role: "user", content: "again", timestamp: 1 },
			assistant("second"),
		];

		const projected = await pi.emitContext(conversation, fakeContext(sessionDir));

		expect(projected.map((message) => message.role)).toEqual(conversation.map((message) => message.role));
		expect(projected[0]).toEqual(conversation[0]);
		expect(projected[4]).toEqual(conversation[4]);
		const placeholder = resultText(projected[2]!);
		expect(placeholder).toMatch(/^\[large tool result replaced/u);
		expect(resultText(conversation[2]!)).toBe(body);

		const id = placeholder.match(/id: (obs_[a-f0-9]{24})/u)?.[1];
		const recalled = await pi
			.tool("obs_recall")
			.execute("recall-1", { id, offset: 0 }, undefined, undefined, fakeToolContext(sessionDir));
		expect(recalled.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n")).toMatch(
			/system order/u,
		);
	});

	it("edits the visible messages in place so later context handlers see the placeholder", async () => {
		const sessionDir = await sessionRoot();
		const pi = observationPackPi();
		const seen: string[] = [];
		const results: unknown[] = [];
		const [packHandler] = pi.handlers.get("context") ?? [];
		pi.handlers.set("context", [
			async (event, context) => {
				const result = await packHandler!(event, context);
				results.push(result);
				return result;
			},
			(event) => {
				const message = (event as { messages: AgentMessage[] }).messages[0];
				seen.push(resultText(message!));
			},
		]);
		const body = `ordering\n${repeatPastThreshold("observer line\n")}`;
		const message = toolResult(body, { toolName: "codemode" });

		for (let request = 0; request < 3; request += 1) await pi.emitContext([message], fakeContext(sessionDir));

		expect(results).toEqual([undefined, undefined, undefined]);
		expect(seen[0]).toBe(body);
		expect(seen[1]).toBe(body);
		expect(seen[2]).toMatch(/^\[large tool result replaced/u);
		expect(seen[2]).toMatch(/tool: codemode/u);
	});

	it("recalls from durable storage after a restart of the extension", async () => {
		const sessionDir = await sessionRoot();
		const body = `durable observation\n${repeatPastThreshold("recall line\n")}`;
		const projected = await project(observationPackPi(), toolResult(body), sessionDir, 3);
		const id = projected[2]?.match(/id: (obs_[a-f0-9]{24})/u)?.[1];
		expect(id).toBeTruthy();

		const resumed = observationPackPi();
		const result = await resumed
			.tool("obs_recall")
			.execute("recall-1", { id, offset: 0 }, undefined, undefined, fakeToolContext(sessionDir));
		const recalled = result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");

		expect(recalled).toMatch(/durable observation/u);
		expect(recalled).toMatch(/recall line/u);
	});

	it("fails storage closed when a same-size object holds different content", async () => {
		const sessionDir = await sessionRoot();
		const body = `expected\n${repeatPastThreshold("original bytes\n")}`;
		const message = toolResult(body);
		const id = observationId(message);
		await mkdir(observationObjectsDirectory(sessionDir), { recursive: true });
		await writeFile(observationPath(sessionDir, id), "x".repeat(Buffer.byteLength(body, "utf8")));
		const errors = captureConsoleErrors();

		expect(await project(observationPackPi(), message, sessionDir, 3)).toEqual([body, body, body]);
		expect(errors.some((error) => error.includes(id) && error.includes("hash mismatch"))).toBe(true);
	});

	it("accepts an existing same-content object as idempotent storage", async () => {
		const sessionDir = await sessionRoot();
		const body = `idempotent\n${repeatPastThreshold("same bytes\n")}`;
		const message = toolResult(body);
		const id = observationId(message);
		await mkdir(observationObjectsDirectory(sessionDir), { recursive: true });
		await writeFile(observationPath(sessionDir, id), body);

		const projected = await project(observationPackPi(), message, sessionDir, 3);

		expect(projected[0]).toBe(body);
		expect(projected[1]).toBe(body);
		expect(projected[2]).toMatch(new RegExp(`id: ${id}`, "u"));
	});

	it("fails recall closed when an object path is replaced by a symlink", async (ctx) => {
		if (!(await canCreateSymlinks())) ctx.skip();
		const sessionDir = await sessionRoot();
		const body = `stored\n${repeatPastThreshold("observation bytes\n")}`;
		const message = toolResult(body);
		const id = observationId(message);
		const pi = observationPackPi();
		await project(pi, message, sessionDir, 3);
		const path = observationPath(sessionDir, id);
		const target = join(sessionDir, "symlink-target.txt");
		await writeFile(target, "target bytes must not be recalled");
		await rm(path);
		await symlink(target, path);

		await expect(
			pi.tool("obs_recall").execute("recall-1", { id, offset: 0 }, undefined, undefined, fakeToolContext(sessionDir)),
		).rejects.toMatchObject({ code: "ELOOP" });
	});

	it("returns the exact original bytes across paged recall", async () => {
		const sessionDir = await sessionRoot();
		const body = `utf8: luna ☾\n${"0123456789abcdef\n".repeat(1_200)}final line`;
		const message = toolResult(body);
		const id = observationId(message);
		const pi = observationPackPi();
		await project(pi, message, sessionDir, 3);
		const recall = pi.tool("obs_recall");

		let offset = 0;
		let recalled = "";
		for (;;) {
			const result = await recall.execute("recall-1", { id, offset }, undefined, undefined, fakeToolContext(sessionDir));
			const details = result.details as { eof: boolean; nextOffset: number };
			const output = result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
			const firstNewline = output.indexOf("\n");
			const secondNewline = output.indexOf("\n", firstNewline + 1);
			expect(secondNewline).not.toBe(-1);
			recalled += output.slice(secondNewline + 1);
			offset = details.nextOffset;
			if (details.eof) break;
		}

		expect(recalled).toBe(body);
		expect(Buffer.from(recalled, "utf8")).toEqual(Buffer.from(body, "utf8"));
	});

	it("fails storage closed when the observation directory is a symlink", async (ctx) => {
		if (!(await canCreateSymlinks())) ctx.skip();
		const sessionDir = await sessionRoot();
		const targetDir = await sessionRoot();
		await mkdir(join(sessionDir, "sol-pi", SESSION_ID, "observation-pack"), { recursive: true });
		await symlink(targetDir, observationObjectsDirectory(sessionDir), "dir");
		const body = `directory guard\n${repeatPastThreshold("must not escape\n")}`;
		const message = toolResult(body);
		const id = observationId(message);
		const errors = captureConsoleErrors();

		expect(await project(observationPackPi(), message, sessionDir, 3)).toEqual([body, body, body]);
		expect(errors.some((error) => error.includes(id) && error.includes("not a regular directory"))).toBe(true);
		await expect(readFile(join(targetDir, `${id}.txt`))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("keeps the mutation confirmation and then_run marker of a fused write", async () => {
		const sessionDir = await sessionRoot();
		const pi = observationPackPi();
		const message = toolResult("", {
			toolCallId: "write-1",
			toolName: "write",
			content: [
				{ type: "text", text: "Successfully wrote 12 bytes to target.ts" },
				{ type: "text", text: `[then_run:succeeded]\n${"builder output\n".repeat(400)}` },
			],
			details: { patch: "preserved" },
		});

		let projected: AgentMessage[] = [];
		for (let request = 0; request < 3; request += 1) {
			projected = await pi.emitContext([message], fakeContext(sessionDir));
		}

		const result = projected[0];
		expect(result?.role).toBe("toolResult");
		expect(resultText(result!)).toMatch(/Successfully wrote 12 bytes to target\.ts/u);
		expect(resultText(result!)).toMatch(/\[then_run:succeeded\]/u);
		expect(result).toMatchObject({ details: { patch: "preserved" }, isError: false });
	});

	it("passes through errors, mixed content, and reducer receipts", async () => {
		const sessionDir = await sessionRoot();
		const large = "x".repeat(THRESHOLD_BYTES + 100);
		const error = toolResult(large, { isError: true });
		const mixed = toolResult(large, {
			content: [
				{ type: "text", text: large },
				{ type: "image", data: "AA==", mimeType: "image/png" },
			],
		});
		const receipt = toolResult(`sol_pi_evidence_receipt_v1\n${large}`);
		const compoundReceipt = toolResult("", {
			toolName: "write",
			content: [
				{ type: "text", text: "Successfully wrote 12 bytes to target.ts" },
				{ type: "text", text: `[then_run:succeeded]\nsol_pi_evidence_receipt_v1\n${large}` },
			],
		});

		expect(await project(observationPackPi(), error, sessionDir, 3)).toEqual([large, large, large]);
		expect(await project(observationPackPi(), mixed, sessionDir, 3)).toEqual([large, large, large]);
		const receiptText = resultText(receipt);
		expect(await project(observationPackPi(), receipt, sessionDir, 3)).toEqual([receiptText, receiptText, receiptText]);
		const compoundText = resultText(compoundReceipt);
		expect(await project(observationPackPi(), compoundReceipt, sessionDir, 3)).toEqual([
			compoundText,
			compoundText,
			compoundText,
		]);
	});
});

/** Pi 1.0 codemode; Pi 0.84.2 does not ship it. */
const createCodemodeExtension = (piCodingAgent as unknown as Record<string, unknown>).createCodemodeExtension as
	| ((options: { mode: "on" | "only" }) => ExtensionFactory)
	| undefined;

type WireMessage = { role: string; toolCallId?: string; toolName?: string; content?: unknown };
type SessionMode = "direct" | "on" | "only";

function wireText(message: WireMessage | undefined): string {
	if (!message || !Array.isArray(message.content)) return typeof message?.content === "string" ? message.content : "";
	return (message.content as { type: string; text?: string }[])
		.flatMap((block) => (block.type === "text" && block.text !== undefined ? [block.text] : []))
		.join("\n");
}

/**
 * Drive ObservationPack through a real Pi AgentSession, extension runner and
 * agent loop (faux provider, no network). Prompt 1 produces one large tool
 * result; before prompt 2 the active tools change, which makes Pi 1.0 record a
 * mid-conversation tool-declaration system message; prompt 2 recalls the
 * packed observation. Returns every provider request as the provider saw it.
 */
async function runRealSession(mode: SessionMode, body: string) {
	const cwd = await sessionRoot();
	const agentDir = join(cwd, "agent");
	await mkdir(agentDir);
	const viaScript = mode === "only";
	const requests: WireMessage[][] = [];
	const record = (step: FauxResponseStep): FauxResponseStep =>
		async (context, options, state, model) => {
			requests.push(JSON.parse(JSON.stringify(context.messages)) as WireMessage[]);
			return typeof step === "function" ? await step(context, options, state, model) : step;
		};
	const call = (name: string, args: { [key: string]: string | number | boolean }, id: string) =>
		viaScript
			? fauxToolCall("codemode", { code: `text(await tools.${name}(${JSON.stringify(args)}));` }, { id })
			: fauxToolCall(name, args, { id });
	const faux = fauxProvider({
		provider: `sol-pi-op-${mode}`,
		api: `sol-pi-op-api-${mode}`,
		models: [{ id: `sol-pi-op-model-${mode}`, contextWindow: 128_000, maxTokens: 1_024 }],
	});
	const steps: FauxResponseStep[] = [
		fauxAssistantMessage(call("emit_output", { large: true }, "big-1"), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxText("first done")),
		fauxAssistantMessage(call("emit_output", { large: false }, "small-1"), { stopReason: "toolUse" }),
		(context) => {
			const big = (context.messages as WireMessage[]).find((message) => message.toolCallId === "big-1");
			const id = wireText(big).match(/id: (obs_[a-f0-9]{24})/u)?.[1] ?? "missing";
			return fauxAssistantMessage(call("obs_recall", { id, offset: 0 }, "recall-1"), { stopReason: "toolUse" });
		},
		fauxAssistantMessage(fauxText("second done")),
	];
	faux.setResponses(steps.map(record));
	const extension: ExtensionFactory = (pi) => {
		pi.registerProvider(faux.provider);
		pi.registerTool({
			name: "emit_output",
			label: "Emit Output",
			description: "Return a large or a small text result.",
			parameters: Type.Object({ large: Type.Boolean() }),
			async execute(_toolCallId, params) {
				return { content: [{ type: "text", text: params.large ? body : "small output" }], details: {} };
			},
		});
		createObservationPackExtension()(pi);
	};
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
		...(mode === "direct" ? {} : { defaultTools: ["+codemode"], codemode: { mode } }),
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		extensionFactories: [
			{ name: `observation-pack-session-${mode}`, factory: extension },
			...(mode === "direct" ? [] : [{ name: `codemode-${mode}`, factory: createCodemodeExtension!({ mode }) }]),
		],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: "You are a deterministic ObservationPack test assistant.",
	});
	await resourceLoader.reload();
	expect(resourceLoader.getExtensions().errors).toEqual([]);

	let session: AgentSession | undefined;
	try {
		const created = await createAgentSession({
			cwd,
			agentDir,
			model: faux.getModel(),
			thinkingLevel: "off",
			tools: ["emit_output", "obs_recall", "read", ...(mode === "direct" ? [] : ["codemode"])],
			resourceLoader,
			sessionManager: SessionManager.create(cwd, join(cwd, "sessions")),
			settingsManager,
		});
		session = created.session;
		const extensionErrors: string[] = [];
		session.extensionRunner.onError((error) => extensionErrors.push(`${error.event}: ${error.error}`));
		await session.prompt("produce output", { expandPromptTemplates: false, source: "interactive" });
		session.setActiveToolsByName(session.getActiveToolNames().filter((name) => name !== "read"));
		await session.prompt("recall it", { expandPromptTemplates: false, source: "interactive" });
		const stored = JSON.parse(JSON.stringify(session.messages)) as WireMessage[];
		return { requests, stored, extensionErrors, pending: faux.getPendingResponseCount() };
	} finally {
		session?.dispose();
	}
}

function expectRealSessionPacking(run: Awaited<ReturnType<typeof runRealSession>>, body: string, scriptTool: boolean) {
	expect(run.extensionErrors).toEqual([]);
	expect(run.pending).toBe(0);
	expect(run.requests).toHaveLength(5);
	const bigResult = (messages: WireMessage[]) => wireText(messages.find((message) => message.toolCallId === "big-1"));

	// Full for two provider requests, then one stable placeholder. A codemode
	// result wraps the script output, so compare against the stored result.
	const original = bigResult(run.stored);
	expect(original).toContain(body);
	expect(bigResult(run.requests[1]!)).toBe(original);
	expect(bigResult(run.requests[2]!)).toBe(original);
	const placeholder = bigResult(run.requests[3]!);
	expect(placeholder).toMatch(/^\[large tool result replaced/u);
	expect(placeholder).toMatch(scriptTool ? /tool: codemode/u : /tool: emit_output/u);
	expect(bigResult(run.requests[4]!)).toBe(placeholder);
	// Recall returns the original bytes.
	const recall = run.requests[4]!.find((message) => message.toolCallId === "recall-1");
	expect(recall?.toolName).toBe(scriptTool ? "codemode" : "obs_recall");
	expect(wireText(recall)).toMatch(/^\[obs_recall id=obs_[a-f0-9]{24} offset=0 /mu);
	expect(wireText(recall)).toContain(body.slice(0, 200));

	// Every request carries the transcript's message order, system messages
	// included. Codemode "only" hides the declarations of script-callable tools
	// from requests (and re-projects them when the loadout changes), so system
	// messages are compared with the transcript without their declarations.
	// Packing starts on the fourth request: from the loadout change on, every
	// system message must be sent byte-identically.
	const roles = (messages: WireMessage[]) => messages.map((message) => message.role);
	const withoutDeclarations = (message: WireMessage) => {
		const { toolsAdded: _added, toolsRemoved: _removed, ...rest } = message as WireMessage & Record<string, unknown>;
		return rest;
	};
	const finalRequest = run.requests[4]!;
	run.requests.forEach((request, requestIndex) => {
		expect(roles(request)).toEqual(roles(run.stored).slice(0, request.length));
		request.forEach((message, index) => {
			if (message.role !== "system") return;
			expect(withoutDeclarations(message)).toEqual(withoutDeclarations(run.stored[index]!));
			if (requestIndex >= 2) expect(message).toEqual(finalRequest[index]);
		});
	});
	// Pi 1.0 records a leading system message and a tool-declaration delta; Pi 0.84 neither.
	const systemIndices = roles(run.stored).flatMap((role, index) => (role === "system" ? [index] : []));
	if (systemIndices.length > 0) {
		expect(systemIndices[0]).toBe(0);
		expect(systemIndices.length).toBeGreaterThan(1);
		expect(roles(finalRequest).filter((role) => role === "system")).toHaveLength(systemIndices.length);
	}
}

describe("observation pack in a real Pi session", () => {
	it("packs direct tool results and keeps the transcript's system messages in place", async () => {
		const body = `real session\n${repeatPastThreshold("direct line\n")}`;
		expectRealSessionPacking(await runRealSession("direct", body), body, false);
	}, 20_000);
});

describe.skipIf(createCodemodeExtension === undefined)("observation pack with Pi codemode", () => {
	it('packs a codemode script result and recalls from a script in codemode "only" mode', async () => {
		const body = `codemode only\n${repeatPastThreshold("script line\n")}`;
		expectRealSessionPacking(await runRealSession("only", body), body, true);
	}, 20_000);

	it('packs direct tool results next to codemode in codemode "on" mode', async () => {
		const body = `codemode on\n${repeatPastThreshold("direct line\n")}`;
		expectRealSessionPacking(await runRealSession("on", body), body, false);
	}, 20_000);
});
