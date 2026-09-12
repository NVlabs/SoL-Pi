/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	AgentEndEvent,
	ContextEvent,
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	MessageEndEvent,
	MessageStartEvent,
	SessionBeforeCompactEvent,
	SessionCompactEvent,
	SessionInfoChangedEvent,
	SessionShutdownEvent,
	SessionStartEvent,
	SessionTreeEvent,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolResultEvent,
	TurnEndEvent,
	TurnStartEvent,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { runtimeRoot } from "../../runtime-paths.ts";
import {
	TrajectoryStore,
	TrajectoryWidget,
	type TrajectoryRecord,
	type TrajectoryRecordInput,
} from "./trajectory.ts";

export const TRAJECTORY_EVENT_SCHEMA = "sol_pi_trajectory_v1";
export const TRAJECTORY_EVENT_TYPE = "sol-pi-trajectory";
export const TRAJECTORY_WIDGET_KEY = "sol-pi-trajectory";

export interface TrajectoryInspectorOptions {
	/** Number of recent records shown in the live widget. */
	readonly maxRecords?: number;
}

interface ActiveSpan {
	readonly sequence: number;
	readonly startedAt: number;
}

interface ActiveState {
	readonly root: string;
	readonly recorder: TrajectoryRecorder;
	readonly toolSpans: Map<string, ActiveSpan>;
	visible: boolean;
	widgetConfigured: boolean;
	requestRender?: () => void;
	turn?: ActiveSpan & { readonly turnIndex: number };
	request?: ActiveSpan & { responseStatus?: number };
	assistant?: ActiveSpan;
	lastContext?: { readonly messages: number; readonly bytes: number };
}

function contentBytes(value: unknown): number {
	if (typeof value === "string") return Buffer.byteLength(value, "utf8");
	if (!Array.isArray(value)) return 0;
	return value.reduce((total, block) => {
		if (typeof block === "string") return total + Buffer.byteLength(block, "utf8");
		if (typeof block === "object" && block !== null && "text" in block && typeof block.text === "string") {
			return total + Buffer.byteLength(block.text, "utf8");
		}
		return total;
	}, 0);
}

function messageBytes(message: AgentMessage): number {
	return "content" in message ? contentBytes(message.content) : 0;
}

function modelLabel(context: ExtensionContext): string {
	const model = context.model;
	if (!model) return "model unavailable";
	return `${model.provider}/${model.id}`;
}

function errorStopReason(message: AgentMessage): boolean {
	if (message.role !== "assistant" || !("stopReason" in message)) return false;
	return message.stopReason === "error" || message.stopReason === "aborted";
}

class TrajectoryRecorder {
	private readonly runId = randomUUID();
	readonly store: TrajectoryStore;
	private readonly directory: string;
	private pending: string[] = [];
	private writes = Promise.resolve();

	constructor(root: string, maxRecords: number | undefined) {
		this.store = new TrajectoryStore(maxRecords);
		this.directory = join(root, "trajectory-inspector");
	}

	record(input: TrajectoryRecordInput, timestamp = Date.now()): TrajectoryRecord {
		const record = this.store.record(input, timestamp);
		this.enqueue({ event: "record", ...record });
		return record;
	}

	update(
		sequence: number,
		update: { readonly status?: TrajectoryRecord["status"]; readonly durationMs?: number; readonly detail?: string },
	): TrajectoryRecord | undefined {
		const record = this.store.update(sequence, update);
		// Keep completion metadata in the durable stream even after a record has
		// fallen out of the bounded UI tail.
		this.enqueue({ event: "update", sequence, ...update, timestamp: Date.now() });
		return record;
	}

	async flush(): Promise<void> {
		await this.writes;
	}

	private enqueue(entry: Record<string, unknown>): void {
		this.pending.push(`${JSON.stringify({ schema: TRAJECTORY_EVENT_SCHEMA, runId: this.runId, ...entry })}\n`);
		this.writes = this.writes
			.then(async () => {
				if (this.pending.length === 0) return;
				await mkdir(this.directory, { recursive: true });
				while (this.pending.length > 0) {
					const batch = this.pending.join("");
					this.pending = [];
					await appendFile(join(this.directory, "events.jsonl"), batch, "utf8");
				}
			})
			.catch((error) => {
				this.pending = [];
				// Observability must never change the agent's behavior.
				console.error(`[trajectory-inspector] ledger write failed: ${error instanceof Error ? error.message : String(error)}`);
			});
	}
}

function durationSince(span: ActiveSpan | undefined, timestamp: number): number | undefined {
	return span ? Math.max(0, timestamp - span.startedAt) : undefined;
}

function installWidget(state: ActiveState, context: ExtensionContext): void {
	if (!state.visible || context.mode !== "tui" || !context.hasUI || typeof context.ui.setWidget !== "function") return;
	if (state.widgetConfigured) return;
	context.ui.setWidget(
		TRAJECTORY_WIDGET_KEY,
		(tui, theme) => {
			state.requestRender = () => tui.requestRender();
			return new TrajectoryWidget(state.recorder.store, theme);
		},
		{ placement: "aboveEditor" },
	);
	state.widgetConfigured = true;
}

