/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { runtimeRoot } from "../src/sol-pi/runtime-paths.ts";

const temporaryRoots = new Set<string>();

afterEach(() => {
	for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
	temporaryRoots.clear();
});

function context(sessionDir: string, sessionId: string): ExtensionContext {
	return {
		sessionManager: {
			getSessionDir: () => sessionDir,
			getSessionId: () => sessionId,
		},
	} as unknown as ExtensionContext;
}

describe("SoL-Pi runtime root", () => {
	it("gives each Pi session its own directory", () => {
		const sessionDir = join("sessions", "project-a");
		expect(runtimeRoot(context(sessionDir, "session-a"))).toBe(join(sessionDir, "sol-pi", "session-a"));
		expect(runtimeRoot(context(sessionDir, "session-b"))).toBe(join(sessionDir, "sol-pi", "session-b"));
	});

	it("keeps one private temporary directory per in-memory session across contexts", () => {
		const manager = SessionManager.inMemory();
		expect(manager.getSessionDir()).toBe("");
		expect(manager.getSessionFile()).toBeUndefined();
		const root = runtimeRoot(context(manager.getSessionDir(), manager.getSessionId()));
		temporaryRoots.add(root);
		expect(dirname(root)).toBe(tmpdir());
		expect(statSync(root).isDirectory()).toBe(true);
		if (process.platform !== "win32") expect(statSync(root).mode & 0o777).toBe(0o700);
		expect(runtimeRoot(context("", manager.getSessionId()))).toBe(root);

		manager.newSession();
		const nextRoot = runtimeRoot(context("", manager.getSessionId()));
		temporaryRoots.add(nextRoot);
		expect(nextRoot).not.toBe(root);
		expect(statSync(root).isDirectory()).toBe(true);
	});

	it("isolates concurrent in-memory workers in the same working directory", () => {
		const workers = [SessionManager.inMemory(), SessionManager.inMemory()];
		const roots = workers.map((worker) => {
			const root = runtimeRoot(context(worker.getSessionDir(), worker.getSessionId()));
			temporaryRoots.add(root);
			return root;
		});
		expect(roots[0]).not.toBe(roots[1]);
	});

	it.each(["", ".", "..", "../escape", "nested/session", "nested\\session"])(
		"rejects unsafe session id %j",
		(sessionId) => {
			expect(() => runtimeRoot(context("sessions", sessionId))).toThrow("safe Pi session id");
			expect(() => runtimeRoot(context("", sessionId))).toThrow("safe Pi session id");
		},
	);
});
