/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { ExtensionRunner, type ModelRegistry, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { loadExtensions } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { THRESHOLD_BYTES } from "../src/sol-pi/extensions/observation-pack/index.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("observation pack real Pi integration", () => {
	it("runs through loadExtensions, ExtensionRunner, and a persisted SessionManager context pipeline", async () => {
		const root = await mkdtemp(join(tmpdir(), "observationpack-pi-integration-"));
		roots.push(root);
		const cwd = join(root, "project");
		const sessionDir = join(root, "sessions");
		const sessionManager = SessionManager.create(cwd, sessionDir);
		const body = `persisted synthetic observation\n${"0123456789abcdef\n".repeat(
			Math.ceil((THRESHOLD_BYTES + 1) / 17),
		)}`;
		const message: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "integration-call",
			toolName: "bash",
			content: [{ type: "text", text: body }],
			isError: false,
			timestamp: 1,
		};
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "synthetic setup" }],
			api: "openai-responses",
			provider: "synthetic",
			model: "offline",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		};
		sessionManager.appendMessage(assistant);
		sessionManager.appendMessage(message);

		const loaded = await loadExtensions(
			[resolve("src/sol-pi/extensions/observation-pack/index.ts")],
			cwd,
		);
		expect(loaded.errors).toEqual([]);
		const runner = new ExtensionRunner(
			loaded.extensions,
			loaded.runtime,
			cwd,
			sessionManager,
			{} as ModelRegistry,
		);
		const persistedMessages = sessionManager.buildSessionContext().messages;

		const first = await runner.emitContext(persistedMessages);
		const second = await runner.emitContext(persistedMessages);
		const third = await runner.emitContext(persistedMessages);

		expect(first).toEqual(persistedMessages);
		expect(second).toEqual(persistedMessages);
		const projected = third.find((candidate) => candidate.role === "toolResult");
		expect(projected?.role).toBe("toolResult");
		if (projected?.role !== "toolResult") throw new Error("expected projected tool result");
		const placeholder = projected.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
		expect(placeholder).toContain("[large tool result replaced after its first 2 provider requests]");
		const id = placeholder.match(/^id: (obs_[a-f0-9]{24})$/mu)?.[1];
		expect(id).toBeDefined();

		const sessionFile = sessionManager.getSessionFile();
		expect(sessionFile).toBeDefined();
		expect(await readFile(sessionFile!, "utf8")).toContain("persisted synthetic observation");
		expect(await readFile(join(sessionDir, "sol-pi", sessionManager.getSessionId(), "observation-pack", "objects", `${id}.txt`), "utf8")).toBe(body);
		const ledger = await readFile(
			join(sessionDir, "sol-pi", sessionManager.getSessionId(), "observation-pack", "ledger.jsonl"),
			"utf8",
		);
		expect(ledger.trim().split("\n").map((line) => JSON.parse(line).event)).toEqual([
			"full",
			"full",
			"placeholder",
		]);
	});
});
