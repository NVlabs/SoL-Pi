/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createObservationPackExtension } from "../src/sol-pi/extensions/observation-pack/index.ts";
import * as observationStorage from "../src/sol-pi/extensions/observation-pack/observation.ts";
import { createObservation, observationPath } from "../src/sol-pi/extensions/observation-pack/observation.ts";
import { runtimeRoot } from "../src/sol-pi/runtime-paths.ts";
import { FakePi, fakeContext } from "./helpers.ts";

const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function extension() {
	const pi = new FakePi();
	createObservationPackExtension()(pi.asExtensionApi());
	return pi;
}

async function compactedFork(persistent: boolean) {
	const root = await mkdtemp(join(tmpdir(), "sol-pi-fork-recall-"));
	roots.push(root);
	let manager = persistent ? SessionManager.create(root, join(root, "sessions")) : SessionManager.inMemory(root);
	let ctx = fakeContext(root, { sessionManager: manager });
	const body = "exact diagnostic evidence 🧪\n".repeat(1_200);
	const message = {
		role: "toolResult" as const, toolCallId: "archived-output", toolName: "bash",
		content: [{ type: "text" as const, text: body }], isError: false, timestamp: 2,
	};
	manager.appendMessage({ role: "user", content: "Inspect the output", timestamp: 1 });
	manager.appendMessage(fauxAssistantMessage(fauxToolCall("bash", { command: "make test" }, { id: message.toolCallId })));
	const sourceEntryId = manager.appendMessage(message);
	const originalRoot = runtimeRoot(ctx);
	if (!persistent) roots.push(originalRoot);
	const observation = createObservation(message, originalRoot)!;
	await extension().emitContext(manager.buildSessionContext().messages, ctx);
	expect(await readFile(observation.filePath, "utf8")).toBe(body);

	const keptId = manager.appendMessage({ role: "user", content: "Continue using the archived evidence", timestamp: 3 });
	manager.appendMessage(fauxAssistantMessage("Keep investigating"));
	manager.appendCompaction(`The exact diagnostic evidence is available with obs_recall id=${observation.id}.`, keptId, 20_000);
	const forkPoint = manager.appendMessage({ role: "user", content: "Recheck the original evidence", timestamp: 4 });
	const originalSessionId = manager.getSessionId();
	const forkFile = manager.createBranchedSession(forkPoint);
	expect(manager.getSessionId()).not.toBe(originalSessionId);
	// A resumed fork must work without the original extension's in-memory state.
	if (persistent) manager = SessionManager.open(forkFile!);
	ctx = fakeContext(root, { sessionManager: manager });
	const forkRoot = runtimeRoot(ctx);
	if (!persistent) roots.push(forkRoot);
	expect(forkRoot).not.toBe(originalRoot);
	expect(manager.getBranch().some((entry) => entry.id === sourceEntryId)).toBe(true);
	const visible = manager.buildSessionContext().messages;
	expect(visible.some((item) => item.role === "toolResult" && item.toolCallId === message.toolCallId)).toBe(false);
	expect(visible.some((item) => item.role === "compactionSummary" && item.summary.includes(observation.id))).toBe(true);
	const pi = extension();
	await pi.emitContext(visible, ctx);
	return { body, ctx, forkRoot, manager, observation, pi };
}

