/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import {
	BOUNDARY_COMPACTION_INSTRUCTIONS,
	COMPACTION_FAILED_RESUME_REMINDER,
	createOnlineContextCompactExtension,
	POST_COMPACTION_PLAN_REMINDER,
} from "../src/sol-pi/extensions/online-context-compact/extension.ts";
import { ONLINE_STATE_ENTRY } from "../src/sol-pi/extensions/online-context-compact/state.ts";

const OPEN = [{ id: "build", goal: "build it", status: "in_progress" }] as const;
const DONE = [{ id: "build", goal: "build it", status: "completed" }] as const;
const PROGRESS = {
	files_changed: ["src/a.ts"],
	verification: ["tests passed"],
	decisions: ["kept the implementation small"],
};
const DEFAULT_COMPACTION = { enabled: false, keepRecentTokens: 150, reserveTokens: 1_024 };

/** Pi 1.0 codemode; Pi 0.84.2 does not ship it. */
const createCodemodeExtension = (piCodingAgent as unknown as Record<string, unknown>).createCodemodeExtension as
	| ((options: { mode: "on" | "only" }) => ExtensionFactory)
	| undefined;

type CompactionRequest = { customInstructions?: string; reason: string };
type ToolStart = { toolName: string; toolCallId: string; parentToolCallId?: string };
type ScenarioOptions = {
	readonly name: string;
	readonly responses: FauxResponseStep[];
	readonly contextWindow?: number;
	readonly compaction?: { enabled: boolean; keepRecentTokens: number; reserveTokens: number };
	readonly settings?: Record<string, unknown>;
	readonly tools?: string[];
	readonly extensions?: ExtensionFactory[];
	/** Let Pi summarize with the faux model instead of supplying a deterministic summary. */
	readonly providerSummary?: boolean;
};
type ScenarioRun = {
	readonly session: AgentSession;
	readonly sessionManager: SessionManager;
	readonly faux: ReturnType<typeof fauxProvider>;
	readonly extensionErrors: string[];
	readonly compactionRequests: CompactionRequest[];
	readonly compactionEnds: string[];
	readonly toolStarts: ToolStart[];
	readonly settledCount: () => number;
};

async function withScenario(options: ScenarioOptions, body: (run: ScenarioRun) => Promise<void>): Promise<void> {
	const cwd = await mkdtemp(join(tmpdir(), "sol-pi-occ-session-"));
	const agentDir = join(cwd, "agent");
	await mkdir(agentDir);

	let session: AgentSession | undefined;
	try {
		const faux = fauxProvider({
			provider: `sol-pi-occ-${options.name}`,
			api: `sol-pi-occ-api-${options.name}`,
			models: [{ id: `sol-pi-occ-model-${options.name}`, contextWindow: options.contextWindow ?? 4_096, maxTokens: 1_024 }],
		});
		faux.setResponses(options.responses);

		const compaction = options.compaction ?? DEFAULT_COMPACTION;
		const compactionRequests: CompactionRequest[] = [];
		// Registered before Online Context Compact, so it also sees requests that extension cancels.
		const recorder: ExtensionFactory = (pi) => {
			pi.on("session_before_compact", (event) => {
				compactionRequests.push({ customInstructions: event.customInstructions, reason: event.reason });
			});
		};
		const extension: ExtensionFactory = (pi) => {
			pi.registerProvider(faux.provider);
			createOnlineContextCompactExtension({ cacheWriteReadRatio: 0, keepRecentTokens: compaction.keepRecentTokens })(pi);
			if (options.providerSummary) return;
			pi.on("session_before_compact", (event) => ({
				compaction: {
					summary: `deterministic compacted history ${"s".repeat(6_000)}`,
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
				},
			}));
		};

		const settingsManager = SettingsManager.inMemory({
			compaction,
			retry: { enabled: false },
			...(options.settings ?? {}),
		});
		const sessionManager = SessionManager.inMemory(cwd);
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: `historical request ${"x".repeat(6_000)}` }],
			timestamp: Date.now() - 2,
		});
		sessionManager.appendMessage(fauxAssistantMessage(`historical response ${"y".repeat(6_000)}`));
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			extensionFactories: [
				{ name: `online-context-compact-recorder-${options.name}`, factory: recorder },
				{ name: `online-context-compact-session-test-${options.name}`, factory: extension },
				...(options.extensions ?? []).map((factory, index) => ({ name: `extra-${options.name}-${index}`, factory })),
			],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt: "You are a deterministic lifecycle test assistant.",
		});
		await resourceLoader.reload();
		expect(resourceLoader.getExtensions().errors).toEqual([]);

		const created = await createAgentSession({
			cwd,
			agentDir,
			model: faux.getModel(),
			thinkingLevel: "off",
			tools: options.tools ?? ["update_plan"],
			resourceLoader,
			sessionManager,
			settingsManager,
		});
		session = created.session;
		const extensionErrors: string[] = [];
		session.extensionRunner.onError((error) => extensionErrors.push(`${error.event}: ${error.error}`));
		let settledCount = 0;
		const compactionEnds: string[] = [];
		const toolStarts: ToolStart[] = [];
		session.subscribe((event) => {
			if (event.type === "agent_settled") settledCount++;
			if (event.type === "compaction_end") {
				compactionEnds.push(`${event.reason}${event.aborted ? ":aborted" : ""}`);
			}
			if (event.type === "tool_execution_start") {
				const { parentToolCallId } = event as { parentToolCallId?: string };
				toolStarts.push({
					toolName: event.toolName,
					toolCallId: event.toolCallId,
					...(parentToolCallId === undefined ? {} : { parentToolCallId }),
				});
			}
		});

		await session.prompt("finish the current plan step", {
			expandPromptTemplates: false,
			source: "interactive",
		});

		await body({
			session,
			sessionManager,
			faux,
			extensionErrors,
			compactionRequests,
			compactionEnds,
			toolStarts,
			settledCount: () => settledCount,
		});
		expect(session.isStreaming).toBe(false);
		expect(session.isIdle).toBe(true);
	} finally {
		session?.dispose();
		await rm(cwd, { recursive: true, force: true });
	}
}

