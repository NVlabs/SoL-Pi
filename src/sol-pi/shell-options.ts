/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { getAgentDir, SettingsManager, type BashToolOptions } from "@earendil-works/pi-coding-agent";

/**
 * The part of Pi's `SettingsManager` Action Fusion reads. Pi provides all of
 * it; a Pi-compatible host may publish a settings object with less.
 */
type ShellSettings = {
	readonly drainErrors?: () => readonly { readonly error: Error }[];
	readonly getShellPath?: () => string | undefined;
	readonly getShellCommandPrefix?: () => string | undefined;
};

export type ShellSettingsFactory = (
	cwd: string,
	agentDir: string,
	options: { readonly projectTrusted: boolean },
) => ShellSettings;

const piShellSettings: ShellSettingsFactory = (cwd, agentDir, options) =>
	SettingsManager.create(cwd, agentDir, options);

/**
 * Inherit Pi's file-backed shell settings without trusting unapproved project
 * settings. Malformed settings still stop initialization; a host that does not
 * publish one of these optional methods keeps the platform default instead of
 * taking the whole extension down.
 */
export function loadActionFusionBashOptions(
	cwd: string,
	projectTrusted: boolean,
	agentDir: string = getAgentDir(),
	createSettings: ShellSettingsFactory = piShellSettings,
): BashToolOptions {
	const settings = createSettings(cwd, agentDir, { projectTrusted });
	const errors = settings.drainErrors?.() ?? [];
	if (errors.length > 0) {
		throw new Error(`Action Fusion could not load Pi shell settings: ${errors.map(({ error }) => error.message).join("; ")}`);
	}
	return {
		shellPath: settings.getShellPath?.(),
		commandPrefix: settings.getShellCommandPrefix?.(),
	};
}
