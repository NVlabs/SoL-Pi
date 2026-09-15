/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CONFIG_DIR_NAME,
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/sol-pi/config.ts";

it("loads the package entrypoint and executes fused tools in an all-enabled Pi session", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "sol-pi-package-"));
	const agentDir = join(cwd, "agent");
	let session: AgentSession | undefined;
	try {
		await mkdir(agentDir);
		await mkdir(join(cwd, CONFIG_DIR_NAME));
		await writeFile(join(cwd, CONFIG_DIR_NAME, "sol-pi.json"), JSON.stringify({
			...DEFAULT_CONFIG,
			actionFusion: true,
			observationPack: true,
			evidencePreservingReducer: true,
			onlineContextCompact: true,
		}));
		const faux = fauxProvider({ provider: "sol-pi-package-test", api: "sol-pi-package-test-api" });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("write", {
				path: "result.txt",
				content: "package integration passed\n",
				then_run: { command: "cat result.txt" },
			}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("update_plan", {
				steps: [{ id: "verify", goal: "verify the package", status: "in_progress" }],
			}), { stopReason: "toolUse" }),
			fauxAssistantMessage("package smoke complete"),
		]);
		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
		}, { projectTrusted: true });
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			additionalExtensionPaths: [join(process.cwd(), "src/sol-pi/index.ts")],
			extensionFactories: [{ name: "package-test-provider", factory: (pi) => pi.registerProvider(faux.provider) }],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt: "You are a deterministic package integration test assistant.",
		});
		await resourceLoader.reload();
		expect(resourceLoader.getExtensions().errors).toEqual([]);
		const sessionManager = SessionManager.create(cwd, join(agentDir, "sessions"));
		({ session } = await createAgentSession({
			cwd,
			agentDir,
			model: faux.getModel(),
			thinkingLevel: "off",
			resourceLoader,
			sessionManager,
			settingsManager,
		}));
		const errors: unknown[] = [];
		await session.bindExtensions({ onError: (error) => errors.push(error) });
		expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["edit", "write", "obs_recall", "update_plan"]));
		const solPi = resourceLoader.getExtensions().extensions.find((extension) => extension.path.endsWith("src/sol-pi/index.ts"));
		expect(solPi?.handlers.has("tool_result")).toBe(true);
		expect(solPi?.handlers.has("context")).toBe(true);
		expect(solPi?.handlers.has("agent_settled")).toBe(true);

		await session.prompt("run the package smoke test", { expandPromptTemplates: false });
		const toolResults = sessionManager.getBranch().flatMap((entry) =>
			entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : [],
		);
		expect(toolResults).toHaveLength(2);
		expect(toolResults.every((result) => !result.isError)).toBe(true);
		const writeResult = toolResults.find((result) => result.toolName === "write");
		const observation = writeResult?.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
		expect(observation).toContain("[then_run:succeeded]");
		expect(observation).toContain("package integration passed");
		expect(await readFile(join(cwd, "result.txt"), "utf8")).toBe("package integration passed\n");
		expect(session.getLastAssistantText()).toBe("package smoke complete");
		expect(session.isIdle).toBe(true);
		expect(faux.state.callCount).toBe(3);
		expect(errors).toEqual([]);
	} finally {
		session?.dispose();
		await rm(cwd, { recursive: true, force: true });
	}
}, 30_000);