function removeWidget(state: ActiveState, context: ExtensionContext): void {
	if (context.mode === "tui" && context.hasUI && typeof context.ui.setWidget === "function") {
		context.ui.setWidget(TRAJECTORY_WIDGET_KEY, undefined);
	}
	state.widgetConfigured = false;
	state.requestRender = undefined;
}

export function createTrajectoryInspectorExtension(options: TrajectoryInspectorOptions = {}): ExtensionFactory {
	const maxRecords = options.maxRecords;
	return (pi) => {
		let active: ActiveState | undefined;

		const stateFor = (context: ExtensionContext): ActiveState | undefined => {
			try {
				const root = runtimeRoot(context);
				if (!active || active.root !== root) {
					active = {
						root,
						recorder: new TrajectoryRecorder(root, maxRecords),
						toolSpans: new Map(),
						visible: true,
						widgetConfigured: false,
					};
				}
				installWidget(active, context);
				return active;
			} catch {
				return undefined;
			}
		};

		const record = (context: ExtensionContext, input: TrajectoryRecordInput, timestamp = Date.now()): TrajectoryRecord | undefined => {
			const state = stateFor(context);
			if (!state) return undefined;
			const result = state.recorder.record(input, timestamp);
			state.requestRender?.();
			return result;
		};

		const update = (
			context: ExtensionContext,
			sequence: number | undefined,
			value: { readonly status?: TrajectoryRecord["status"]; readonly durationMs?: number; readonly detail?: string },
		): void => {
			if (sequence === undefined) return;
			const state = stateFor(context);
			if (!state) return;
			state.recorder.update(sequence, value);
			state.requestRender?.();
		};

		pi.registerCommand("trajectory", {
			description: "Toggle the live agent trajectory widget",
			handler: async (_args, context) => {
				if (context.mode !== "tui") return;
				const state = stateFor(context);
				if (!state) return;
				state.visible = !state.visible;
				if (state.visible) {
					installWidget(state, context);
					context.ui.notify("Trajectory widget enabled", "info");
				} else {
					removeWidget(state, context);
					context.ui.notify("Trajectory widget hidden", "info");
				}
			},
		});

		pi.on("session_start", (event: SessionStartEvent, context) => {
			const state = stateFor(context);
			if (!state) return;
			state.recorder.store.clear();
			state.toolSpans.clear();
			state.turn = undefined;
			state.request = undefined;
			state.assistant = undefined;
			state.lastContext = undefined;
			record(context, { kind: "session", label: `session ${event.reason}`, status: "info" });
		});

		pi.on("session_info_changed", (event: SessionInfoChangedEvent, context) => {
			record(context, { kind: "session", label: event.name ? "session renamed" : "session name cleared", status: "info" });
		});

		pi.on("session_tree", (event: SessionTreeEvent, context) => {
			record(context, { kind: "branch", label: `tree moved · ${event.newLeafId ?? "root"}`, status: "info" });
		});

		pi.on("agent_start", (_event, context) => {
			record(context, { kind: "agent", label: "agent started", status: "info" });
		});

		pi.on("agent_end", (event: AgentEndEvent, context) => {
			record(context, { kind: "agent", label: `agent ended · ${event.messages.length} messages`, status: event.messages.some(errorStopReason) ? "error" : "ok" });
		});

		pi.on("agent_settled", (_event, context) => {
			record(context, { kind: "agent", label: "agent settled", status: "ok" });
		});

		pi.on("turn_start", (event: TurnStartEvent, context) => {
			const result = record(context, { kind: "turn", label: `turn ${event.turnIndex} started`, status: "running", turnIndex: event.turnIndex }, event.timestamp);
			const state = stateFor(context);
			if (state && result) state.turn = { ...result, turnIndex: event.turnIndex, startedAt: event.timestamp };
		});

		pi.on("turn_end", (event: TurnEndEvent, context) => {
			const state = stateFor(context);
			const timestamp = Date.now();
			// Transport failures can end a turn without after_provider_response.
			update(context, state?.request?.sequence, {
				status: errorStopReason(event.message) ? "error" : "ok",
				durationMs: durationSince(state?.request, timestamp),
				detail: state?.request?.responseStatus === undefined ? "ended without response metadata" : `HTTP ${state.request.responseStatus}`,
			});
			if (state) state.request = undefined;
			update(context, state?.turn?.sequence, {
				status: errorStopReason(event.message) ? "error" : "ok",
				durationMs: durationSince(state?.turn, timestamp),
				detail: `${event.toolResults.length} tool results`,
			});
			if (state) state.turn = undefined;
		});

		pi.on("context", (event: ContextEvent, context) => {
			const bytes = event.messages.reduce((total, message) => total + messageBytes(message), 0);
			const state = stateFor(context);
			if (state) state.lastContext = { messages: event.messages.length, bytes };
			record(context, {
				kind: "context",
				label: `context · ${event.messages.length} messages · ${bytes} B`,
				status: "info",
				turnIndex: state?.turn?.turnIndex,
			});
		});

		pi.on("before_provider_request", (_event, context) => {
			const state = stateFor(context);
			const result = record(context, {
				kind: "request",
				label: `model request · ${modelLabel(context)}`,
				status: "running",
				turnIndex: state?.turn?.turnIndex,
				detail: state?.lastContext ? `${state.lastContext.messages} messages` : undefined,
			});
			if (state && result) state.request = { sequence: result.sequence, startedAt: result.timestamp };
		});

		pi.on("after_provider_response", (event, context) => {
			const state = stateFor(context);
			const timestamp = Date.now();
			// One logical request can receive several callbacks during provider retries.
			if (state?.request) state.request.responseStatus = event.status;
			update(context, state?.request?.sequence, {
				status: "running",
				durationMs: durationSince(state?.request, timestamp),
				detail: `HTTP ${event.status}`,
			});
		});

		pi.on("message_start", (event: MessageStartEvent, context) => {
			if (event.message.role !== "assistant") return;
			const state = stateFor(context);
			const result = record(context, { kind: "assistant", label: "assistant streaming", status: "running", turnIndex: state?.turn?.turnIndex });
			if (state && result) state.assistant = { sequence: result.sequence, startedAt: result.timestamp };
		});

		pi.on("message_end", (event: MessageEndEvent, context) => {
			if (event.message.role !== "assistant") return;
			const state = stateFor(context);
			const timestamp = Date.now();
			update(context, state?.request?.sequence, {
				status: errorStopReason(event.message) ? "error" : "ok",
				durationMs: durationSince(state?.request, timestamp),
				detail: state?.request?.responseStatus === undefined ? "ended without response metadata" : `HTTP ${state.request.responseStatus}`,
			});
			if (state) state.request = undefined;
			update(context, state?.assistant?.sequence, {
				status: errorStopReason(event.message) ? "error" : "ok",
				durationMs: durationSince(state?.assistant, timestamp),
				detail: `${messageBytes(event.message)} B`,
			});
			if (state) state.assistant = undefined;
		});

		pi.on("tool_execution_start", (event: ToolExecutionStartEvent, context) => {
			const state = stateFor(context);
			const result = record(context, {
				kind: "tool",
				label: `tool ${event.toolName}`,
				status: "running",
				turnIndex: state?.turn?.turnIndex,
				correlationId: event.toolCallId,
			});
			if (state && result) state.toolSpans.set(event.toolCallId, { sequence: result.sequence, startedAt: result.timestamp });
		});

		pi.on("tool_execution_end", (event: ToolExecutionEndEvent, context) => {
			const state = stateFor(context);
			const span = state?.toolSpans.get(event.toolCallId);
			update(context, span?.sequence, {
				status: event.isError ? "error" : "ok",
				durationMs: durationSince(span, Date.now()),
			});
			state?.toolSpans.delete(event.toolCallId);
		});

		pi.on("tool_result", (event: ToolResultEvent, context) => {
			const bytes = contentBytes(event.content);
			const state = stateFor(context);
			record(context, {
				kind: "result",
				label: `result ${event.toolName} · ${bytes} B`,
				status: event.isError ? "error" : "ok",
				turnIndex: state?.turn?.turnIndex,
				correlationId: event.toolCallId,
			});
		});

		pi.on("session_before_compact", (event: SessionBeforeCompactEvent, context) => {
			// The public API has no failed/cancelled compaction completion event.
			record(context, { kind: "compact", label: `compaction attempted · ${event.reason}`, status: "info" });
		});

		pi.on("session_compact", (event: SessionCompactEvent, context) => {
			record(context, { kind: "compact", label: event.fromExtension ? "compaction completed by extension" : "compaction completed", status: "ok" });
		});

		pi.on("model_select", (event, context) => {
			record(context, { kind: "model", label: `model selected · ${event.model.provider}/${event.model.id}`, status: "info" });
		});

		pi.on("thinking_level_select", (event, context) => {
			record(context, { kind: "model", label: `thinking level · ${event.level}`, status: "info" });
		});

		pi.on("session_shutdown", async (event: SessionShutdownEvent, context) => {
			const state = stateFor(context);
			if (!state) return;
			record(context, { kind: "session", label: `session shutdown · ${event.reason}`, status: "info" });
			await state.recorder.flush();
			removeWidget(state, context);
		});
	};
}

export function registerTrajectoryInspector(pi: ExtensionAPI, options: TrajectoryInspectorOptions = {}): void {
	createTrajectoryInspectorExtension(options)(pi);
}

export { TrajectoryStore, TrajectoryWidget, formatTrajectoryBytes, renderTrajectoryLines } from "./trajectory.ts";
export type { TrajectoryRecord, TrajectoryRecordInput, TrajectoryStatus } from "./trajectory.ts";

export default registerTrajectoryInspector;
