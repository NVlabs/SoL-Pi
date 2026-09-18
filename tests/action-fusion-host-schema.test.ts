/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { describe, expect, it } from "vitest";
import { Type, type TSchema } from "typebox";
import { hostToolProperties } from "../src/sol-pi/extensions/action-fusion/index.ts";

/**
 * A Pi-compatible host that describes tool parameters with its own schema value:
 * callable rather than a plain object, carrying no `properties`, and exposing the
 * contract only through `toJsonSchema()`.
 */
function hostSchema(json: { properties: Record<string, unknown>; required?: string[] }): unknown {
	const schema = (value: unknown) => value;
	schema.toJsonSchema = () => json;
	return schema;
}

describe("hostToolProperties", () => {
	it("returns the TypeBox properties Pi publishes", () => {
		const parameters = Type.Object({
			path: Type.String(),
			content: Type.String(),
		});

		expect(Object.keys(hostToolProperties(parameters))).toEqual(["path", "content"]);
	});

	it("rebuilds properties from a callable host schema that exposes no properties", () => {
		const parameters = hostSchema({
			properties: {
				path: { type: "string", description: "file path" },
				content: { type: "string", description: "file content" },
			},
			required: ["path", "content"],
		});

		const properties = hostToolProperties(parameters);

		expect(Object.keys(properties)).toEqual(["path", "content"]);
		const fused = Type.Object({ ...properties, then_run: Type.Optional(Type.String()) });
		expect(fused.required).toEqual(["path", "content"]);
	});

	it("keeps host-optional parameters optional on the fused tool", () => {
		const parameters = hostSchema({
			properties: {
				path: { type: "string" },
				encoding: { type: "string" },
			},
			required: ["path"],
		});

		// Unchecked cast: the rebuilt entries are the host's own JSON Schema fragments.

		const properties = hostToolProperties(parameters) as Record<string, TSchema>;
		const fused = Type.Object(properties);

		expect(fused.required).toEqual(["path"]);
	});

	it("preserves optional fields in direct JSON Schema parameters", () => {
		const properties = hostToolProperties({
			properties: { path: { type: "string" }, encoding: { type: "string" } },
			required: ["path"],
		}) as Record<string, TSchema>;
		expect(Type.Object(properties).required).toEqual(["path"]);
	});

	it("rejects throwing and malformed host schemas without replacing their tools", () => {
		const throwsProperties = Object.defineProperty({}, "properties", {
			get() { throw new Error("unsupported host schema"); },
		});
		const cases = [
			throwsProperties,
			{ toJsonSchema() { throw new Error("unsupported host schema"); } },
			{ toJsonSchema() { return null; } },
			{ toJsonSchema() { return { properties: { path: true } }; } },
			{ properties: { path: false } },
		];
		for (const parameters of cases) {
			expect(hostToolProperties(parameters)).toEqual({});
		}
	});

	it("reports no properties when the host exposes neither surface", () => {
		expect(hostToolProperties({ type: "object" })).toEqual({});
		expect(hostToolProperties(undefined)).toEqual({});
	});
});
