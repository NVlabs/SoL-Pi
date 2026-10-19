/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import * as pi from "@earendil-works/pi-coding-agent";
import { estimateTokens, findCutPoint, sessionEntryToContextMessages, type SessionEntry } from "@earendil-works/pi-coding-agent";

type ProjectedEntry = { readonly sourceEntry: SessionEntry; readonly messages: readonly AgentMessage[] };
type ProjectionApi = {
	readonly buildSessionProjection?: (entries: SessionEntry[]) => { readonly entries: readonly ProjectedEntry[] };
};

/** Pi 1.0 applies context edits before choosing a cut; older Pi uses raw messages. */
function contextEntries(entries: readonly SessionEntry[]): readonly ProjectedEntry[] {
	const buildProjection = (pi as unknown as ProjectionApi).buildSessionProjection;
	if (buildProjection) return buildProjection([...entries]).entries;
	const lastCompaction = entries.findLastIndex((entry) => entry.type === "compaction");
	let active = entries;
	if (lastCompaction >= 0) {
		const compaction = entries[lastCompaction];
		if (compaction?.type === "compaction") {
			const firstKept = entries.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
			active = [compaction, ...(firstKept >= 0 ? entries.slice(firstKept, lastCompaction) : []), ...entries.slice(lastCompaction + 1)];
		}
	}
	return active.map((sourceEntry, index) => ({
		sourceEntry,
		messages: sourceEntry.type === "compaction" && index > 0 ? [] : sessionEntryToContextMessages(sourceEntry),
	}));
}

/** ObservationPack changes tool-result content while preserving its call identity. */
function messageKey(message: AgentMessage): string {
	return message.role === "toolResult"
		? `tool:${JSON.stringify([message.toolCallId, message.toolName, message.timestamp])}`
		: JSON.stringify(message);
}

/** Map the last observed projection to source entries, without rerunning context hooks. */
export function projectedEntryTokens(
	entries: readonly SessionEntry[],
	projected: readonly AgentMessage[],
): ReadonlyMap<string, number> {
	const sources = new Map<string, string[]>();
	for (const { sourceEntry, messages } of contextEntries(entries)) {
		for (const message of messages) {
			// A compaction preserves its system checkpoint; only its summary is replaced.
			if (String(message.role) === "system") continue;
			const key = messageKey(message);
			const ids = sources.get(key) ?? [];
			ids.push(sourceEntry.id);
			sources.set(key, ids);
		}
	}
	const visible = new Map<string, number[]>();
	for (const message of projected) {
		const key = messageKey(message);
		const sizes = visible.get(key) ?? [];
		sizes.push(estimateTokens(message));
		visible.set(key, sizes);
	}
	const tokens = new Map<string, number>();
	for (const [key, ids] of sources) {
		const sizes = visible.get(key);
		// Dropped, rewritten, newly appended, or ambiguously duplicated messages
		// provide no proven savings. Never fall back to their raw content size.
		if (!sizes || sizes.length !== ids.length || (key.startsWith("tool:") && ids.length > 1)) continue;
		for (let index = 0; index < ids.length; index++) {
			const id = ids[index]!;
			tokens.set(id, (tokens.get(id) ?? 0) + sizes[index]!);
		}
	}
	return tokens;
}

/** Materialize Pi's canonical messages for its public cut-point helper. */
function cutEntries(projected: readonly ProjectedEntry[]): SessionEntry[] {
	return projected.map(({ sourceEntry, messages }) => {
		if (sourceEntry.type === "compaction") {
			// The latest checkpoint is outside the cut range. Retained older checkpoints
			// are invisible, but their entry type still stops metadata-boundary movement.
			return { ...sourceEntry, summary: "", systemMessage: undefined };
		}
		const message = messages[0];
		if (message) return { ...sourceEntry, type: "message", message } as SessionEntry;
		return { ...sourceEntry, type: "custom", customType: "sol-pi-projection-empty", data: undefined } as SessionEntry;
	});
}

/**
 * Price the prefix Pi can remove, using its canonical projection for the cut and
 * the last observed extension projection for savings. No context hook runs twice.
 */
export function estimateProjectedCompactionTokens(
	entries: readonly SessionEntry[],
	keepRecentTokens: number,
	projectedMessages?: readonly AgentMessage[],
): number {
	const projected = contextEntries(entries);
	const path = cutEntries(projected);
	const previous = projected.findIndex(({ sourceEntry, messages }) => sourceEntry.type === "compaction" && messages.length > 0);
	const start = previous >= 0 ? previous + 1 : 0;
	// The agent can append an empty aborted assistant after OCC stops the turn.
	// It contributes no tokens but makes the same trailing cut available to Pi.
	path.push({
		type: "message", id: "sol-pi-online-context-compact-abort-marker", parentId: path.at(-1)?.id ?? null,
		timestamp: new Date(0).toISOString(),
		message: { role: "assistant", content: [], api: "sol-pi", provider: "sol-pi", model: "aborted",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "aborted", timestamp: 0 },
	} as SessionEntry);
	// Pi 1.0 can additionally advance through a closed recovery-omission suffix.
	// Its public helper may keep that suffix; conservatively price the smaller prefix.
	const cut = findCutPoint(path, start, path.length, keepRecentTokens).firstKeptEntryIndex;
	const prefix = projected.slice(start, cut);
	// System messages survive as the next checkpoint and are never summarized.
	const removable = (entry: ProjectedEntry): readonly AgentMessage[] =>
		entry.sourceEntry.type === "compaction" ? [] : entry.messages.filter((message) => String(message.role) !== "system");
	if (!prefix.some((entry) => removable(entry).length > 0)) return 0;
	const sizes = projectedMessages === undefined ? undefined : projectedEntryTokens(entries, projectedMessages);
	const prefixTokens = prefix.reduce((total, entry) => total + (sizes
		? sizes.get(entry.sourceEntry.id) ?? 0
		: removable(entry).reduce((sum, message) => sum + estimateTokens(message), 0)), 0);
	const previousEntry = projected[previous];
	const previousTokens = previousEntry ? (sizes
		? sizes.get(previousEntry.sourceEntry.id) ?? 0
		: previousEntry.messages.filter((message) => message.role === "compactionSummary")
			.reduce((sum, message) => sum + estimateTokens(message), 0)) : 0;
	return prefixTokens + previousTokens;
}