describe("ObservationPack fork recall", () => {
	it.each([true, false])("rebuilds compacted-away inherited evidence for a fork (persistent=%s)", async (persistent) => {
		const { body, ctx, forkRoot, manager, observation, pi } = await compactedFork(persistent);
		const getBranch = vi.spyOn(manager, "getBranch");
		const recall = pi.tool("obs_recall");
		let offset = 0;
		let recalled = "";
		let eof = false;
		let pages = 0;
		while (!eof) {
			const result = await recall.execute("recall-fork", { id: observation.id, offset }, undefined, undefined, ctx);
			const text = result.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
			recalled += text.slice(text.indexOf("\n", text.indexOf("\n") + 1) + 1);
			const details = result.details as { nextOffset: number; eof: boolean };
			expect(details.nextOffset).toBeGreaterThan(offset);
			offset = details.nextOffset;
			eof = details.eof;
			pages++;
		}
		expect(pages).toBeGreaterThan(1);
		expect(Buffer.from(recalled)).toEqual(Buffer.from(body));
		expect(await readFile(observationPath(forkRoot, observation.id), "utf8")).toBe(body);
		expect(getBranch).toHaveBeenCalledOnce();
	});

	it("waits for a concurrent first restoration before reading any page", async () => {
		const { body, ctx, forkRoot, observation, pi } = await compactedFork(true);
		const path = observationPath(forkRoot, observation.id);
		let created!: () => void;
		let finishWrite!: () => void;
		const createdPromise = new Promise<void>((resolve) => { created = resolve; });
		const writeBarrier = new Promise<void>((resolve) => { finishWrite = resolve; });
		const store = vi.spyOn(observationStorage, "ensureStored").mockImplementation(async (source) => {
			await mkdir(join(forkRoot, "observation-pack", "objects"), { recursive: true });
			await writeFile(source.filePath, "partial");
			created();
			await writeBarrier;
			await writeFile(source.filePath, source.text);
		});
		const recall = pi.tool("obs_recall");
		const first = recall.execute("first", { id: observation.id }, undefined, undefined, ctx);
		await createdPromise;
		let completed = 0;
		const later = Array.from({ length: 12 }, (_, index) => recall.execute(
			`parallel-${index}`, { id: observation.id, offset: 32 * index }, undefined, undefined, ctx,
		).then((result) => { completed++; return result; }));
		const laterSettlements = Promise.allSettled(later);
		// The file exists, but it must not be read until the writer publishes all bytes.
		await new Promise((resolve) => setTimeout(resolve, 10));
		const completedBeforeWrite = completed;
		finishWrite();
		const firstResult = await first;
		const outcomes = await laterSettlements;
		expect(completedBeforeWrite).toBe(0);
		expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(true);
		const results = [firstResult, ...outcomes.flatMap((outcome) => outcome.status === "fulfilled" ? [outcome.value] : [])];
		expect(store).toHaveBeenCalledOnce();
		for (const result of results) {
			const text = result.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
			const chunk = text.slice(text.indexOf("\n", text.indexOf("\n") + 1) + 1);
			const details = result.details as { offset: number; bytes: number };
			expect(Buffer.from(chunk)).toEqual(Buffer.from(body).subarray(details.offset, details.offset + details.bytes));
		}
		expect(await readFile(path, "utf8")).toBe(body);
	});

	it("lets a queued recall retry after another restoration fails", async () => {
		const { ctx, observation, pi } = await compactedFork(true);
		const originalStore = observationStorage.ensureStored;
		vi.spyOn(observationStorage, "ensureStored")
			.mockRejectedValueOnce(new Error("restore write failed"))
			.mockImplementation(originalStore);
		const recall = pi.tool("obs_recall");
		const results = await Promise.allSettled([
			recall.execute("first", { id: observation.id }, undefined, undefined, ctx),
			recall.execute("retry", { id: observation.id }, undefined, undefined, ctx),
		]);
		expect(results[0]).toMatchObject({ status: "rejected", reason: new Error("restore write failed") });
		expect(results[1]).toMatchObject({ status: "fulfilled" });
	});

	it("does not publish a partial failed write, including after restarting the extension", async () => {
		const { body, ctx, forkRoot, observation, pi } = await compactedFork(true);
		const path = observationPath(forkRoot, observation.id);
		const store = vi.spyOn(observationStorage, "ensureStored").mockImplementationOnce(async (source) => {
			await mkdir(join(forkRoot, "observation-pack", "objects"), { recursive: true });
			await writeFile(source.filePath, "partial");
			throw Object.assign(new Error("simulated disk full"), { code: "ENOSPC" });
		});
		await expect(pi.tool("obs_recall").execute("first", { id: observation.id }, undefined, undefined, ctx))
			.rejects.toMatchObject({ code: "ENOSPC" });
		expect(await readdir(join(forkRoot, "observation-pack", "objects"))).toEqual([]);
		await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
		store.mockRestore();
		const result = await extension().tool("obs_recall").execute("after-restart", { id: observation.id }, undefined, undefined, ctx);
		expect(result.details).toMatchObject({ eof: false });
		expect(await readFile(path, "utf8")).toBe(body);
	});

	it("refuses to overwrite a corrupt object created during recovery", async () => {
		const { body, ctx, forkRoot, observation, pi } = await compactedFork(true);
		const path = observationPath(forkRoot, observation.id);
		const corrupt = "x".repeat(Buffer.byteLength(body));
		const originalStore = observationStorage.ensureStored;
		vi.spyOn(observationStorage, "ensureStored").mockImplementation(async (source) => {
			await mkdir(join(forkRoot, "observation-pack", "objects"), { recursive: true });
			await writeFile(path, corrupt);
			await originalStore(source);
		});
		await expect(pi.tool("obs_recall").execute("recall-corrupt", { id: observation.id }, undefined, undefined, ctx))
			.rejects.toThrow("hash mismatch");
		expect(await readFile(path, "utf8")).toBe(corrupt);
	});

	it("does not rebuild an observation from an abandoned sibling branch", async () => {
		const root = await mkdtemp(join(tmpdir(), "sol-pi-fork-sibling-"));
		roots.push(root);
		const manager = SessionManager.create(root, join(root, "sessions"));
		const ctx = fakeContext(root, { sessionManager: manager });
		const common = manager.appendMessage({ role: "user", content: "Start", timestamp: 1 });
		manager.appendMessage(fauxAssistantMessage("Inspect sibling A"));
		const message = { role: "toolResult" as const, toolCallId: "only-sibling-a", toolName: "bash",
			content: [{ type: "text" as const, text: "sibling evidence\n".repeat(1_000) }], isError: false, timestamp: 2 };
		manager.appendMessage(message);
		const observation = createObservation(message, runtimeRoot(ctx))!;
		manager.branch(common);
		manager.appendMessage(fauxAssistantMessage("Continue sibling B"));
		expect(manager.getEntries().some((entry) => entry.type === "message" && entry.message === message)).toBe(true);
		expect(manager.getBranch().some((entry) => entry.type === "message" && entry.message === message)).toBe(false);
		await expect(extension().tool("obs_recall").execute("recall-sibling", { id: observation.id }, undefined, undefined, ctx))
			.rejects.toThrow(`Unknown observation id: ${observation.id}`);
		await expect(readFile(observation.filePath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it.each(["symlink", "directory"])("does not replace an unsafe existing %s with inherited evidence", async (kind) => {
		const { ctx, forkRoot, manager, observation, pi } = await compactedFork(true);
		const path = observationPath(forkRoot, observation.id);
		await mkdir(join(forkRoot, "observation-pack", "objects"), { recursive: true });
		const target = join(forkRoot, "unrelated.txt");
		await writeFile(target, "unrelated bytes must stay unchanged");
		if (kind === "symlink") await symlink(target, path);
		else await mkdir(path);
		const getBranch = vi.spyOn(manager, "getBranch");
		await expect(pi.tool("obs_recall").execute("recall-unsafe", { id: observation.id }, undefined, undefined, ctx)).rejects.toThrow();
		expect(getBranch).not.toHaveBeenCalled();
		expect(await readFile(target, "utf8")).toBe("unrelated bytes must stay unchanged");
	});
});
