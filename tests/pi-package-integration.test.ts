/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
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

it.each(["persistent", "in-memory"])("loads the package and executes fused tools in an all-enabled %s Pi session", async (storage) => {
	const cwd = await mkdtemp(join(tmpdir(), "sol-pi-package-"));
	const agentDir = join(cwd, "agent");
	let session: AgentSession | undefined;
	let ephemeralSessionId: string | undefined;
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
		const sessionManager = storage === "persistent"
			? SessionManager.create(cwd, join(agentDir, "sessions"))
			: SessionManager.inMemory(cwd);
		if (storage === "in-memory") ephemeralSessionId = sessionManager.getSessionId();
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
		const solPi = resourceLoader.getExtensions().extensions.find((extension) =>
			extension.path.split("\\").join("/").endsWith("src/sol-pi/index.ts")
		);
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
		if (ephemeralSessionId) {
			const roots = (await readdir(tmpdir())).filter((name) => name.startsWith(`sol-pi-${ephemeralSessionId}-`));
			await Promise.all(roots.map((name) => rm(join(tmpdir(), name), { recursive: true, force: true })));
		}
		await rm(cwd, { recursive: true, force: true });
	}
}, 30_000);

it("archives tool output with the real Pi --no-session CLI and retains it after exit", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "sol-pi-no-session-"));
	try {
		const agentDir = join(cwd, "agent");
		const temporaryDir = join(cwd, "tmp");
		await mkdir(agentDir);
		await mkdir(temporaryDir);
		await mkdir(join(cwd, CONFIG_DIR_NAME));
		await writeFile(join(cwd, CONFIG_DIR_NAME, "sol-pi.json"), JSON.stringify({
			...DEFAULT_CONFIG,
			actionFusion: true,
			observationPack: true,
			evidencePreservingReducer: true,
			onlineContextCompact: true,
		}));
		const body = "ephemeral CLI evidence\n".repeat(800);
		await writeFile(join(cwd, "evidence.txt"), body);
		const providerPath = join(cwd, "test-provider.ts");
		const fauxPath = fileURLToPath(import.meta.resolve("@earendil-works/pi-ai/providers/faux"));
		await writeFile(providerPath, `
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(fauxPath)};
export default function (pi) {
	const faux = fauxProvider({
		provider: "sol-pi-no-session-test", api: "sol-pi-no-session-test-api",
		models: [{ id: "ephemeral", contextWindow: 200000, maxTokens: 4096 }],
	});
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("read", { path: "evidence.txt" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("no-session smoke complete"),
	]);
	pi.registerProvider(faux.provider);
	pi.on("session_start", (_event, ctx) => {
		if (ctx.sessionManager.getSessionDir() || ctx.sessionManager.getSessionFile()) {
			throw new Error("Expected an ephemeral CLI session");
		}
	});
}
`);
		const piDist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
		const running = promisify(execFile)(process.execPath, [
			join(piDist, "bundle/cli.js"), "--offline", "--approve", "--no-session",
			"--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
			"-e", join(process.cwd(), "src/sol-pi/index.ts"), "-e", providerPath,
			"--provider", "sol-pi-no-session-test", "--model", "ephemeral",
			"--thinking", "off", "-p", "read the evidence",
		], {
			cwd,
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, TMPDIR: temporaryDir, TMP: temporaryDir, TEMP: temporaryDir },
			timeout: 20_000,
		});
		running.child.stdin?.end();
		const { stdout, stderr } = await running;
		expect(stdout).toContain("no-session smoke complete");
		expect(stderr).not.toMatch(/error|requires a persistent/iu);
		const roots = (await readdir(temporaryDir)).filter((name) => name.startsWith("sol-pi-"));
		expect(roots).toHaveLength(1);
		const objectsDir = join(temporaryDir, roots[0]!, "observation-pack", "objects");
		const objects = await readdir(objectsDir);
		expect(objects).toHaveLength(1);
		expect(await readFile(join(objectsDir, objects[0]!), "utf8")).toBe(body);
		expect((await readdir(agentDir, { recursive: true })).some((name) => name.endsWith(".jsonl"))).toBe(false);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}, 30_000);
