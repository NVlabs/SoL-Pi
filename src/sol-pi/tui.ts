/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Text } from "@earendil-works/pi-tui";

export type SolPiTuiMechanism =
	| "Action Fusion"
	| "Observation Pack"
	| "Luna Delegating"
	| "Online Context Compact";

const STATUS_KEY = "sol-pi-savings";
const STATUS_DURATION_MS = 4_000;
const INTEGER_FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const statusTimers = new WeakMap<ExtensionContext["ui"], ReturnType<typeof setTimeout>>();

export function formatSavingsCount(value: number, unit: string): string {
	const count = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
	return `${INTEGER_FORMAT.format(count)} ${unit}`;
}

function compactDecimal(value: number): string {
	return value.toFixed(1).replace(/\.0$/u, "");
}

export function formatSavingsBytes(value: number): string {
	const bytes = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
	if (bytes >= 1024 * 1024) {
		return `${compactDecimal(bytes / (1024 * 1024))} MiB removed from future prompts`;
	}
	if (bytes >= 1024) return `${compactDecimal(bytes / 1024)} KiB removed from future prompts`;
	return `${INTEGER_FORMAT.format(bytes)} B removed from future prompts`;
}

export function renderSolPiTool(
	theme: Theme,
	mechanism: SolPiTuiMechanism,
	saving: string,
	base?: Component,
): Component {
	const container = new Container();
	const title = `${theme.fg("warning", "⚡")} ${theme.fg("accent", theme.bold(`SoL-Pi · ${mechanism}`))}`;
	container.addChild(new Text(title, 0, 0));
	container.addChild(new Text(theme.fg("success", `Money saved · ${saving}`), 0, 0));
	if (base) container.addChild(base);
	return container;
}

export function showSolPiSavings(
	context: ExtensionContext,
	mechanism: SolPiTuiMechanism,
	saving: string,
): void {
	if (context.mode !== "tui") return;
	const message = `⚡ SoL-Pi · ${mechanism}\nMoney saved · ${saving}`;
	context.ui.notify(message, "info");
	context.ui.setStatus(STATUS_KEY, `⚡ ${mechanism} · ${saving}`);

	const previous = statusTimers.get(context.ui);
	if (previous) clearTimeout(previous);
	const timer = setTimeout(() => {
		if (statusTimers.get(context.ui) !== timer) return;
		statusTimers.delete(context.ui);
		context.ui.setStatus(STATUS_KEY, undefined);
	}, STATUS_DURATION_MS);
	if (typeof timer === "object" && "unref" in timer) timer.unref();
	statusTimers.set(context.ui, timer);
}
