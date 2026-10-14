/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { createBashToolDefinition, type BashOperations, type ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it } from "vitest";
import { createActionFusionExtension } from "../src/sol-pi/extensions/action-fusion/index.ts";
import { reducibleToolResult } from "../src/sol-pi/extensions/evidence-preserving-reducer/candidate.ts";
import { loadReducerConfig, REDUCER_RECEIPT_SCHEMA } from "../src/sol-pi/extensions/evidence-preserving-reducer/config.ts";
import { reduceToolResult } from "../src/sol-pi/extensions/evidence-preserving-reducer/index.ts";
import { fakeContext, FakePi } from "./helpers.ts";

const cleanupPaths: string[] = [];
const progress = "building target";

afterEach(async () => {
	await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "reducer-execution-status-"));
	cleanupPaths.push(root);
	return root;
}

function mockReducerContext(root: string) {
	const model = { id: "test-reducer", provider: "test-provider", maxTokens: 4_096 };
	return fakeContext(root, {
		cwd: root,
		modelRegistry: {
			find: () => model,
			complete: async (_model: unknown, context: Context) => {
				const request = JSON.stringify(context.messages);
				const hash = request.match(/source_sha256=([a-f0-9]{64})/u)?.[1];
				return {
					role: "assistant", api: "test-api", provider: model.provider, model: model.id,
					stopReason: "stop", timestamp: Date.now(),
					content: [{ type: "text", text: JSON.stringify({
						schema: REDUCER_RECEIPT_SCHEMA, source_sha256: hash, status: "failure", uncertain: false,
						evidence: [{ kind: "failure", quote: progress }],
					}) }],
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
				};
			},
		} as never,
	});
}

function eventFor(toolName: string, inline: string): ToolResultEvent {
	return {
		type: "tool_result", toolName, toolCallId: "status-test", isError: true, details: undefined,
		input: toolName === "bash" ? { command: "npm test" } : { path: "target.txt", then_run: { command: "npm test" } },
		content: [{ type: "text", text: inline }],
	} as ToolResultEvent;
}

async function reduceFailure(root: string, toolName: string, inline: string, status: string) {
	expect(inline).toContain(status);
	const logPath = inline.match(/Full output: ([^\]]+)/u)?.[1];
	if (logPath) cleanupPaths.push(logPath);
	const result = await reduceToolResult(() => {}, loadReducerConfig(root), eventFor(toolName, inline), mockReducerContext(root));
	expect(result).toBeDefined();
	expect(result!.isError).toBe(true);
	const visible = result!.content.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n");
	expect(visible).toContain("sol_pi_evidence_receipt_v1");
	expect(visible).toContain(status);
	expect(visible.endsWith(status)).toBe(true);
	return { visible, logPath };
}

it.each(["bash", "write", "edit"] as const)("preserves exit and timeout status in reduced %s output", async (toolName) => {
	for (const truncated of [false, true]) {
		for (const mode of ["exit", "timeout"] as const) {
			const root = await temporaryDirectory();
			const body = `${progress}\n`.repeat(truncated ? 3_000 : 400);
			const status = mode === "exit" ? "Command exited with code 7" : "Command timed out after 1 seconds";
			const operations: BashOperations = { exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.from(body));
				if (mode === "timeout") throw new Error("timeout:1");
				return { exitCode: 7 };
			} };
			const pi = new FakePi();
			createActionFusionExtension({ bashOptions: { operations } })(pi.asExtensionApi());
			const tool = toolName === "bash" ? createBashToolDefinition(root, { operations }) : pi.tool(toolName);
			await writeFile(join(root, "target.txt"), "before\n");
			const input = toolName === "bash" ? { command: "npm test" } : {
				path: "target.txt", then_run: { command: "npm test" },
				...(toolName === "write" ? { content: "after\n" } : { edits: [{ oldText: "before", newText: "after" }] }),
			};
			let inline = "";
			try {
				const result = await tool.execute("status-test", input as never, undefined, undefined, fakeContext(root, { cwd: root }));
				inline = result.content.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n");
			} catch (error) {
				inline = (error as Error).message;
			}
			const { visible, logPath } = await reduceFailure(root, toolName, inline, status);
			expect(Boolean(logPath)).toBe(truncated);
			if (logPath) expect(await readFile(logPath, "utf8")).toBe(body);
			const archivePath = visible.match(/^source_artifact=(.+)$/mu)?.[1];
			expect(archivePath).toBeDefined();
			expect(await readFile(archivePath!, "utf8")).toBe(body);
			expect(visible).toContain(`source_bytes=${Buffer.byteLength(body)}`);
			if (toolName !== "bash") {
				expect(visible).toContain("Successfully");
				expect(visible).toContain("[then_run:failed]");
				expect(await readFile(join(root, "target.txt"), "utf8")).toBe("after\n");
			}
		}
	}
});

it("preserves the exit status of a real truncated npm test process", async () => {
	const root = await temporaryDirectory();
	await writeFile(join(root, "package.json"), JSON.stringify({ name: "status-fixture", scripts: { test: "node build.cjs" } }));
	await writeFile(join(root, "build.cjs"), `process.stdout.write(${JSON.stringify(`${progress}\n`.repeat(3_000))}, () => process.exit(7));`);
	let inline = "";
	try {
		const result = await createBashToolDefinition(root).execute("real-status", { command: "npm test" }, undefined, undefined, fakeContext(root, { cwd: root }));
		inline = result.content.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n");
	} catch (error) {
		inline = (error as Error).message;
	}
	const { logPath } = await reduceFailure(root, "bash", inline, "Command exited with code 7");
	expect(logPath).toBeDefined();
	expect(await readFile(logPath!, "utf8")).not.toContain("Command exited with code 7");
});

it.each(["Command aborted", "Command terminated without an exit code", "Command timed out after 0.25 seconds"])(
	"preserves terminal runtime status %s", async (status) => {
		const candidate = await reducibleToolResult(eventFor("bash", `${progress}\n\n${status}`));
		expect(candidate!.body).toBe(progress);
		expect(candidate!.projectReceipt("receipt")).toEqual([{ type: "text", text: `receipt\n\n${status}` }]);
	},
);

it("does not promote status-looking log lines or successful output to runtime status", async () => {
	for (const inline of ["Command aborted\nmore output", "text Command aborted", "Command timed out after many seconds"]) {
		const candidate = await reducibleToolResult(eventFor("bash", inline));
		expect(candidate!.projectReceipt("receipt")).toEqual([{ type: "text", text: "receipt" }]);
	}
	const successful = { ...eventFor("bash", `${progress}\n\nCommand aborted`), isError: false };
	const candidate = await reducibleToolResult(successful);
	expect(candidate!.projectReceipt("receipt")).toEqual([{ type: "text", text: "receipt" }]);
});
