/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	createOnlineContextCompactExtension,
	POST_COMPACTION_PLAN_REMINDER,
} from "../src/sol-pi/extensions/online-context-compact/extension.ts";

const OPEN = [{ id: "build", goal: "build it", status: "in_progress" }] as const;
const DONE = [{ id: "build", goal: "build it", status: "completed" }] as const;
const PROGRESS = {
	files_changed: ["src/a.ts"],
	verification: ["tests passed"],
	decisions: ["kept the implementation small"],
};

type CompactionRequest = { customInstructions?: string; reason: string };

async function runCompactionScenario(requestedCompactions: 1 | 2): Promise<void> {
	const cwd = await mkdtemp(join(tmpdir(), "sol-pi-occ-session-"));
	const agentDir = join(cwd, "agent");
	await mkdir(agentDir);

	let session: AgentSession | undefined;
	try {
		const finalReply = `final reply after ${requestedCompactions} online compaction${requestedCompactions === 1 ? "" : "s"}`;
		const faux = fauxProvider({
			provider: `sol-pi-occ-session-${requestedCompactions}`,
			api: `sol-pi-occ-session-api-${requestedCompactions}`,
			models: [{ id: `sol-pi-occ-session-model-${requestedCompactions}`, contextWindow: 4_096, maxTokens: 1_024 }],
		});
		const responses: FauxResponseStep[] = [];
		for (let ordinal = 1; ordinal <= requestedCompactions; ordinal++) {
			const openPlan = fauxToolCall("update_plan", { steps: OPEN }, { id: `plan-open-${ordinal}` });
			responses.push(
				fauxAssistantMessage(
					ordinal === 1 ? openPlan : [fauxText(`second phase work ${"z".repeat(6_000)}`), openPlan],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					fauxToolCall(
						"update_plan",
						{ steps: DONE, progress: PROGRESS },
						{ id: `plan-done-${ordinal}` },
					),
					{ stopReason: "toolUse" },
				),
			);
		}
		responses.push(async () => {
			await new Promise((resolve) => setTimeout(resolve, 80));
			return fauxAssistantMessage(finalReply);
		});
		faux.setResponses(responses);

		const compactionRequests: CompactionRequest[] = [];
		const extension: ExtensionFactory = (pi) => {
			pi.registerProvider(faux.provider);
			createOnlineContextCompactExtension({ cacheWriteReadRatio: 0, keepRecentTokens: 150 })(pi);
			pi.on("session_before_compact", (event) => {
				compactionRequests.push({ customInstructions: event.customInstructions, reason: event.reason });
				return {
					compaction: {
						summary: `deterministic compacted history ${"s".repeat(6_000)}`,
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
					},
				};
			});
		};

		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false, keepRecentTokens: 150, reserveTokens: 1_024 },
			retry: { enabled: false },
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
			extensionFactories: [{ name: `online-context-compact-session-test-${requestedCompactions}`, factory: extension }],
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
			tools: ["update_plan"],
			resourceLoader,
			sessionManager,
			settingsManager,
		});
		session = created.session;
		let settledCount = 0;
		session.subscribe((event) => {
			if (event.type === "agent_settled") settledCount++;
		});

		await session.prompt("finish the current plan step", {
			expandPromptTemplates: false,
			source: "interactive",
		});

		expect(compactionRequests).toEqual(
			Array.from({ length: requestedCompactions }, () => ({
				customInstructions: BOUNDARY_COMPACTION_INSTRUCTIONS,
				reason: "manual",
			})),
		);
		const branch = sessionManager.getBranch();
		expect(branch.filter((entry) => entry.type === "compaction")).toHaveLength(requestedCompactions);
		expect(
			branch.filter(
				(entry) =>
					entry.type === "custom_message" &&
					entry.customType === "sol-pi-online-context-compact" &&
					entry.content === POST_COMPACTION_PLAN_REMINDER &&
					entry.display === false,
			),
		).toHaveLength(requestedCompactions);
		expect(faux.state.callCount).toBe(requestedCompactions * 2 + 1);
		expect(session.getLastAssistantText()).toBe(finalReply);
		expect(settledCount).toBe(requestedCompactions + 1);
		expect(session.isStreaming).toBe(false);
		expect(session.isIdle).toBe(true);
	} finally {
		session?.dispose();
		await rm(cwd, { recursive: true, force: true });
	}
}

describe("Online Context Compact with a real AgentSession", () => {
	it("settles the automatic continuation before the original prompt returns", async () => {
		await runCompactionScenario(1);
	}, 10_000);

	it("settles two consecutive automatic compactions before the original prompt returns", async () => {
		await runCompactionScenario(2);
	}, 10_000);
});
