/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { REDUCER_EVENT_SCHEMA, REDUCER_EVENT_TYPE, type ReducerConfig } from "./config.ts";

/**
 * Append one non-context session entry per decision the reducer made.
 *
 * The entries never enter the LLM context. They record which results were
 * candidates, which were delegated, and why each fallback happened.
 */
export type Journal = (kind: string, data?: object) => void;

export function createJournal(pi: ExtensionAPI, config: ReducerConfig): Journal {
	return (kind, data = {}) => {
		pi.appendEntry(REDUCER_EVENT_TYPE, {
			schema: REDUCER_EVENT_SCHEMA,
			runId: config.runId,
			kind,
			...data,
		});
	};
}
