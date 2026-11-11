/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { getAgentDir, SettingsManager, type BashToolOptions } from "@earendil-works/pi-coding-agent";

/** Inherit Pi's file-backed shell settings without trusting unapproved project settings. */
export function loadActionFusionBashOptions(
	cwd: string,
	projectTrusted: boolean,
	agentDir: string = getAgentDir(),
): BashToolOptions {
	const settings = SettingsManager.create(cwd, agentDir, { projectTrusted });
	const errors = settings.drainErrors();
	if (errors.length > 0) {
		throw new Error(`Action Fusion could not load Pi shell settings: ${errors.map(({ error }) => error.message).join("; ")}`);
	}
	return {
		shellPath: settings.getShellPath(),
		commandPrefix: settings.getShellCommandPrefix(),
	};
}
