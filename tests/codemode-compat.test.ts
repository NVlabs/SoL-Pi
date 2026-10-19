/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * All four SoL-Pi mechanisms together under Pi codemode, through SoL-Pi's real
 * entrypoint and a real Pi AgentSession: real extension runner, real built-in
 * tools (bash included), real codemode sandbox, and faux providers for both the
 * main model and the reducer route (no network). Pi 0.84.2 has no codemode, so
 * the suite skips there.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { describe, expect, it } from "vitest";
import { loadSolPiConfig } from "../src/sol-pi/config.ts";
import { THEN_RUN_FAILED, THEN_RUN_SUCCEEDED } from "../src/sol-pi/extensions/action-fusion/index.ts";
import {
	DIAGNOSTIC_COMMAND,
	REDUCER_RECEIPT_PREFIX,
	REDUCER_RECEIPT_SCHEMA,
} from "../src/sol-pi/extensions/evidence-preserving-reducer/index.ts";
import { THRESHOLD_BYTES } from "../src/sol-pi/extensions/observation-pack/index.ts";
import {
	BOUNDARY_COMPACTION_INSTRUCTIONS,
	POST_COMPACTION_PLAN_REMINDER,
} from "../src/sol-pi/extensions/online-context-compact/extension.ts";
import { createSolPiExtension } from "../src/sol-pi/index.ts";

/** Pi 1.0 codemode; Pi 0.84.2 does not ship it. */
const createCodemodeExtension = (piCodingAgent as unknown as Record<string, unknown>).createCodemodeExtension as
	| ((options: { mode: "on" | "only" }) => ExtensionFactory)
	| undefined;

type CodemodeMode = "on" | "only";
type DeclaredTool = { name: string; description?: string; parameters?: { properties?: Record<string, unknown> } };
type WireMessage = {
	role: string;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	content?: unknown;
	customType?: string;
	toolsAdded?: DeclaredTool[];
	toolsRemoved?: (string | { name: string })[];
};
type ProviderRequest = { label: string; prompt: number; messages: WireMessage[]; tools: DeclaredTool[] };

const OPEN = [{ id: "ship", goal: "ship the fix", status: "in_progress" }] as const;
const DONE = [{ id: "ship", goal: "ship the fix", status: "completed" }] as const;
const PROGRESS = { files_changed: ["ok.txt"], verification: ["pytest passed"], decisions: ["kept it small"] };
const FAILURE_LINE = "ERROR tests/test_widget.py::test_render - AssertionError: widget mismatch";
const BIG_LINE = "observation payload ".repeat(4);
const BIG_LINES = 160;

/** A diagnostic-looking command (matches the reducer's DIAGNOSTIC_COMMAND) with a long, real output. */
function diagnosticCommand(exitCode: number): string {
	const failure = exitCode === 0 ? "" : `echo '${FAILURE_LINE}'; `;
	return [
		": pytest -q;",
		"i=1; while [ $i -le 90 ]; do",
		'echo "tests/test_widget.py::test_case_$i PASSED padding-padding-padding-padding";',
		"i=$((i+1)); done;",
		`${failure}echo '90 collected'; exit ${exitCode}`,
	].join(" ");
}

function wireText(message: WireMessage | undefined): string {
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return (message.content as { type: string; text?: string }[])
		.flatMap((block) => (block.type === "text" && block.text !== undefined ? [block.text] : []))
		.join("\n");
}

/** The same string hash the recall script computes inside the QuickJS sandbox. */
function djb2(value: string): number {
	let hash = 5381;
	for (let index = 0; index < value.length; index++) hash = ((hash * 33) ^ value.charCodeAt(index)) >>> 0;
	return hash;
}