function boundaryResponses(ordinal: number, workText?: string): FauxResponseStep[] {
	const openPlan = fauxToolCall("update_plan", { steps: OPEN }, { id: `plan-open-${ordinal}` });
	return [
		fauxAssistantMessage(workText === undefined ? openPlan : [fauxText(workText), openPlan], { stopReason: "toolUse" }),
		fauxAssistantMessage(
			fauxToolCall("update_plan", { steps: DONE, progress: PROGRESS }, { id: `plan-done-${ordinal}` }),
			{ stopReason: "toolUse" },
		),
	];
}

function slowFinalReply(text: string): FauxResponseStep {
	return async () => {
		await new Promise((resolve) => setTimeout(resolve, 80));
		return fauxAssistantMessage(text);
	};
}

/**
 * Pi's faux provider does not call `onPayload`, so it never emits `before_provider_request`.
 * Call it the way Pi's built-in providers do before they send a request.
 */
function withPayloadHook(step: FauxResponseStep): FauxResponseStep {
	return async (context, options, state, model) => {
		await options?.onPayload?.({ messages: context.messages }, model);
		return typeof step === "function" ? await step(context, options, state, model) : step;
	};
}

/** The latest Online Context Compact state entry. */
function onlineState(sessionManager: SessionManager): Record<string, unknown> | undefined {
	const states = sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === ONLINE_STATE_ENTRY);
	const latest = states.at(-1);
	return latest?.type === "custom" ? (latest.data as Record<string, unknown>) : undefined;
}

function reminders(sessionManager: SessionManager, content: string): number {
	return sessionManager
		.getBranch()
		.filter(
			(entry) =>
				entry.type === "custom_message" &&
				entry.customType === "sol-pi-online-context-compact" &&
				entry.content === content &&
				entry.display === false,
		).length;
}

type DeclaredTool = { readonly name: string; readonly description: string };

