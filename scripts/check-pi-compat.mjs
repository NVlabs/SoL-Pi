/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import {
	CONFIG_DIR_NAME,
	ModelRegistry,
	SessionManager,
	createBashToolDefinition,
	createEditToolDefinition,
	createWriteToolDefinition,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { complete as completeCompat } from "@earendil-works/pi-ai/compat";

for (const [name, value] of Object.entries({
	createBashToolDefinition,
	createEditToolDefinition,
	createWriteToolDefinition,
	getApiKeyAndHeaders: ModelRegistry.prototype.getApiKeyAndHeaders,
	getAgentDir,
	piAiCompatComplete: completeCompat,
	sessionManagerGetSessionDir: SessionManager.prototype.getSessionDir,
	sessionManagerGetSessionId: SessionManager.prototype.getSessionId,
})) {
	if (typeof value !== "function") throw new Error(`Missing public Pi API: ${name}`);
}

if (typeof CONFIG_DIR_NAME !== "string" || CONFIG_DIR_NAME.length === 0) {
	throw new Error("Missing public Pi API: CONFIG_DIR_NAME");
}