/** Tools declared to the model: `context.tools` plus Pi 1.0 tool-declaration system messages. */
function declaredTools(context: { messages?: readonly unknown[]; tools?: readonly unknown[] }): DeclaredTool[] {
	const declared = new Map<string, DeclaredTool>();
	for (const tool of (context.tools ?? []) as DeclaredTool[]) declared.set(tool.name, tool);
	for (const message of (context.messages ?? []) as WireMessage[]) {
		if (message.role !== "system") continue;
		for (const tool of message.toolsRemoved ?? []) declared.delete(typeof tool === "string" ? tool : tool.name);
		for (const tool of message.toolsAdded ?? []) declared.set(tool.name, tool);
	}
	return [...declared.values()];
}

function codemodeSection(description: string, name: string): string | undefined {
	const start = description.indexOf(`### \`${name}\``);
	if (start < 0) return undefined;
	const end = description.indexOf("### `", start + 5);
	return description.slice(start, end < 0 ? undefined : end);
}

const BIG_SCRIPT = `text(${JSON.stringify(`codemode big observation\n`)} + ${JSON.stringify(`${BIG_LINE}\n`)}.repeat(${BIG_LINES}) + "big tail line");`;

const FUSION_SCRIPT = `
const out = { names: Object.keys(tools).sort() };
out.ok = await tools.write({ path: "ok.txt", content: "ok v1\\n", then_run: { command: "cat ok.txt" } });
try {
  const value = await tools.write({ path: "fail.txt", content: "fail v2\\n", then_run: { command: "echo fused-failure-output; exit 7" } });
  out.failed = { resolved: String(value) };
} catch (error) {
  out.failed = { rejected: String(error && error.message) };
}
try {
  await tools.update_plan({ steps: ${JSON.stringify(DONE)} });
  out.updatePlan = "resolved";
} catch (error) {
  out.updatePlan = "unavailable: " + String(error && error.message);
}
text(JSON.stringify(out));
`;

const REDUCER_SCRIPT = `
const out = {};
for (const [label, command] of [["exit0", ${JSON.stringify(diagnosticCommand(0))}], ["exit2", ${JSON.stringify(diagnosticCommand(2))}]]) {
  try {
    const value = await tools.bash({ command });
    out[label] = {
      type: typeof value,
      exit_code: value.exit_code,
      outputBytes: value.output.length,
      hasFailureLine: value.output.includes(${JSON.stringify(FAILURE_LINE)}),
      hasReceipt: value.output.includes(${JSON.stringify(REDUCER_RECEIPT_PREFIX)}),
    };
  } catch (error) {
    out[label] = { rejected: String(error && error.message) };
  }
}
text(JSON.stringify(out));
`;

function recallScript(id: string): string {
	return `
let offset = 0;
let all = "";
for (let page = 0; page < 20; page++) {
  const chunk = await tools.obs_recall({ id: ${JSON.stringify(id)}, offset });
  const first = chunk.indexOf("\\n");
  const second = chunk.indexOf("\\n", first + 1);
  all += chunk.slice(second + 1);
  const match = chunk.slice(0, first).match(/next_offset=(\\d+) eof=(true|false)/);
  if (!match || match[2] === "true") break;
  offset = Number(match[1]);
}
let hash = 5381;
for (let index = 0; index < all.length; index++) hash = ((hash * 33) ^ all.charCodeAt(index)) >>> 0;
text(JSON.stringify({ length: all.length, hash, head: all.slice(0, 80), tail: all.slice(-40) }));
`;
}

function scriptPayload(message: WireMessage | undefined): Record<string, unknown> {
	const text = wireText(message);
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end < start) throw new Error(`no JSON in script result: ${text.slice(0, 400)}`);
	return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
}

