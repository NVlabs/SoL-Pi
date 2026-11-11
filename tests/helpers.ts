/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, SessionEntry, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

function isSystemMessage(message: AgentMessage): boolean {
	return (message as { role: string }).role === "system";
}

function sameMessages(left: readonly AgentMessage[], right: readonly AgentMessage[]): boolean {
	return left.length === right.length && left.every((message, index) => message === right[index]);
}

/** Simplified `getCurrentSystemMessage`: every system message folded into one. */
function collapseSystemMessages(messages: readonly AgentMessage[]): AgentMessage | undefined {
	const system = messages.filter(isSystemMessage) as unknown as Array<{ content: unknown; timestamp: number }>;
	if (system.length === 0) return undefined;
	return {
		role: "system",
		content: system.map((message) => (typeof message.content === "string" ? message.content : "")).join("\n\n"),
		timestamp: system[0]!.timestamp,
		collapsedFrom: system.length,
	} as unknown as AgentMessage;
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

	/**
	 * Run the `context` handlers the way Pi 1.0's runner does: each handler sees
	 * a structured clone without system messages, may edit it in place or return
	 * a new list, and system messages stay at their indices only while the
	 * handler keeps every message object. Otherwise they collapse into one
	 * leading system message, as `restoreSystemMessages` does.
	 */
	async emitContext(messages: readonly AgentMessage[], context: ExtensionContext): Promise<AgentMessage[]> {
		let current = structuredClone(messages) as AgentMessage[];
		for (const handler of this.handlers.get("context") ?? []) {
			const visible = current.filter((message) => !isSystemMessage(message));
			const snapshot = visible.slice();
			const result = (await handler({ type: "context", messages: visible }, context)) as
				| { messages?: AgentMessage[] }
				| undefined;
			const returned = result?.messages ?? (sameMessages(visible, snapshot) ? undefined : visible);
			if (!returned || sameMessages(returned, snapshot)) continue;
			const head = collapseSystemMessages(current);
			current = head ? [head, ...returned] : returned;
		}
		return current;
	}
}

/**
 * The context Pi passes to tool `execute()`: `ExtensionContext` before Pi 0.99,
 * `ExtensionToolContext` (adds `tools` and `executeTool`) since then.
 */
export type ToolExecuteContext = Parameters<ToolDefinition["execute"]>[4];

/**
 * Tool-execution context over {@link fakeContext}. No other tools are callable:
 * `executeTool` reports every call as an unknown-tool error, as Pi does.
 */
export function fakeToolContext(
	sessionManager: FakeSessionManager | string,
	overrides: Record<string, unknown> = {},
): ToolExecuteContext {
	return {
		...(fakeContext(sessionManager) as unknown as Record<string, unknown>),
		tools: [],
		executeTool: async (name: string, args: unknown) => ({
			toolCall: { type: "toolCall", id: "fake/1", name, arguments: args ?? {} },
			result: { content: [{ type: "text", text: `Tool "${name}" is not available` }], details: undefined },
			isError: true,
		}),
		...overrides,
	} as unknown as ToolExecuteContext;
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

/**
 * The installed Pi CLI entrypoint, read from the package's `pi` bin: `dist/bundle/cli.js` on Pi 1.x,
 * `dist/cli.js` on Pi 0.84.2.
 */
export function piCliPath(): string {
	const root = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { bin?: string | Record<string, string> };
	const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.pi;
	if (!bin) throw new Error("@earendil-works/pi-coding-agent declares no pi bin");
	return join(root, bin);
}