/** Tools declared to the model by Pi 1.0 system messages, after any loadout hook hid some. */
function declaredTools(context: unknown): DeclaredTool[] {
	const declared = new Map<string, DeclaredTool>();
	for (const message of (context as { messages?: readonly unknown[] }).messages ?? []) {
		const system = message as {
			role?: string;
			toolsAdded?: readonly DeclaredTool[];
			toolsRemoved?: readonly (string | { name: string })[];
		};
		if (system.role !== "system") continue;
		for (const tool of system.toolsRemoved ?? []) declared.delete(typeof tool === "string" ? tool : tool.name);
		for (const tool of system.toolsAdded ?? []) declared.set(tool.name, tool);
	}
	return [...declared.values()];
}

function compactions(sessionManager: SessionManager): number {
	return sessionManager.getBranch().filter((entry) => entry.type === "compaction").length;
}

async function runCompactionScenario(requestedCompactions: 1 | 2): Promise<void> {
	const finalReply = `final reply after ${requestedCompactions} online compaction${requestedCompactions === 1 ? "" : "s"}`;
	const responses: FauxResponseStep[] = [];
	for (let ordinal = 1; ordinal <= requestedCompactions; ordinal++) {
		responses.push(...boundaryResponses(ordinal, ordinal === 1 ? undefined : `second phase work ${"z".repeat(6_000)}`));
	}
	responses.push(slowFinalReply(finalReply));

	await withScenario({ name: `boundary-${requestedCompactions}`, responses }, async (run) => {
		expect(run.extensionErrors).toEqual([]);
		expect(run.compactionRequests).toEqual(
			Array.from({ length: requestedCompactions }, () => ({
				customInstructions: expect.stringContaining('"stepId":"build","goal":"build it"'),
				reason: "manual",
			})),
		);
		for (const request of run.compactionRequests) {
			expect(request.customInstructions).toContain(BOUNDARY_COMPACTION_INSTRUCTIONS);
			expect(request.customInstructions).toContain('"filesChanged":["src/a.ts"]');
			expect(request.customInstructions).toContain('"verification":["tests passed"]');
		}
		expect(compactions(run.sessionManager)).toBe(requestedCompactions);
		expect(reminders(run.sessionManager, POST_COMPACTION_PLAN_REMINDER)).toBe(requestedCompactions);
		expect(run.faux.state.callCount).toBe(requestedCompactions * 2 + 1);
		expect(run.session.getLastAssistantText()).toBe(finalReply);
		expect(run.settledCount()).toBe(requestedCompactions + 1);
	});
}

