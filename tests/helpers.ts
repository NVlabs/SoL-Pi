/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, SessionEntry, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Handler = (event: unknown, context: ExtensionContext) => unknown | Promise<unknown>;

export const plainTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

export function componentText(component: Component, width = 120): string {
	return component
		.render(width)
		.map((line) => line.trimEnd())
		.join("\n");
}

/**
 * Minimal session manager stand-in: enough for extensions that only need a
 * session directory and an append-only custom-entry log.
 */
export class FakeSessionManager {
	readonly entries: SessionEntry[];
	readonly sessionDir: string;
	sessionId: string;
	sessionFile: string | undefined;
	leafId: string | null;
	private nextId = 1;

	constructor(entries: SessionEntry[] = [], sessionId = "session-a", sessionDir = tmpdir()) {
		this.entries = entries;
		this.sessionId = sessionId;
		this.sessionFile = join(sessionDir, `${sessionId}.jsonl`);
		this.sessionDir = sessionDir;
		this.leafId = entries.at(-1)?.id ?? null;
	}

	getSessionId(): string {
		return this.sessionId;
	}

	getSessionFile(): string | undefined {
		return this.sessionFile;
	}

	getSessionDir(): string {
		return this.sessionDir;
	}

	getLeafId(): string | null {
		return this.leafId;
	}

	getEntries(): SessionEntry[] {
		return this.entries;
	}

	getBranch(): SessionEntry[] {
		return this.entries;
	}

	appendCustomEntry(customType: string, data: unknown): string {
		const id = `custom-${this.nextId++}`;
		this.entries.push({
			type: "custom",
			id,
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			customType,
			data,
		});
		this.leafId = id;
		return id;
	}

	appendMessage(message: AgentMessage): string {
		const id = `message-${this.nextId++}`;
		this.entries.push({
			type: "message",
			id,
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			message,
		});
		this.leafId = id;
		return id;
	}

	/** Custom-entry payloads appended so far, in order. */
	customEntryData(): Record<string, unknown>[] {
		return this.entries.flatMap((entry) =>
			entry.type === "custom" && typeof entry.data === "object" && entry.data !== null
				? [entry.data as Record<string, unknown>]
				: [],
		);
	}
}

/**
 * ExtensionAPI stand-in that records handlers and tools, so an extension can be
 * driven directly without a session, a provider, or the extension runner.
 */
export class FakePi {
	readonly handlers = new Map<string, Handler[]>();
	readonly registeredTools: ToolDefinition[] = [];
	readonly sentMessages: Array<{
		message: { customType: string; content: string; display: boolean; details?: unknown };
		options: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" } | undefined;
	}> = [];
	readonly sessionManager: FakeSessionManager;

	constructor(sessionManager: FakeSessionManager = new FakeSessionManager()) {
		this.sessionManager = sessionManager;
	}

	on(event: string, handler: unknown): void {
		const handlers = this.handlers.get(event) ?? [];
		handlers.push(handler as Handler);
		this.handlers.set(event, handlers);
	}

	registerTool(tool: ToolDefinition): void {
		this.registeredTools.push(tool);
	}

	appendEntry(customType: string, data?: unknown): void {
		this.sessionManager.appendCustomEntry(customType, data);
	}

	sendMessage(
		message: { customType: string; content: string; display: boolean; details?: unknown },
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): void {
		this.sentMessages.push({ message, options });
	}

	asExtensionApi(): ExtensionAPI {
		return this as unknown as ExtensionAPI;
	}

	tool(name: string): ToolDefinition {
		const tool = this.registeredTools.find((candidate) => candidate.name === name);
		if (!tool) throw new Error(`tool not registered: ${name}`);
		return tool;
	}

	/** Run every handler for one event and return the last defined result. */
	async emit(eventName: string, event: unknown, context: ExtensionContext): Promise<unknown> {
		let result: unknown;
		for (const handler of this.handlers.get(eventName) ?? []) {
			const current = await handler(event, context);
			if (current !== undefined) result = current;
		}
		return result;
	}

	async emitContext(messages: readonly AgentMessage[], context: ExtensionContext): Promise<AgentMessage[]> {
		let current = structuredClone(messages) as AgentMessage[];
		for (const handler of this.handlers.get("context") ?? []) {
			const result = (await handler({ type: "context", messages: current }, context)) as
				| { messages?: AgentMessage[] }
				| undefined;
			if (result?.messages) current = result.messages;
		}
		return current;
	}
}

export function fakeContext(
	sessionManager: FakeSessionManager | string,
	overrides: Partial<ExtensionContext> = {},
): ExtensionContext {
	const manager =
		typeof sessionManager === "string" ? new FakeSessionManager([], "session-a", sessionManager) : sessionManager;
	return {
		mode: "json",
		hasUI: false,
		cwd: process.cwd(),
		sessionManager: manager,
		modelRegistry: {},
		model: undefined,
		scopedModels: [],
		ui: {},
		isIdle: () => false,
		isProjectTrusted: () => true,
		signal: undefined,
		abort: () => undefined,
		hasPendingMessages: () => false,
		shutdown: () => undefined,
		getContextUsage: () => undefined,
		compact: () => undefined,
		getSystemPrompt: () => "",
		...overrides,
	} as unknown as ExtensionContext;
}
