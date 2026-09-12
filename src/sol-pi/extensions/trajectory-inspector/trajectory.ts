/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";

export type TrajectoryStatus = "running" | "ok" | "error" | "info";

export interface TrajectoryRecord {
	readonly sequence: number;
	readonly timestamp: number;
	readonly kind: string;
	readonly label: string;
	readonly status: TrajectoryStatus;
	readonly turnIndex?: number;
	readonly correlationId?: string;
	readonly durationMs?: number;
	readonly detail?: string;
}

export interface TrajectoryRecordInput {
	readonly kind: string;
	readonly label: string;
	readonly status?: TrajectoryStatus;
	readonly turnIndex?: number;
	readonly correlationId?: string;
	readonly detail?: string;
}

const DEFAULT_MAX_RECORDS = 12;
const MAX_LABEL_LENGTH = 96;
const MAX_DETAIL_LENGTH = 64;

function clip(value: string, maxLength: number): string {
	value = stripTerminalSequences(value).replace(/[\x00-\x1f\x7f]/gu, " ");
	if (value.length <= maxLength) return value;
	return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function statusGlyph(status: TrajectoryStatus): string {
	if (status === "running") return "▶";
	if (status === "ok") return "✓";
	if (status === "error") return "✗";
	return "·";
}

function timeLabel(timestamp: number): string {
	return new Date(timestamp).toISOString().slice(11, 19);
}

function formatDuration(durationMs: number | undefined): string {
	if (durationMs === undefined) return "";
	if (durationMs < 1_000) return ` ${Math.round(durationMs)}ms`;
	return ` ${(durationMs / 1_000).toFixed(1)}s`;
}

export function formatTrajectoryBytes(bytes: number): string {
	if (bytes < 1_024) return `${bytes} B`;
	if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KiB`;
	return `${(bytes / (1_024 * 1_024)).toFixed(1)} MiB`;
}

export class TrajectoryStore {
	private readonly maxRecords: number;
	private records: TrajectoryRecord[] = [];
	private sequence = 0;

	constructor(maxRecords = DEFAULT_MAX_RECORDS) {
		if (!Number.isSafeInteger(maxRecords) || maxRecords < 1) {
			throw new Error("Trajectory Inspector maxRecords must be a positive safe integer");
		}
		this.maxRecords = maxRecords;
	}

	get totalRecords(): number {
		return this.sequence;
	}

	snapshot(): readonly TrajectoryRecord[] {
		return [...this.records];
	}

	clear(): void {
		this.records = [];
	}

	record(input: TrajectoryRecordInput, timestamp = Date.now()): TrajectoryRecord {
		const record: TrajectoryRecord = {
			sequence: ++this.sequence,
			timestamp,
			kind: clip(input.kind, 24),
			label: clip(input.label, MAX_LABEL_LENGTH),
			status: input.status ?? "info",
			...(input.turnIndex === undefined ? {} : { turnIndex: input.turnIndex }),
			...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
			...(input.detail === undefined ? {} : { detail: clip(input.detail, MAX_DETAIL_LENGTH) }),
		};
		this.records = [...this.records, record].slice(-this.maxRecords);
		return record;
	}

	update(sequence: number, update: { readonly status?: TrajectoryStatus; readonly durationMs?: number; readonly detail?: string }): TrajectoryRecord | undefined {
		const index = this.records.findIndex((record) => record.sequence === sequence);
		if (index < 0) return undefined;
		const current = this.records[index];
		if (!current) return undefined;
		const updated: TrajectoryRecord = {
			...current,
			...(update.status === undefined ? {} : { status: update.status }),
			...(update.durationMs === undefined ? {} : { durationMs: Math.max(0, update.durationMs) }),
			...(update.detail === undefined ? {} : { detail: clip(update.detail, MAX_DETAIL_LENGTH) }),
		};
		this.records = [...this.records.slice(0, index), updated, ...this.records.slice(index + 1)];
		return updated;
	}
}

export function renderTrajectoryLines(store: TrajectoryStore, theme: Theme, width = 120): string[] {
	const records = store.snapshot();
	const title = `${theme.fg("accent", "Trajectory")} ${theme.fg("dim", `· ${store.totalRecords} events · live`)}`;
	if (records.length === 0) return [title, theme.fg("muted", "  waiting for agent activity")].map(line => truncateToWidth(line, width));

	const maxTextWidth = Math.max(24, width - 18);
	return [
		title,
		...records.map((record) => {
			const turn = record.turnIndex === undefined ? "" : ` T${record.turnIndex}`;
			const detail = record.detail === undefined ? "" : ` · ${record.detail}`;
			const text = clip(`${record.label}${detail}`, maxTextWidth);
			return `${statusGlyph(record.status)} ${timeLabel(record.timestamp)}${turn} ${text}${formatDuration(record.durationMs)}`;
		}),
	].map(line => truncateToWidth(line, width));
}

export class TrajectoryWidget implements Component {
	constructor(
		private readonly store: TrajectoryStore,
		private readonly theme: Theme,
		private readonly width = 120,
	) {}

	render(width: number): string[] {
		return renderTrajectoryLines(this.store, this.theme, width || this.width);
	}

	invalidate(): void {}
}