describe("Online Context Compact with a real AgentSession", () => {
	it("settles the automatic continuation before the original prompt returns", async () => {
		await runCompactionScenario(1);
	}, 10_000);

	it("settles two consecutive automatic compactions before the original prompt returns", async () => {
		await runCompactionScenario(2);
	}, 10_000);

	for (const rekey of [false, true]) {
		it(`compacts once after repeated ${rekey ? "re-keyed" : "identical"} completed plans past the cooldown`, async () => {
			const reissued = Array.from({ length: 3 }, (_, index) => [{
				id: rekey ? `restated-${index}` : "build",
				goal: rekey ? `build it (restated ${index})` : "build it",
				status: "completed",
			}]);
			const finalReply = `final after ${rekey ? "re-keyed" : "identical"} restatements`;
			const responses: FauxResponseStep[] = [
				...boundaryResponses(1),
				...reissued.map((steps, index) => fauxAssistantMessage(
					fauxToolCall("update_plan", { steps }, { id: `reissue-${index}` }),
					{ stopReason: "toolUse" },
				)),
				slowFinalReply(finalReply),
			];
			await withScenario({ name: `restatement-${rekey}`, responses: responses.map(withPayloadHook) }, async (run) => {
				expect(run.extensionErrors).toEqual([]);
				expect(run.compactionRequests).toEqual([
					{ customInstructions: expect.stringContaining('"stepId":"build","goal":"build it"'), reason: "manual" },
				]);
				expect(compactions(run.sessionManager)).toBe(1);
				expect(reminders(run.sessionManager, POST_COMPACTION_PLAN_REMINDER)).toBe(1);
				expect(run.faux.state.callCount).toBe(6);
				expect(onlineState(run.sessionManager)).toMatchObject({
					requestCount: 6,
					nativeCompactionCount: 1,
					completedBoundaryRequestCounts: [2],
				});
				expect(run.session.getLastAssistantText()).toBe(finalReply);
				expect(run.settledCount()).toBe(2);
			});
		}, 10_000);
	}

	it("records genuine progress on the first plan update after native compaction", async () => {
		const verify = { id: "verify", goal: "verify it", status: "pending" } as const;
		const completed = [DONE[0], { ...verify, status: "completed" }] as const;
		const responses: FauxResponseStep[] = [
			fauxAssistantMessage(fauxToolCall("update_plan", { steps: [...OPEN, verify] }, { id: "open-two" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("update_plan", { steps: [...DONE, verify], progress: PROGRESS }, { id: "first-done" }), { stopReason: "toolUse" }),
			// No redundant plan-restatement call precedes this real completion.
			fauxAssistantMessage(fauxToolCall("update_plan", { steps: completed, progress: PROGRESS }, { id: "second-done" }), { stopReason: "toolUse" }),
			slowFinalReply("final after genuine progress"),
		];
		await withScenario({ name: "first-real-progress", responses: responses.map(withPayloadHook) }, async (run) => {
			expect(run.extensionErrors).toEqual([]);
			expect(onlineState(run.sessionManager)).toMatchObject({
				plan: completed,
				completedBoundaryRequestCounts: [2, 1],
				requestCount: 4,
			});
			const result = run.sessionManager.getBranch().find((entry) =>
				entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "second-done",
			);
			expect(result).toMatchObject({ message: { details: {
				boundary: true, completed_step_ids: ["verify"], progress_recorded: true,
			} } });
			expect(run.session.getLastAssistantText()).toBe("final after genuine progress");
		});
	}, 10_000);

	it("counts each provider request once across consecutive boundary compactions", async () => {
		const responses = [
			...boundaryResponses(1),
			...boundaryResponses(2, `second phase work ${"z".repeat(6_000)}`),
			slowFinalReply("final after counted requests"),
		].map(withPayloadHook);
		await withScenario({ name: "request-count", responses }, async (run) => {
			expect(run.extensionErrors).toEqual([]);
			expect(compactions(run.sessionManager)).toBe(2);
			expect(run.session.getLastAssistantText()).toBe("final after counted requests");
			// Each boundary stop makes Pi build one more request whose run is already aborted; it never
			// reaches the provider and is not counted.
			expect(run.faux.state.callCount).toBe(5);
			expect(onlineState(run.sessionManager)).toMatchObject({
				requestCount: 5,
				completedBoundaryRequestCounts: [2, 2],
			});
		});
	}, 10_000);

	it("keeps its selected boundary compaction when Pi's threshold compaction is enabled", async () => {
		const done = fauxToolCall("update_plan", { steps: DONE, progress: PROGRESS }, { id: "plan-done" });
		await withScenario(
			{
				name: "threshold",
				contextWindow: 10_000,
				compaction: { enabled: true, keepRecentTokens: 150, reserveTokens: 2_000 },
				responses: [
					fauxAssistantMessage(fauxToolCall("update_plan", { steps: OPEN }, { id: "plan-open" }), {
						stopReason: "toolUse",
					}),
					fauxAssistantMessage([fauxText("w".repeat(22_000)), done], { stopReason: "toolUse" }),
					fauxAssistantMessage("final after threshold"),
					fauxAssistantMessage("unexpected extra request"),
				],
			},
			async (run) => {
				expect(run.extensionErrors).toEqual([]);
				// Pi attempts its own threshold compaction for the stopped run: 0.84.4+ before the run's next
				// request, 0.84.2 after the run because the aborted faux request ends with an error stop.
				expect(run.compactionEnds).toEqual(["threshold:aborted", "manual"]);
				expect(run.compactionRequests.filter((request) => request.reason !== "threshold")).toEqual([
					{ customInstructions: expect.stringContaining('"stepId":"build","goal":"build it"'), reason: "manual" },
				]);
				expect(compactions(run.sessionManager)).toBe(1);
				expect(reminders(run.sessionManager, POST_COMPACTION_PLAN_REMINDER)).toBe(1);
				expect(run.faux.state.callCount).toBe(3);
				expect(run.session.getLastAssistantText()).toBe("final after threshold");
			},
		);
	}, 10_000);

	it("resumes the stopped task when its boundary compaction fails", async () => {
		await withScenario(
			{
				name: "failed-compaction",
				providerSummary: true,
				responses: [
					...boundaryResponses(1),
					fauxAssistantMessage("", { stopReason: "error", errorMessage: "summary provider unavailable" }),
					slowFinalReply("final after failed compaction"),
				],
			},
			async (run) => {
				expect(run.compactionRequests).toEqual([
					{ customInstructions: expect.stringContaining('"stepId":"build","goal":"build it"'), reason: "manual" },
				]);
				expect(compactions(run.sessionManager)).toBe(0);
				expect(reminders(run.sessionManager, POST_COMPACTION_PLAN_REMINDER)).toBe(0);
				expect(reminders(run.sessionManager, COMPACTION_FAILED_RESUME_REMINDER)).toBe(1);
				expect(run.session.getLastAssistantText()).toBe("final after failed compaction");
				expect(run.faux.state.callCount).toBe(4);
				// The failure itself is still reported once.
				expect(run.extensionErrors).toHaveLength(1);
				expect(run.extensionErrors[0]).toMatch(/^agent_settled: .*summary provider unavailable/u);
			},
		);
	}, 10_000);

	it("resumes after a failed boundary compaction when Pi's threshold compaction is enabled", async () => {
		const done = fauxToolCall("update_plan", { steps: DONE, progress: PROGRESS }, { id: "plan-done" });
		let resumeRequests = 0;
		// Pi 1.2+ checks its threshold before the resumed run's first request, so its own compaction runs
		// before the continuation; Pi 1.0.4 runs it after the continuation. Answer summaries and the
		// continuation by content so both orders are covered.
		const answer: FauxResponseStep = async (context) => {
			const last = context.messages.at(-1);
			const text = last?.role === "user" && Array.isArray(last.content)
				? last.content.map((part) => (part.type === "text" ? part.text : "")).join("")
				: "";
			if (text === COMPACTION_FAILED_RESUME_REMINDER) {
				resumeRequests++;
				return fauxAssistantMessage("final after failed compaction under threshold");
			}
			return fauxAssistantMessage(`threshold summary ${"t".repeat(200)}`);
		};
		await withScenario(
			{
				name: "failed-threshold",
				providerSummary: true,
				contextWindow: 10_000,
				compaction: { enabled: true, keepRecentTokens: 150, reserveTokens: 2_000 },
				responses: [
					fauxAssistantMessage(fauxToolCall("update_plan", { steps: OPEN }, { id: "plan-open" }), {
						stopReason: "toolUse",
					}),
					fauxAssistantMessage([fauxText("w".repeat(22_000)), done], { stopReason: "toolUse" }),
					fauxAssistantMessage("", { stopReason: "error", errorMessage: "summary provider unavailable" }),
					answer,
					answer,
					answer,
					fauxAssistantMessage("unexpected extra request"),
				],
			},
			async (run) => {
				// The boundary compaction fails; Pi's own threshold compaction then succeeds.
				expect(run.compactionEnds).toEqual(["threshold:aborted", "manual", "threshold"]);
				expect(compactions(run.sessionManager)).toBe(1);
				expect(reminders(run.sessionManager, POST_COMPACTION_PLAN_REMINDER)).toBe(0);
				expect(reminders(run.sessionManager, COMPACTION_FAILED_RESUME_REMINDER)).toBe(1);
				// Pi's compaction keeps the resume reminder, so the model still sees it and continues once.
				expect(resumeRequests).toBe(1);
				expect(run.session.getLastAssistantText()).toBe("final after failed compaction under threshold");
				expect(run.faux.state.callCount).toBe(6);
				expect(run.settledCount()).toBe(2);
				expect(run.extensionErrors).toHaveLength(1);
				expect(run.extensionErrors[0]).toMatch(/^agent_settled: .*summary provider unavailable/u);
			},
		);
	}, 10_000);
});

describe.skipIf(createCodemodeExtension === undefined)("Online Context Compact with Pi codemode", () => {
	for (const mode of ["on", "only"] as const) {
		it(`keeps update_plan model-only and compacts at a direct boundary in codemode "${mode}" mode`, async () => {
			const scriptAttempt = [
				"try {",
				`  await tools.update_plan({ steps: ${JSON.stringify(DONE)} });`,
				'  text("update_plan resolved");',
				"} catch (error) {",
				'  text("update_plan unavailable: " + String(error && error.message));',
				"}",
				'text("tools: " + Object.keys(tools).sort().join(","));',
			].join("\n");
			let firstRequest:
				| { declared: string[]; codemodeDescription: string; readDescription: string; updatePlanDescription: string }
				| undefined;
			let scriptOutput = "";
			const route = (step: FauxResponseStep): FauxResponseStep =>
				async (context, options, state, model) => {
					if (!firstRequest) {
						const tools = declaredTools(context);
						firstRequest = {
							declared: tools.map((tool) => tool.name).sort(),
							codemodeDescription: tools.find((tool) => tool.name === "codemode")?.description ?? "",
							readDescription: tools.find((tool) => tool.name === "read")?.description ?? "",
							updatePlanDescription: tools.find((tool) => tool.name === "update_plan")?.description ?? "",
						};
					}
					const last = context.messages.at(-1);
					if (last?.role === "toolResult" && last.toolName === "codemode") {
						scriptOutput = last.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
					}
					return typeof step === "function" ? await step(context, options, state, model) : step;
				};

			await withScenario(
				{
					name: `codemode-${mode}`,
					tools: ["read", "update_plan", "codemode"],
					settings: { defaultTools: ["+codemode"], codemode: { mode } },
					extensions: [createCodemodeExtension!({ mode })],
					responses: [
						fauxAssistantMessage(fauxToolCall("codemode", { code: scriptAttempt }, { id: "script-1" }), {
							stopReason: "toolUse",
						}),
						...boundaryResponses(1),
						slowFinalReply(`final after codemode ${mode}`),
					].map((step) => route(withPayloadHook(step))),
				},
				async (run) => {
					expect(run.extensionErrors).toEqual([]);
					// update_plan stays declared to the model, and codemode never offers it to scripts.
					expect(firstRequest?.declared).toContain("codemode");
					expect(firstRequest?.declared).toContain("update_plan");
					expect(firstRequest?.declared.includes("read")).toBe(mode === "on");
					expect(firstRequest?.codemodeDescription).not.toMatch(/update_plan/u);
					expect(firstRequest?.updatePlanDescription).not.toMatch(/tools\.update_plan/u);
					// A direct tool, for contrast: described as script-callable ("on") or listed by codemode ("only").
					if (mode === "on") expect(firstRequest?.readDescription).toMatch(/tools\.read\(/u);
					else expect(firstRequest?.codemodeDescription).toMatch(/### `read`/u);
					expect(scriptOutput).toMatch(/update_plan unavailable/u);
					expect(scriptOutput).not.toMatch(/update_plan resolved/u);
					expect(scriptOutput).not.toMatch(/tools: .*update_plan/u);
					expect(run.toolStarts.filter((start) => start.toolName === "update_plan")).toEqual([
						{ toolName: "update_plan", toolCallId: "plan-open-1" },
						{ toolName: "update_plan", toolCallId: "plan-done-1" },
					]);

					// The direct boundary compacts and the continuation runs.
					expect(run.compactionRequests).toEqual([
						{ customInstructions: expect.stringContaining('"stepId":"build","goal":"build it"'), reason: "manual" },
					]);
					expect(run.compactionRequests[0]?.customInstructions).toContain(BOUNDARY_COMPACTION_INSTRUCTIONS);
					expect(run.compactionRequests[0]?.customInstructions).toContain('"verification":["tests passed"]');
					expect(compactions(run.sessionManager)).toBe(1);
					expect(reminders(run.sessionManager, POST_COMPACTION_PLAN_REMINDER)).toBe(1);
					expect(run.faux.state.callCount).toBe(4);
					expect(run.session.getLastAssistantText()).toBe(`final after codemode ${mode}`);
					expect(run.settledCount()).toBe(2);
					// The codemode script runs inside one request; every provider request is counted once.
					expect(onlineState(run.sessionManager)).toMatchObject({ requestCount: 4 });
				},
			);
		}, 20_000);
	}
});
