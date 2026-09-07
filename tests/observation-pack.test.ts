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
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createObservationPackExtension,
	FULL_SENDS,
	THRESHOLD_BYTES,
} from "../src/sol-pi/extensions/observation-pack/index.ts";
import { componentText, FakePi, FakeSessionManager, fakeContext, plainTheme } from "./helpers.ts";

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

	it("recalls from durable storage after a restart of the extension", async () => {
		const sessionDir = await sessionRoot();
		const body = `durable observation\n${repeatPastThreshold("recall line\n")}`;
		const projected = await project(observationPackPi(), toolResult(body), sessionDir, 3);
		const id = projected[2]?.match(/id: (obs_[a-f0-9]{24})/u)?.[1];
		expect(id).toBeTruthy();

		const resumed = observationPackPi();
		const result = await resumed
			.tool("obs_recall")
			.execute("recall-1", { id, offset: 0 }, undefined, undefined, fakeContext(sessionDir));
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

	it("fails recall closed when an object path is replaced by a symlink", async () => {
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
			pi.tool("obs_recall").execute("recall-1", { id, offset: 0 }, undefined, undefined, fakeContext(sessionDir)),
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
			const result = await recall.execute("recall-1", { id, offset }, undefined, undefined, fakeContext(sessionDir));
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

	it("fails storage closed when the observation directory is a symlink", async () => {
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
