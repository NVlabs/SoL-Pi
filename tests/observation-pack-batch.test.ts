/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createObservationPackExtension, THRESHOLD_BYTES } from "../src/sol-pi/extensions/observation-pack/index.ts";
import { FakePi, fakeContext } from "./helpers.ts";

const fsMocks = vi.hoisted(() => ({ appendFile: vi.fn() }));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	fsMocks.appendFile.mockImplementation((...args: unknown[]) => Reflect.apply(actual.appendFile, actual, args));
	return { ...actual, appendFile: fsMocks.appendFile };
});

const roots: string[] = [];

async function sessionRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "observationpack-batch-test-"));
	roots.push(root);
	return root;
}

function observationPackPi(): FakePi {
	const pi = new FakePi();
	createObservationPackExtension()(pi.asExtensionApi());
	return pi;
}

function toolResult(marker: string, toolCallId: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text: `${marker}\n${marker.repeat(THRESHOLD_BYTES + 1)}` }],
		isError: false,
		timestamp: 1,
	};
}

function resultText(message: AgentMessage): string {
	if (message.role !== "toolResult") throw new Error("expected tool result");
	return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

function observationId(message: ToolResultMessage): string {
	const text = resultText(message);
	const contentHash = createHash("sha256").update(text).digest("hex");
	return `obs_${createHash("sha256")
		.update(`${message.toolName}\0${message.toolCallId}\0${contentHash}`)
		.digest("hex")
		.slice(0, 24)}`;
}

function ledgerPath(sessionDir: string): string {
	return join(sessionDir, "sol-pi", "session-a", "observation-pack", "ledger.jsonl");
}

function objectPath(sessionDir: string, id: string): string {
	return join(sessionDir, "sol-pi", "session-a", "observation-pack", "objects", `${id}.txt`);
}

async function ledgerEntries(sessionDir: string): Promise<Record<string, unknown>[]> {
	const text = await readFile(ledgerPath(sessionDir), "utf8");
	return text
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(async () => {
	fsMocks.appendFile.mockClear();
	vi.restoreAllMocks();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("observation pack ledger batching", () => {
	it("appends one ordered batch per context, skips empty batches, and keeps recall immediate", async () => {
		const sessionDir = await sessionRoot();
		const pi = observationPackPi();
		const context = fakeContext(sessionDir);
		const messages = [toolResult("a", "call-a"), toolResult("b", "call-b"), toolResult("c", "call-c")];

		await pi.emitContext([], context);
		expect(fsMocks.appendFile).not.toHaveBeenCalled();

		const projected = await pi.emitContext(messages, context);
		expect(projected.map(resultText)).toEqual(messages.map(resultText));
		expect(fsMocks.appendFile).toHaveBeenCalledTimes(1);
		expect((await ledgerEntries(sessionDir)).map(({ timestamp: _timestamp, ...entry }) => entry)).toEqual(
			messages.map((message) =>
				expect.objectContaining({ event: "full", id: observationId(message), tool: "bash" }),
			),
		);

		await pi
			.tool("obs_recall")
			.execute("recall-a", { id: observationId(messages[0]!), offset: 0 }, undefined, undefined, context);
		expect(fsMocks.appendFile).toHaveBeenCalledTimes(2);
		expect((await ledgerEntries(sessionDir)).at(-1)).toMatchObject({ event: "recall", id: observationId(messages[0]!) });
	});

	it("does not advance FULL_SENDS when the first or placeholder batch append fails", async () => {
		const sessionDir = await sessionRoot();
		const pi = observationPackPi();
		const context = fakeContext(sessionDir);
		const messages = [toolResult("x", "call-x"), toolResult("y", "call-y")];
		const originals = messages.map(resultText);
		vi.spyOn(console, "error").mockImplementation(() => undefined);

		fsMocks.appendFile.mockRejectedValueOnce(new Error("synthetic first ledger failure"));
		expect((await pi.emitContext(messages, context)).map(resultText)).toEqual(originals);
		expect((await pi.emitContext(messages, context)).map(resultText)).toEqual(originals);
		expect((await pi.emitContext(messages, context)).map(resultText)).toEqual(originals);

		fsMocks.appendFile.mockRejectedValueOnce(new Error("synthetic placeholder ledger failure"));
		expect((await pi.emitContext(messages, context)).map(resultText)).toEqual(originals);
		const recovered = await pi.emitContext(messages, context);

		expect(recovered.map(resultText)).not.toEqual(originals);
		expect(fsMocks.appendFile).toHaveBeenCalledTimes(5);
		const entries = await ledgerEntries(sessionDir);
		expect(entries.map((entry) => entry.event)).toEqual(["full", "full", "full", "full", "placeholder", "placeholder"]);
		expect(entries.slice(-2).map((entry) => entry.sendNumber)).toEqual([3, 3]);
	});

	it("keeps committed projection and counts when TUI savings notification fails", async () => {
		const sessionDir = await sessionRoot();
		const pi = observationPackPi();
		const message = toolResult("tui", "call-tui");
		const original = resultText(message);
		const notify = vi.fn(() => {
			throw new Error("synthetic notify failure");
		});
		const setStatus = vi.fn();
		const context = fakeContext(sessionDir, {
			mode: "tui",
			ui: { notify, setStatus } as unknown as ExtensionContext["ui"],
		});
		vi.spyOn(console, "error").mockImplementation(() => undefined);

		expect(resultText((await pi.emitContext([message], context))[0]!)).toBe(original);
		expect(resultText((await pi.emitContext([message], context))[0]!)).toBe(original);
		fsMocks.appendFile.mockRejectedValueOnce(new Error("synthetic placeholder ledger failure"));
		expect(resultText((await pi.emitContext([message], context))[0]!)).toBe(original);
		expect(notify).not.toHaveBeenCalled();
		expect(setStatus).not.toHaveBeenCalled();

		const recovered = await pi.emitContext([message], context);
		expect(resultText(recovered[0]!)).toContain("[large tool result replaced after its first 2 provider requests]");
		const next = await pi.emitContext([message], context);
		expect(resultText(next[0]!)).toContain("[large tool result replaced after its first 2 provider requests]");
		expect(notify).toHaveBeenCalledOnce();
		expect(setStatus).not.toHaveBeenCalled();
		const entries = await ledgerEntries(sessionDir);
		expect(entries.map((entry) => entry.event)).toEqual(["full", "full", "placeholder", "placeholder"]);
		expect(entries.slice(-2).map((entry) => entry.sendNumber)).toEqual([3, 4]);
	});

	it("preserves baseline send ordering when one observation repeats within a context", async () => {
		const sessionDir = await sessionRoot();
		const pi = observationPackPi();
		const message = toolResult("duplicate", "call-duplicate");
		const original = resultText(message);

		const projected = await pi.emitContext([message, message, message], fakeContext(sessionDir));

		expect(projected.slice(0, 2).map(resultText)).toEqual([original, original]);
		expect(resultText(projected[2]!)).toContain("[large tool result replaced after its first 2 provider requests]");
		expect(fsMocks.appendFile).toHaveBeenCalledOnce();
		const entries = await ledgerEntries(sessionDir);
		expect(entries.map((entry) => entry.event)).toEqual(["full", "full", "placeholder"]);
		expect(entries[2]).toMatchObject({ id: observationId(message), sendNumber: 3 });
	});

	it("keeps a failed archive message unchanged while recording other observations", async () => {
		const sessionDir = await sessionRoot();
		const pi = observationPackPi();
		const bad = toolResult("bad", "call-bad");
		const good = toolResult("good", "call-good");
		const badId = observationId(bad);
		await mkdir(join(sessionDir, "sol-pi", "session-a", "observation-pack", "objects"), { recursive: true });
		await writeFile(objectPath(sessionDir, badId), "z".repeat(Buffer.byteLength(resultText(bad), "utf8")));
		vi.spyOn(console, "error").mockImplementation(() => undefined);

		const projected = await pi.emitContext([bad, good], fakeContext(sessionDir));

		expect(projected.map(resultText)).toEqual([resultText(bad), resultText(good)]);
		expect(fsMocks.appendFile).toHaveBeenCalledTimes(1);
		expect((await ledgerEntries(sessionDir)).map((entry) => entry.id)).toEqual([observationId(good)]);
	});
});
