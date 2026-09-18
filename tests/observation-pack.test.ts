/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

	it("does not search an observation stored only in another session", async () => {
		const sessionDir = await sessionRoot();
		const message = toolResult(`session-only\n${repeatPastThreshold("isolated bytes\n")}`);
		const id = observationId(message);
		const pi = observationPackPi();
		const contextA = fakeContext(new FakeSessionManager([], "session-a", sessionDir));
		const contextB = fakeContext(new FakeSessionManager([], "session-b", sessionDir));
		await project(pi, message, sessionDir, 3);
		await expect(pi.tool("obs_recall").execute("session-b", { id, query: "session-only" }, undefined, undefined, contextB)).rejects.toThrow("Unknown observation id");
		await expect(pi.tool("obs_recall").execute("session-a", { id, query: "session-only" }, undefined, undefined, contextA)).resolves.toBeTruthy();
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
		const search = await resumed.tool("obs_recall").execute("search-after-restart", { id, query: "durable" }, undefined, undefined, fakeContext(sessionDir));
		expect((search.details as { matches: unknown[] }).matches).toHaveLength(1);
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

		for (const args of [{ id, offset: 0 }, { id, query: "stored" }]) {
			await expect(pi.tool("obs_recall").execute("recall-1", args, undefined, undefined, fakeContext(sessionDir))).rejects.toMatchObject({ code: "ELOOP" });
		}
	});

	it("rejects a directory substituted for a searched object", async () => {
		const sessionDir = await sessionRoot();
		const message = toolResult(`stored\n${repeatPastThreshold("object bytes\n")}`);
		const id = observationId(message);
		const pi = observationPackPi();
		await project(pi, message, sessionDir, 3);
		await rm(observationPath(sessionDir, id));
		await mkdir(observationPath(sessionDir, id));
		await expect(pi.tool("obs_recall").execute("directory", { id, query: "stored" }, undefined, undefined, fakeContext(sessionDir))).rejects.toThrow("not a regular file");
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

	it("searches archived literal bytes with exact spans, UTF-8 contexts, and overlapping matches", async () => {
		const sessionDir = await sessionRoot();
		const source = `start\nbanana\ncase Needle needle\nNUL:\0needle\n${"a".repeat(4094)}☾needle\n`;
		const message = toolResult(`${source}${"padding without hits\n".repeat(700)}`);
		const id = observationId(message);
		const pi = observationPackPi();
		await project(pi, message, sessionDir, 3);
		const recall = pi.tool("obs_recall");

		const overlap = await recall.execute("search-1", { id, query: "ana" }, undefined, undefined, fakeContext(sessionDir));
		const overlapDetails = overlap.details as { matches: Array<{ byteOffset: number; byteEnd: number; line: number; context: string }> };
		expect(overlapDetails.matches.map((match) => match.byteOffset)).toEqual([Buffer.byteLength("start\nb", "utf8"), Buffer.byteLength("start\nban", "utf8")]);
		expect(overlapDetails.matches.map((match) => match.byteEnd - match.byteOffset)).toEqual([3, 3]);
		expect(overlapDetails.matches.every((match) => match.line === 2 && match.context.includes("banana"))).toBe(true);

		const nul = await recall.execute("search-2", { id, query: "\0needle" }, undefined, undefined, fakeContext(sessionDir));
		const nulText = nul.content[0]?.type === "text" ? nul.content[0].text : "";
		expect(nulText).toContain('"context":"');
		expect(nulText).toContain("\\u0000needle");
		expect(Buffer.byteLength(nulText, "utf8")).toBeLessThanOrEqual(16 * 1024);
		const utf8 = await recall.execute("search-3", { id, query: "☾n" }, undefined, undefined, fakeContext(sessionDir));
		const utf8Details = utf8.details as { matches: Array<{ byteOffset: number; byteEnd: number; context: string }> };
		expect(utf8Details.matches).toHaveLength(1);
		expect(utf8Details.matches[0]?.byteOffset).toBe(Buffer.byteLength(source.slice(0, source.indexOf("☾n")), "utf8"));
		expect(utf8Details.matches[0]?.context).toContain("☾needle");
	});

	it("trims 2, 3, and 4-byte UTF-8 characters cut by the fixed context end", async () => {
		const sessionDir = await sessionRoot();
		const cases = ["é", "漢", "🙂"];
		const source = `${cases.map((character, index) => `${"x".repeat(300)}match-${index}${"a".repeat(255)}${character}tail`).join("\n")}\n${"padding\n".repeat(2_000)}`;
		const message = toolResult(source);
		const id = observationId(message);
		const pi = observationPackPi();
		await project(pi, message, sessionDir, 3);
		for (const [index] of cases.entries()) {
			const result = await pi.tool("obs_recall").execute("context-boundary", { id, query: `match-${index}` }, undefined, undefined, fakeContext(sessionDir));
			const match = (result.details as { matches: Array<{ context: string; contextStart: number; contextEnd: number }> }).matches[0];
			expect(match).toBeTruthy();
			const expected = Buffer.from(source).subarray(match!.contextStart, match!.contextEnd);
			expect(Buffer.from(match!.context, "utf8")).toEqual(expected);
			expect(match!.contextEnd - match!.contextStart).toBe(Buffer.byteLength(match!.context, "utf8"));
			expect(match!.context).not.toContain("�");
		}
	});

	it("continues capped searches without skipped or duplicate match starts", async () => {
		const sessionDir = await sessionRoot();
		const source = `${"needle|".repeat(25)}${"filler\n".repeat(2_000)}`;
		const message = toolResult(source);
		const id = observationId(message);
		const pi = observationPackPi();
		await project(pi, message, sessionDir, 3);
		const recall = pi.tool("obs_recall");
		let offset = 0;
		const starts: number[] = [];
		for (;;) {
			const result = await recall.execute("search-cap", { id, query: "needle", offset }, undefined, undefined, fakeContext(sessionDir));
			const details = result.details as { matches: Array<{ byteOffset: number }>; nextOffset: number; eof: boolean };
			starts.push(...details.matches.map((match) => match.byteOffset));
			offset = details.nextOffset;
			if (details.eof) break;
		}
		expect(starts).toEqual(Array.from({ length: 25 }, (_, index) => index * Buffer.byteLength("needle|", "utf8")));
	});

	it("stops before JSON-escaped contexts exceed the result byte limit", async () => {
		const sessionDir = await sessionRoot();
		const source = `${(`${"\0".repeat(256)}needle${"\0".repeat(256)}|`).repeat(20)}${"filler\n".repeat(2_000)}`;
		const message = toolResult(source);
		const id = observationId(message);
		const pi = observationPackPi();
		await project(pi, message, sessionDir, 3);
		const result = await pi.tool("obs_recall").execute("escaped", { id, query: "needle" }, undefined, undefined, fakeContext(sessionDir));
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		const details = result.details as { matches: unknown[]; eof: boolean };
		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(16 * 1024);
		expect(details.matches.length).toBeGreaterThan(0);
		expect(details.matches.length).toBeLessThan(20);
		expect(details.eof).toBe(false);
	});

	it("rejects invalid search arguments and honors an already aborted search", async () => {
		const sessionDir = await sessionRoot();
		const message = toolResult(`${"searchable\n".repeat(2_000)}`);
		const id = observationId(message);
		const pi = observationPackPi();
		await project(pi, message, sessionDir, 3);
		const recall = pi.tool("obs_recall");
		const context = fakeContext(sessionDir);
		await expect(recall.execute("bad", { id, query: "" }, undefined, undefined, context)).rejects.toThrow("must not be empty");
		await expect(recall.execute("bad", { id, query: String.fromCharCode(0xd800) }, undefined, undefined, context)).rejects.toThrow("well-formed");
		await expect(recall.execute("bad", { id, query: "x".repeat(257) }, undefined, undefined, context)).rejects.toThrow("256 UTF-8");
		await expect(recall.execute("bad", { id, query: "x", offset: Number.MAX_SAFE_INTEGER + 1 }, undefined, undefined, context)).rejects.toThrow("safe integer");
		await expect(recall.execute("bad", { id: "obs_0123456789abcdef01234567", query: "x" }, undefined, undefined, context)).rejects.toThrow("Unknown observation id");
		const end = Buffer.byteLength(message.content[0]?.type === "text" ? message.content[0].text : "", "utf8");
		const miss = await recall.execute("miss", { id, query: "absent", offset: end }, undefined, undefined, context);
		expect(miss.details).toMatchObject({ matches: [], nextOffset: end, eof: true });
		const exact256 = await recall.execute("exact", { id, query: "é".repeat(128) }, undefined, undefined, context);
		expect(exact256.details).toMatchObject({ matches: [], eof: true });
		const multiline = await recall.execute("multiline", { id, query: "searchable\nsearchable" }, undefined, undefined, context);
		expect((multiline.details as { matches: unknown[] }).matches.length).toBeGreaterThan(0);
		const controller = new AbortController();
		controller.abort();
		await expect(recall.execute("abort", { id, query: "searchable" }, controller.signal, undefined, context)).rejects.toThrow("aborted");
	});

	it("accumulates short archive reads and stops when cancellation arrives during a prefix rescan", async () => {
		const sessionDir = await sessionRoot();
		const source = `prefix\n${"short read payload\n".repeat(2_000)}needle\n`;
		const message = toolResult(source);
		const id = observationId(message);
		const pi = observationPackPi();
		await project(pi, message, sessionDir, 3);
		const probe = await open(observationPath(sessionDir, id), "r");
		const prototype = Object.getPrototypeOf(probe) as { read: (...args: any[]) => Promise<{ bytesRead: number }> };
		await probe.close();
		const originalRead = prototype.read;
		const readSpy = vi.spyOn(prototype, "read").mockImplementation(function (this: unknown, buffer: Buffer, bufferOffset: number, length: number, position: number) {
			return originalRead.call(this, buffer, bufferOffset, Math.min(length, 7), position);
		});
		const recall = pi.tool("obs_recall");
		const shortRead = await recall.execute("short", { id, query: "needle" }, undefined, undefined, fakeContext(sessionDir));
		expect((shortRead.details as { matches: unknown[] }).matches).toHaveLength(1);

		const controller = new AbortController();
		let calls = 0;
		readSpy.mockImplementation(function (this: unknown, buffer: Buffer, bufferOffset: number, length: number, position: number) {
			calls += 1;
			return originalRead.call(this, buffer, bufferOffset, length, position).then((result) => {
				if (calls === 1) controller.abort();
				return result;
			});
		});
		await expect(recall.execute("during", { id, query: "needle", offset: 8_000 }, controller.signal, undefined, fakeContext(sessionDir))).rejects.toThrow("aborted");
		const scanController = new AbortController();
		calls = 0;
		readSpy.mockImplementation(function (this: unknown, buffer: Buffer, bufferOffset: number, length: number, position: number) {
			calls += 1;
			return originalRead.call(this, buffer, bufferOffset, length, position).then((result) => {
				if (calls === 1) scanController.abort();
				return result;
			});
		});
		await expect(recall.execute("scan", { id, query: "missing" }, scanController.signal, undefined, fakeContext(sessionDir))).rejects.toThrow("aborted");
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
