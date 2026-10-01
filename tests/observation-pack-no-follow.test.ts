/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { constants } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, constants: { ...actual.constants, O_NOFOLLOW: 0 } };
});

import {
	createObservationPackExtension,
	THRESHOLD_BYTES,
} from "../src/sol-pi/extensions/observation-pack/index.ts";
import { FakePi, fakeContext } from "./helpers.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("is either explicitly unavailable or fully functional without atomic no-follow", async () => {
	const pi = new FakePi();
	let registrationError: unknown;
	try {
		createObservationPackExtension()(pi.asExtensionApi());
	} catch (error) {
		registrationError = error;
	}

	if (registrationError !== undefined) {
		expect(registrationError).toBeInstanceOf(Error);
		expect(String(registrationError)).toMatch(/atomic no-follow|unsupported/iu);
		return;
	}

	const sessionDir = await mkdtemp(join(tmpdir(), "observation-no-follow-"));
	roots.push(sessionDir);
	const body = "x".repeat(THRESHOLD_BYTES + 1);
	const message: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "bash",
		content: [{ type: "text", text: body }],
		isError: false,
		timestamp: 1,
	};

	let projected = [message];
	for (let index = 0; index < 3; index += 1) {
		projected = (await pi.emitContext(projected, fakeContext(sessionDir))) as ToolResultMessage[];
	}
	const projectedText = projected[0]?.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
	expect(projectedText).toMatch(/id: obs_[a-f0-9]{24}/u);
	expect(constants.O_NOFOLLOW).toBe(0);
});
