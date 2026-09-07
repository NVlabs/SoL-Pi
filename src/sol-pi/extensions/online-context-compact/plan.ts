/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

export const PLAN_STATUSES = ["pending", "in_progress", "completed"] as const;

export type PlanStatus = (typeof PLAN_STATUSES)[number];

export type PlanStep = {
	readonly id: string;
	readonly goal: string;
	readonly status: PlanStatus;
};

export type PlanTransition = {
	readonly completedSteps: readonly PlanStep[];
	readonly advice: readonly string[];
};

const MAX_PLAN_STEPS = 128;
const MAX_PLAN_STRING_BYTES = 16_384;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= MAX_PLAN_STRING_BYTES;
}

function isPlanStatus(value: unknown): value is PlanStatus {
	return PLAN_STATUSES.some((status) => status === value);
}

export function parsePlanSteps(value: unknown): readonly PlanStep[] | undefined {
	if (!Array.isArray(value) || value.length > MAX_PLAN_STEPS) return;
	const steps: PlanStep[] = [];
	for (const item of value) {
		if (
			!isRecord(item) ||
			Object.keys(item).length !== 3 ||
			!isBoundedString(item.id) ||
			!isBoundedString(item.goal) ||
			!isPlanStatus(item.status)
		) {
			return;
		}
		steps.push({ id: item.id, goal: item.goal, status: item.status });
	}
	if (new Set(steps.map((step) => step.id)).size !== steps.length) return;
	return steps;
}

export function analyzePlanTransition(previous: readonly PlanStep[], next: readonly PlanStep[]): PlanTransition {
	const previousById = new Map(previous.map((step) => [step.id, step]));
	const completedSteps: PlanStep[] = [];
	const advice: string[] = [];

	for (const step of next) {
		const prior = previousById.get(step.id);
		if ((!prior || prior.status !== "completed") && step.status === "completed") completedSteps.push(step);
		if (prior && prior.goal !== step.goal) {
			advice.push(`Plan step ${JSON.stringify(step.id)} changed goal; reuse an id only for the same goal.`);
		}
	}

	const inProgress = next.filter((step) => step.status === "in_progress").length;
	if (inProgress > 1) advice.push("Keep at most one plan step in_progress.");
	if (inProgress === 0 && next.some((step) => step.status === "pending")) {
		advice.push("Mark one pending plan step in_progress before starting it.");
	}

	return { completedSteps, advice };
}

export function formatPlanSnapshot(steps: readonly PlanStep[]): string {
	return `<sol-pi-plan task_status="active">${JSON.stringify({ steps })}</sol-pi-plan>`;
}
