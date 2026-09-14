/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * KXPMS provider bridge - register the `kxpms` OpenAI-compatible gateway into
 * Pi's model registry so Evidence-Preserving Reducer can resolve it via
 * `registry.find("kxpms", <model-id>)`.
 *
 * Configuration is entirely env-driven (see SECURITY note below):
 *   KXPMS_BASE_URL  gateway base URL, default `https://llm.kxpms.cn/v1`
 *   KXPMS_API_KEY   bearer token; when unset or empty the provider is skipped
 *
 * SECURITY: no secrets are hardcoded here. If `KXPMS_API_KEY` is missing the
 * registration is a no-op and EPR falls back to whatever the operator has in
 * `~/.pi/agent/models.json` (which may also define `kxpms`). Registration is
 * idempotent: re-registering the same id is a safe upsert.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const DEFAULT_BASE_URL = "https://llm.kxpms.cn/v1";
export const KXPMS_PROVIDER_ID = "kxpms";

/** Default model catalog observed on the kxpms gateway. */
const KXPMS_MODELS = [
	{
		id: "minimax-m3",
		name: "MiniMax M3 (kxpms)",
		reasoning: true,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 32_000,
	},
	{
		id: "claude-sonnet-5",
		name: "Claude Sonnet 5 (kxpms)",
		reasoning: true,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 32_000,
	},
	{
		id: "claude-opus-5",
		name: "Claude Opus 5 (kxpms)",
		reasoning: true,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 32_000,
	},
	{
		id: "gpt-5.5",
		name: "GPT-5.5 (kxpms)",
		reasoning: true,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400_000,
		maxTokens: 128_000,
	},
	{
		id: "deepseek-chat-v3.1",
		name: "DeepSeek V3.1 (kxpms)",
		reasoning: false,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 32_000,
	},
];

/**
 * Register the `kxpms` provider into the ambient Pi ModelRegistry.
 *
 * Idempotent: silently skips when
 *   - `KXPMS_API_KEY` is unset/empty (no credentials to bind), or
 *   - `kxpms` is already registered (operator-configured in models.json).
 *
 * Returns `true` when the provider was registered by this call.
 */
export function registerKxpmsProvider(context: ExtensionContext): boolean {
	const apiKey = (process.env.KXPMS_API_KEY ?? "").trim();
	if (!apiKey) return false;

	const baseUrl = (process.env.KXPMS_BASE_URL ?? DEFAULT_BASE_URL).trim() || DEFAULT_BASE_URL;

	const registry = context.modelRegistry as unknown as {
		getRegisteredProviderIds?: () => readonly string[];
		registerProvider?: (providerName: string, config: unknown) => void;
	};

	// Respect an operator-provided registration (e.g. from ~/.pi/agent/models.json).
	const alreadyRegistered = registry.getRegisteredProviderIds?.().includes(KXPMS_PROVIDER_ID) ?? false;
	if (alreadyRegistered) return false;
	if (typeof registry.registerProvider !== "function") return false;

	registry.registerProvider(KXPMS_PROVIDER_ID, {
		name: "KXPMS LLM Gateway",
		baseUrl,
		apiKey,
		api: "openai-completions",
		models: KXPMS_MODELS,
	});
	return true;
}