async function runCombinedSession(mode: CodemodeMode) {
	const cwd = await mkdtemp(join(tmpdir(), `sol-pi-codemode-${mode}-`));
	const agentDir = join(cwd, "agent");
	await mkdir(agentDir);
	await writeFile(join(cwd, "fail.txt"), "fail v1\n");

	const main = fauxProvider({
		provider: `sol-pi-cm-${mode}`,
		api: `sol-pi-cm-api-${mode}`,
		models: [{ id: `sol-pi-cm-model-${mode}`, contextWindow: 128_000, maxTokens: 1_024 }],
	});
	const reducer = fauxProvider({
		provider: `sol-pi-cm-reducer-${mode}`,
		api: `sol-pi-cm-reducer-api-${mode}`,
		models: [{ id: `sol-pi-cm-reducer-model-${mode}`, contextWindow: 128_000, maxTokens: 2_048 }],
	});
	await writeFile(
		join(agentDir, "sol-pi.json"),
		JSON.stringify({
			version: 1,
			actionFusion: true,
			observationPack: true,
			evidencePreservingReducer: true,
			onlineContextCompact: true,
			evidencePreservingReducerProvider: `sol-pi-cm-reducer-${mode}`,
			evidencePreservingReducerModel: `sol-pi-cm-reducer-model-${mode}`,
			// Free cache writes: any positive saving at a completed plan step is worth a compaction.
			cacheWriteReadRatio: 0,
		}),
	);

	// The reducer model answers with a receipt that quotes the log byte for byte.
	const reducerInputs: string[] = [];
	const receipt: FauxResponseStep = (context) => {
		const messages = context.messages as unknown as WireMessage[];
		const input = wireText(messages.find((message) => message.role === "user"));
		reducerInputs.push(input);
		const failed = /is_error=true/u.test(input);
		return fauxAssistantMessage(
			JSON.stringify({
				schema: REDUCER_RECEIPT_SCHEMA,
				source_sha256: input.match(/source_sha256=([a-f0-9]{64})/u)?.[1] ?? "missing",
				status: failed ? "failure" : "success",
				uncertain: false,
				evidence: failed ? [{ kind: "failure", quote: FAILURE_LINE }] : [{ kind: "summary", quote: "90 collected" }],
			}),
		);
	};
	reducer.setResponses([receipt, receipt, receipt, receipt]);

	// Scripted main-model turns; every request is recorded as the provider saw it.
	const requests: ProviderRequest[] = [];
	let prompt = 0;
	const step =
		(label: string, respond: (messages: WireMessage[]) => ReturnType<typeof fauxAssistantMessage>): FauxResponseStep =>
		(context) => {
			const messages = JSON.parse(JSON.stringify(context.messages)) as WireMessage[];
			const tools = declaredTools(JSON.parse(JSON.stringify(context)) as { messages?: unknown[]; tools?: unknown[] });
			requests.push({ label, prompt, messages, tools });
			return respond(messages);
		};
	const toolUse = (name: string, args: Parameters<typeof fauxToolCall>[1], id: string) =>
		fauxAssistantMessage(fauxToolCall(name, args, { id }), { stopReason: "toolUse" });
	const script = (code: string, id: string) => toolUse("codemode", { code }, id);
	const steps: FauxResponseStep[] = [
		// Prompt 1: a large script result.
		step("big", () => script(BIG_SCRIPT, "big-1")),
		step("big-done", () => fauxAssistantMessage(fauxText("big done"))),
		// Prompt 2 (new tool loadout): fused writes and diagnostic bash runs inside scripts. The large
		// result is packed from this prompt's second request on.
		step("fusion", () => script(FUSION_SCRIPT, "fusion-1")),
		step("reducer", () => script(REDUCER_SCRIPT, "reduce-1")),
		...(mode === "on"
			? [
					step("direct-bash", () => toolUse("bash", { command: diagnosticCommand(2) }, "direct-bash")),
					step("direct-write", () =>
						toolUse(
							"write",
							{ path: "direct.txt", content: "direct\n", then_run: { command: "cat direct.txt" } },
							"direct-write",
						),
					),
				]
			: []),
		step("work-done", () => fauxAssistantMessage(fauxText("work done"))),
		// Prompt 3: recall the packed observation from a script.
		step("recall", (messages) => {
			const big = messages.find((message) => message.toolCallId === "big-1");
			const id = wireText(big).match(/id: (obs_[a-f0-9]{24})/u)?.[1] ?? "missing";
			return script(recallScript(id), "recall-1");
		}),
		step("recall-done", () => fauxAssistantMessage(fauxText("recall done"))),
		// Prompt 4: a direct update_plan boundary that compacts, then the continuation turn.
		step("plan-open", () =>
			fauxAssistantMessage(
				[fauxText(`working notes ${"w".repeat(8_000)}`), fauxToolCall("update_plan", { steps: OPEN }, { id: "plan-open" })],
				{ stopReason: "toolUse" },
			),
		),
		step("plan-done", () => toolUse("update_plan", { steps: DONE, progress: PROGRESS }, "plan-done")),
		step("continuation", () => fauxAssistantMessage(fauxText("final after compaction"))),
	];
	main.setResponses(steps);

	const compactionRequests: { reason: string; customInstructions?: string }[] = [];
	const support: ExtensionFactory = (pi) => {
		pi.registerProvider(main.provider);
		pi.registerProvider(reducer.provider);
		// Deterministic summary instead of a summarization request to the main model.
		pi.on("session_before_compact", (event) => {
			compactionRequests.push({ reason: event.reason, customInstructions: event.customInstructions });
			return {
				compaction: {
					summary: "deterministic compacted history",
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
				},
			};
		});
	};
	// Pi 0.84.2's settings type has no codemode keys; the suite only runs where they exist.
	const codemodeSettings = { defaultTools: ["+codemode"], codemode: { mode } };
	const settingsManager = SettingsManager.inMemory({
		// Small kept tail, read by Online Context Compact through pi.getSettings().
		compaction: { enabled: false, keepRecentTokens: 150, reserveTokens: 1_024 },
		retry: { enabled: false },
		...codemodeSettings,
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		extensionFactories: [
			{ name: `codemode-compat-support-${mode}`, factory: support },
			{
				name: `sol-pi-${mode}`,
				factory: createSolPiExtension((ctx) => loadSolPiConfig(ctx.cwd, agentDir, false)),
			},
			{ name: `codemode-${mode}`, factory: createCodemodeExtension!({ mode }) },
		],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: "You are a deterministic SoL-Pi codemode compatibility test assistant.",
	});
	await resourceLoader.reload();
	expect(resourceLoader.getExtensions().errors).toEqual([]);

	// A recording TUI: Pi copies the context's own methods, so every method is spelled out.
	const notifications: string[] = [];
	const noop = () => undefined;
	const uiContext = {
		notify: (message: string) => void notifications.push(message),
		setStatus: noop,
		setWorkingMessage: noop,
		setWorkingVisible: noop,
		setWorkingIndicator: noop,
		setHiddenThinkingLabel: noop,
		setWidget: noop,
		setFooter: noop,
		setHeader: noop,
		setTitle: noop,
		onTerminalInput: () => noop,
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		editor: async () => undefined,
		custom: async () => undefined,
		pasteToEditor: noop,
		setEditorText: noop,
		getEditorText: () => "",
		getToolsExpanded: () => false,
		setToolsExpanded: noop,
	};

	let session: AgentSession | undefined;
	try {
		const created = await createAgentSession({
			cwd,
			agentDir,
			model: main.getModel(),
			thinkingLevel: "off",
			tools: ["read", "bash", "edit", "write", "obs_recall", "update_plan", "codemode"],
			resourceLoader,
			sessionManager: SessionManager.create(cwd, join(cwd, "sessions")),
			settingsManager,
		});
		session = created.session;
		const extensionErrors: string[] = [];
		// SoL-Pi registers its mechanisms from session_start, which binding emits.
		await session.bindExtensions({
			mode: "tui",
			uiContext: uiContext as never,
			onError: (error) => extensionErrors.push(`${error.event}: ${error.error}`),
		});
		let settled = 0;
		const compactionEnds: string[] = [];
		const nestedStarts: { toolName: string; parentToolCallId: string }[] = [];
		session.subscribe((event) => {
			if (event.type === "agent_settled") settled++;
			if (event.type === "compaction_end") compactionEnds.push(`${event.reason}${event.aborted ? ":aborted" : ""}`);
			if (event.type === "tool_execution_start") {
				const { parentToolCallId } = event as { parentToolCallId?: string };
				if (parentToolCallId !== undefined) nestedStarts.push({ toolName: event.toolName, parentToolCallId });
			}
		});

		const run = async (text: string) => {
			prompt++;
			await session!.prompt(text, { expandPromptTemplates: false, source: "interactive" });
		};
		await run("produce output");
		// A loadout change records a mid-conversation tool-declaration system message on Pi 1.0,
		// after the large result and before it gets packed.
		session.setActiveToolsByName(session.getActiveToolNames().filter((name) => name !== "read"));
		await run("do the work");
		await run("recall it");
		const storedBeforeCompaction = JSON.parse(JSON.stringify(session.messages)) as WireMessage[];
		await run("finish the plan");

		const branch = session.sessionManager.getBranch();
		return {
			requests,
			storedBeforeCompaction,
			stored: JSON.parse(JSON.stringify(session.messages)) as WireMessage[],
			extensionErrors,
			notifications,
			nestedStarts,
			compactionRequests,
			compactionEnds,
			compactions: branch.filter((entry) => entry.type === "compaction").length,
			settled,
			idle: session.isIdle && !session.isStreaming,
			pending: main.getPendingResponseCount(),
			reducerCalls: reducer.state.callCount,
			reducerInputs,
			files: {
				ok: await readFile(join(cwd, "ok.txt"), "utf8"),
				fail: await readFile(join(cwd, "fail.txt"), "utf8"),
			},
		};
	} finally {
		session?.dispose();
		await rm(cwd, { recursive: true, force: true });
	}
}

