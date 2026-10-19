/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { expect, it } from "vitest";
import { piCliPath } from "./helpers.ts";
import {
	BOUNDARY_COMPACTION_INSTRUCTIONS,
	POST_COMPACTION_PLAN_REMINDER,
} from "../src/sol-pi/extensions/online-context-compact/extension.ts";

it("finishes the OCC continuation in the real Pi print CLI before exiting", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "sol-pi-occ-cli-"));
	try {
		const agentDir = join(cwd, "agent");
		await mkdir(agentDir);
		await writeFile(join(agentDir, "settings.json"), JSON.stringify({
			compaction: { enabled: false, keepRecentTokens: 150, reserveTokens: 1_024 },
			retry: { enabled: false },
		}));

		// Match the SDK fixture, but seed a real file for the child CLI to resume.
		const sessionManager = SessionManager.create(cwd, join(agentDir, "sessions"));
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: `historical request ${"x".repeat(6_000)}` }],
			timestamp: Date.now() - 2,
		});
		sessionManager.appendMessage(fauxAssistantMessage(`historical response ${"y".repeat(6_000)}`));
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persistent seeded session");

		const finalReply = "final reply after online compaction in print mode";
		const summary = `deterministic compacted history ${"s".repeat(6_000)}`;
		const extensionPath = join(cwd, "occ-cli-extension.ts");
		const fauxPath = fileURLToPath(import.meta.resolve("@earendil-works/pi-ai/providers/faux"));
		const occPath = fileURLToPath(new URL("../src/sol-pi/extensions/online-context-compact/extension.ts", import.meta.url));
		await writeFile(extensionPath, `
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(fauxPath)};
import { createOnlineContextCompactExtension } from ${JSON.stringify(occPath)};
export default function (pi) {
	const faux = fauxProvider({
		provider: "sol-pi-occ-cli", api: "sol-pi-occ-cli-api",
		models: [{ id: "occ-cli-model", contextWindow: 4096, maxTokens: 1024 }],
	});
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("update_plan", {
			steps: [{ id: "build", goal: "build it", status: "in_progress" }],
		}, { id: "plan-open" }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("update_plan", {
			steps: [{ id: "build", goal: "build it", status: "completed" }],
			progress: {
				files_changed: ["src/a.ts"],
				verification: ["tests passed"],
				decisions: ["kept the implementation small"],
			},
		}, { id: "plan-done" }), { stopReason: "toolUse" }),
		async () => {
			// Expose premature print-mode shutdown while the continuation is running.
			await new Promise((resolve) => setTimeout(resolve, 80));
			return fauxAssistantMessage(${JSON.stringify(finalReply)});
		},
	]);
	pi.registerProvider(faux.provider);
	createOnlineContextCompactExtension({ cacheWriteReadRatio: 0, keepRecentTokens: 150 })(pi);
	pi.on("session_before_compact", (event) => ({
		compaction: {
			summary: ${JSON.stringify(summary)},
			firstKeptEntryId: event.preparation.firstKeptEntryId,
			tokensBefore: event.preparation.tokensBefore,
			details: { reason: event.reason, customInstructions: event.customInstructions },
		},
	}));
}
`);

		// Use the locally installed Pi CLI, not a global executable or SDK prompt().
		const running = promisify(execFile)(process.execPath, [
			piCliPath(), "--offline", "--approve", "--print", "--mode", "text",
			"--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
			"--extension", extensionPath,
			"--provider", "sol-pi-occ-cli", "--model", "occ-cli-model", "--thinking", "off",
			"--tools", "update_plan", "--session", sessionFile,
			"--system-prompt", "You are a deterministic lifecycle test assistant.",
			"finish the current plan step",
		], {
			cwd,
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
			timeout: 20_000,
		});
		running.child.stdin?.end();
		const { stdout, stderr } = await running;
		expect.soft(stdout.trim()).toBe(finalReply);
		expect.soft(stderr).not.toMatch(/error|failed/iu);

		// Reopen from disk only after process exit; the seed manager is stale.
		const entries = SessionManager.open(sessionFile).getEntries();
		const compactions = entries.filter((entry) => entry.type === "compaction");
		expect.soft(compactions).toHaveLength(1);
		expect.soft(compactions[0]).toMatchObject({
			summary,
			fromHook: true,
			details: { reason: "manual", customInstructions: BOUNDARY_COMPACTION_INSTRUCTIONS },
		});
		const reminders = entries.filter((entry) =>
			entry.type === "custom_message" && entry.customType === "sol-pi-online-context-compact",
		);
		expect.soft(reminders).toHaveLength(1);
		expect.soft(reminders[0]).toMatchObject({ content: POST_COMPACTION_PLAN_REMINDER, display: false });
		const assistants = entries.flatMap((entry) =>
			entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : [],
		);
		expect.soft(assistants.at(-1)).toMatchObject({
			stopReason: "stop",
			content: [{ type: "text", text: finalReply }],
		});
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}, 30_000);
