/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { describe, expect, it } from "vitest";
import {
	analyzePlanTransition,
	formatPlanSnapshot,
	parsePlanSteps,
	type PlanStep,
} from "../src/sol-pi/extensions/online-context-compact/index.ts";

const OPEN = [{ id: "build", goal: "build it", status: "in_progress" }] as const satisfies readonly PlanStep[];
const DONE = [{ id: "build", goal: "build it", status: "completed" }] as const satisfies readonly PlanStep[];

describe("Online Context Compact plans", () => {
	it("accepts stored empty plans and rejects malformed plans", () => {
		expect(parsePlanSteps([])).toEqual([]);
		expect(parsePlanSteps([{ goal: "missing id", status: "pending" }])).toBeUndefined();
		expect(parsePlanSteps([{ id: "x", goal: "x", status: "unknown" }])).toBeUndefined();
		expect(parsePlanSteps([{ id: "x", goal: "a", status: "pending" }, { id: "x", goal: "b", status: "pending" }]))
			.toBeUndefined();
		expect(parsePlanSteps(OPEN)).toEqual(OPEN);
	});

	it("detects only new transitions into completed", () => {
		expect(analyzePlanTransition(OPEN, DONE).completedSteps).toEqual(DONE);
		expect(analyzePlanTransition(DONE, DONE).completedSteps).toEqual([]);
	});

	it("flags ambiguous active work and reused ids with changed goals", () => {
		const transition = analyzePlanTransition(
			[{ id: "a", goal: "old", status: "in_progress" }],
			[
				{ id: "a", goal: "new", status: "in_progress" },
				{ id: "b", goal: "second", status: "in_progress" },
			],
		);
		expect(transition.advice.join("\n")).toContain("changed goal");
		expect(transition.advice.join("\n")).toContain("at most one");
	});

	it("formats a compact progress-only snapshot", () => {
		const snapshot = formatPlanSnapshot(OPEN);
		expect(snapshot).toContain('<sol-pi-plan task_status="active">');
		expect(snapshot).toContain(JSON.stringify({ steps: OPEN }));
	});
});