type CombinedRun = Awaited<ReturnType<typeof runCombinedSession>>;

function request(run: CombinedRun, label: string): ProviderRequest {
	const found = run.requests.find((candidate) => candidate.label === label);
	if (!found) throw new Error(`no provider request ${label}; saw ${run.requests.map((item) => item.label).join(",")}`);
	return found;
}

function resultIn(entry: ProviderRequest, toolCallId: string): WireMessage | undefined {
	return entry.messages.find((message) => message.role === "toolResult" && message.toolCallId === toolCallId);
}

describe.skipIf(createCodemodeExtension === undefined)("SoL-Pi with Pi codemode (all mechanisms)", () => {
	for (const mode of ["on", "only"] as const) {
		it(`runs all four mechanisms together in codemode "${mode}" mode`, async () => {
			expect(DIAGNOSTIC_COMMAND.test(diagnosticCommand(0))).toBe(true);
			const run = await runCombinedSession(mode);

			// 1. The whole session runs without extension errors and ends settled.
			expect(run.extensionErrors).toEqual([]);
			expect(run.pending).toBe(0);
			expect(run.idle).toBe(true);
			expect(run.requests.map((entry) => entry.label)).toEqual([
				"big",
				"big-done",
				"fusion",
				"reducer",
				...(mode === "on" ? ["direct-bash", "direct-write"] : []),
				"work-done",
				"recall",
				"recall-done",
				"plan-open",
				"plan-done",
				"continuation",
			]);

			// 2. Declarations.
			const first = run.requests[0]!.tools;
			const declared = (name: string) => first.find((tool) => tool.name === name);
			const codemodeDescription = declared("codemode")?.description ?? "";
			expect(declared("update_plan")).toBeDefined();
			expect(declared("update_plan")?.description).not.toMatch(/tools\.update_plan/u);
			expect(codemodeSection(codemodeDescription, "update_plan")).toBeUndefined();
			if (mode === "on") {
				for (const name of ["edit", "write"]) {
					expect(Object.keys(declared(name)?.parameters?.properties ?? {})).toContain("then_run");
					expect(declared(name)?.description).toContain(`tools.${name}(`);
				}
				expect(declared("obs_recall")?.description).toContain("tools.obs_recall(");
			} else {
				expect(first.map((tool) => tool.name).sort()).toEqual(["codemode", "update_plan"]);
				expect(codemodeSection(codemodeDescription, "write")).toMatch(/then_run/u);
				expect(codemodeSection(codemodeDescription, "edit")).toMatch(/then_run/u);
				expect(codemodeSection(codemodeDescription, "obs_recall")).toBeDefined();
			}

			// 3. Action Fusion inside a script.
			const fusion = scriptPayload(resultIn(request(run, "reducer"), "fusion-1")) as {
				names: string[];
				updatePlan: string;
				ok: unknown;
				failed: { resolved?: string; rejected?: string };
			};
			expect(fusion.names).toEqual(expect.arrayContaining(["bash", "edit", "obs_recall", "write"]));
			expect(fusion.names).not.toContain("update_plan");
			expect(fusion.names).not.toContain("codemode");
			expect(fusion.updatePlan).toMatch(/^unavailable: .*update_plan does not exist/u);
			expect(typeof fusion.ok).toBe("string");
			expect(fusion.ok).toContain(THEN_RUN_SUCCEEDED);
			expect(fusion.ok).toContain("ok v1");
			expect(fusion.failed.resolved).toBeUndefined();
			expect(fusion.failed.rejected).toMatch(/fail\.txt/u);
			expect(fusion.failed.rejected).toContain(THEN_RUN_FAILED);
			expect(fusion.failed.rejected).toContain("fused-failure-output");
			expect(fusion.failed.rejected).not.toContain(THEN_RUN_SUCCEEDED);
			expect(run.files).toEqual({ ok: "ok v1\n", fail: "fail v2\n" });
			const fusionNotices = run.notifications.filter((notice) => notice.includes("Action Fusion"));
			// Nested fused calls avoid no model round-trip; only the direct fused write ("on") announces one.
			expect(fusionNotices).toHaveLength(mode === "on" ? 1 : 0);

			// 4. Reducer: nested results stay structured and never reach the reducer model.
			const reduced = scriptPayload(resultIn(request(run, mode === "on" ? "direct-bash" : "work-done"), "reduce-1"));
			expect(reduced.exit0).toMatchObject({ type: "object", exit_code: 0, hasFailureLine: false, hasReceipt: false });
			expect(reduced.exit2).toMatchObject({ type: "object", exit_code: 2, hasFailureLine: true, hasReceipt: false });
			expect((reduced.exit0 as { outputBytes: number }).outputBytes).toBeGreaterThan(4_096);
			expect(run.nestedStarts.filter((start) => start.parentToolCallId === "reduce-1")).toEqual([
				{ toolName: "bash", parentToolCallId: "reduce-1" },
				{ toolName: "bash", parentToolCallId: "reduce-1" },
			]);
			if (mode === "on") {
				// A direct bash call with the same kind of output is reduced to a verified receipt.
				expect(run.reducerCalls).toBe(1);
				expect(run.reducerInputs[0]).toMatch(/is_error=true/u);
				const direct = resultIn(request(run, "direct-write"), "direct-bash");
				expect(direct?.isError).toBe(true);
				expect(wireText(direct)).toMatch(new RegExp(`^${REDUCER_RECEIPT_PREFIX}\\nstatus=failure`, "u"));
				expect(wireText(direct)).toContain(JSON.stringify(FAILURE_LINE));
			} else {
				expect(run.reducerCalls).toBe(0);
			}

			// 5. ObservationPack: the large script result is packed after two full sends and recalled from a script.
			const bigOriginal = wireText(run.storedBeforeCompaction.find((message) => message.toolCallId === "big-1"));
			expect(Buffer.byteLength(bigOriginal, "utf8")).toBeGreaterThan(THRESHOLD_BYTES);
			const preCompaction = run.requests.filter((entry) => entry.prompt < 4);
			const bigSends = preCompaction.slice(1).map((entry) => wireText(resultIn(entry, "big-1")));
			expect(bigSends[0]).toBe(bigOriginal);
			expect(bigSends[1]).toBe(bigOriginal);
			const placeholder = bigSends[2]!;
			expect(placeholder).toMatch(/^\[large tool result replaced/u);
			expect(placeholder).toMatch(/tool: codemode/u);
			for (const later of bigSends.slice(2)) expect(later).toBe(placeholder);
			const recalled = scriptPayload(resultIn(request(run, "recall-done"), "recall-1"));
			expect(recalled).toEqual({
				length: bigOriginal.length,
				hash: djb2(bigOriginal),
				head: bigOriginal.slice(0, 80),
				tail: bigOriginal.slice(-40),
			});
			expect(run.nestedStarts).toContainEqual({ toolName: "obs_recall", parentToolCallId: "recall-1" });

			// System messages keep their positions and bytes while packing: every request carries the
			// transcript's message order, and requests made with the same tool loadout send every
			// system message byte-identically, before and after the placeholder replaces the large
			// result. Codemode "only" hides script-callable declarations from requests (and re-projects
			// them when the loadout changes), so system messages are compared with the transcript
			// without their declaration lists.
			const roles = (messages: WireMessage[]) => messages.map((message) => message.role);
			const withoutDeclarations = (message: WireMessage) => {
				const { toolsAdded: _added, toolsRemoved: _removed, ...rest } = message;
				return rest;
			};
			const stored = run.storedBeforeCompaction;
			const systemIndices = roles(stored).flatMap((role, index) => (role === "system" ? [index] : []));
			const bigIndex = stored.findIndex((message) => message.toolCallId === "big-1");
			const delta = systemIndices.find((index) => index > bigIndex);
			expect(systemIndices[0]).toBe(0);
			expect(delta).toBeDefined();
			const loadouts = [
				preCompaction.filter((entry) => entry.prompt === 1),
				preCompaction.filter((entry) => entry.prompt > 1),
			];
			for (const group of loadouts) {
				const last = group.at(-1)!.messages;
				for (const entry of group) {
					expect(roles(entry.messages)).toEqual(roles(stored).slice(0, entry.messages.length));
					entry.messages.forEach((message, index) => {
						if (message.role !== "system") return;
						expect(withoutDeclarations(message)).toEqual(withoutDeclarations(stored[index]!));
						expect(message).toEqual(last[index]);
					});
				}
			}
			// The tool-declaration delta after the large result, in the last full send and the first packed one.
			expect(wireText(resultIn(request(run, "fusion"), "big-1"))).toBe(bigOriginal);
			expect(wireText(resultIn(request(run, "reducer"), "big-1"))).toBe(placeholder);
			expect(request(run, "fusion").messages[delta!]?.role).toBe("system");
			expect(request(run, "reducer").messages[delta!]).toEqual(request(run, "fusion").messages[delta!]);

			// 6. Online Context Compact: the direct update_plan boundary compacts and the task continues.
			expect(run.compactionRequests).toEqual([
				{ reason: "manual", customInstructions: BOUNDARY_COMPACTION_INSTRUCTIONS },
			]);
			expect(run.compactionEnds).toEqual(["manual"]);
			expect(run.compactions).toBe(1);
			const continuation = request(run, "continuation").messages;
			expect(continuation.some((message) => wireText(message).includes(POST_COMPACTION_PLAN_REMINDER))).toBe(true);
			expect(continuation.some((message) => message.toolCallId === "big-1")).toBe(false);
			expect(run.stored.at(-1)).toMatchObject({ role: "assistant" });
			expect(wireText(run.stored.at(-1))).toBe("final after compaction");
			// One settlement per prompt, plus the continuation's own.
			expect(run.settled).toBe(5);
		}, 30_000);
	}
});
