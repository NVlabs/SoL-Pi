/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { arch, platform, release, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createObservationPackExtension } from "../src/sol-pi/extensions/observation-pack/index.ts";
import { createLedger } from "../src/sol-pi/extensions/observation-pack/ledger.ts";
import { FakePi, fakeContext } from "./helpers.ts";

const fsMocks = vi.hoisted(() => ({ appendFile: vi.fn(), mkdir: vi.fn() }));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	fsMocks.appendFile.mockImplementation((...args: unknown[]) => Reflect.apply(actual.appendFile, actual, args));
	fsMocks.mkdir.mockImplementation((...args: unknown[]) => Reflect.apply(actual.mkdir, actual, args));
	return { ...actual, appendFile: fsMocks.appendFile, mkdir: fsMocks.mkdir };
});

type Variant = "baseline" | "candidate";
type Measurement = { wallMs: number; mkdirCalls: number; appendFileCalls: number };
type ContextResult = Measurement & { outputs: string[]; ledger: Record<string, unknown>[] };
type LedgerResult = Measurement & { ledger: Record<string, unknown>[] };
type BaselineIndexModule = { createObservationPackExtension: typeof createObservationPackExtension };
type BaselineLedgerModule = {
	createLedger(path: string): (entry: Record<string, unknown>) => Promise<void>;
};

const BASELINE_HEAD = "2b791687a489a1d24da816cf1634d8ae1d36befd";
const outputPath = process.env.OBSERVATION_PACK_BENCHMARK_OUT;
const benchmark = outputPath ? describe : describe.skip;
const baselineIndexPath = resolve("src/sol-pi/extensions/observation-pack/index.baseline-benchmark.ts");
const baselineLedgerPath = resolve("src/sol-pi/extensions/observation-pack/ledger.baseline-benchmark.ts");
let baselineIndex: BaselineIndexModule | undefined;
let baselineLedger: BaselineLedgerModule | undefined;

function gitShow(path: string): string {
	return execFileSync("git", ["show", `${BASELINE_HEAD}:${path}`], { encoding: "utf8" });
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

async function prepareRealBaseline(): Promise<Array<{ path: string; sha256: string }>> {
	const sharedPaths = [
		"src/sol-pi/extensions/observation-pack/observation.ts",
		"src/sol-pi/runtime-paths.ts",
		"src/sol-pi/tui.ts",
	];
	const verified = [];
	for (const path of sharedPaths) {
		const baseline = gitShow(path);
		const candidate = await readFile(resolve(path), "utf8");
		expect(candidate).toBe(baseline);
		verified.push({ path, sha256: sha256(baseline) });
	}

	const indexSource = gitShow("src/sol-pi/extensions/observation-pack/index.ts").replace(
		'from "./ledger.ts"',
		'from "./ledger.baseline-benchmark.ts"',
	);
	await writeFile(baselineIndexPath, indexSource, "utf8");
	await writeFile(baselineLedgerPath, gitShow("src/sol-pi/extensions/observation-pack/ledger.ts"), "utf8");
	baselineIndex = (await import(`${baselineIndexPath}?baseline=${BASELINE_HEAD}`)) as BaselineIndexModule;
	baselineLedger = (await import(`${baselineLedgerPath}?baseline=${BASELINE_HEAD}`)) as BaselineLedgerModule;
	return verified;
}

afterAll(async () => {
	await Promise.all([rm(baselineIndexPath, { force: true }), rm(baselineLedgerPath, { force: true })]);
});

function messages(count: number, bytes: number): ToolResultMessage[] {
	return Array.from({ length: count }, (_, index) => {
		const prefix = `synthetic-${index}\n`;
		return {
			role: "toolResult",
			toolCallId: `benchmark-call-${index}`,
			toolName: "bash",
			content: [{ type: "text", text: `${prefix}${"x".repeat(bytes - Buffer.byteLength(prefix))}` }],
			isError: false,
			timestamp: 1,
		};
	});
}

function stripTimestamps(entries: Record<string, unknown>[]): Record<string, unknown>[] {
	return entries.map(({ timestamp: _timestamp, ...entry }) => entry);
}

async function ledgerEntries(path: string): Promise<Record<string, unknown>[]> {
	return (await readFile(path, "utf8"))
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function measure(run: () => Promise<void>): Promise<Measurement> {
	fsMocks.appendFile.mockClear();
	fsMocks.mkdir.mockClear();
	const start = performance.now();
	await run();
	return {
		wallMs: performance.now() - start,
		mkdirCalls: fsMocks.mkdir.mock.calls.length,
		appendFileCalls: fsMocks.appendFile.mock.calls.length,
	};
}

function onlyMeasurement(result: Measurement): Measurement {
	return { wallMs: result.wallMs, mkdirCalls: result.mkdirCalls, appendFileCalls: result.appendFileCalls };
}

async function runLedger(variant: Variant, count: number, bytes: number): Promise<LedgerResult> {
	const root = await mkdtemp(join(tmpdir(), `observationpack-ledger-${variant}-`));
	try {
		const path = join(root, "ledger.jsonl");
		const entries = Array.from({ length: count }, (_, index) => ({
			event: index < 2 ? "full" : "placeholder",
			id: `obs_${index.toString(16).padStart(24, "0")}`,
			request: 1,
			tool: "bash",
			originalBytes: bytes,
		}));
		const metrics = await measure(async () => {
			if (variant === "candidate") {
				await createLedger(path)(entries);
				return;
			}
			const ledger = baselineLedger!.createLedger(path);
			for (const entry of entries) await ledger(entry);
		});
		return { ...metrics, ledger: stripTimestamps(await ledgerEntries(path)) };
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function runContext(variant: Variant, count: number, bytes: number): Promise<ContextResult> {
	const sessionDir = await mkdtemp(join(tmpdir(), `observationpack-context-${variant}-`));
	try {
		const pi = new FakePi();
		const factory = variant === "baseline" ? baselineIndex!.createObservationPackExtension : createObservationPackExtension;
		factory()(pi.asExtensionApi());
		const input = messages(count, bytes);
		const context = fakeContext(sessionDir);
		const outputs: string[] = [];
		const metrics = await measure(async () => {
			for (let request = 0; request < 3; request += 1) outputs.push(JSON.stringify(await pi.emitContext(input, context)));
		});
		return {
			...metrics,
			outputs,
			ledger: stripTimestamps(
				await ledgerEntries(join(sessionDir, "sol-pi", "session-a", "observation-pack", "ledger.jsonl")),
			),
		};
	} finally {
		await rm(sessionDir, { recursive: true, force: true });
	}
}

function percentile(values: number[], fraction: number): number {
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
}

function summary(samples: Measurement[]) {
	const field = (key: keyof Measurement) => ({
		median: percentile(samples.map((sample) => sample[key]), 0.5),
		p95: percentile(samples.map((sample) => sample[key]), 0.95),
	});
	return { wallMs: field("wallMs"), mkdirCalls: field("mkdirCalls"), appendFileCalls: field("appendFileCalls") };
}

benchmark("observation pack synthetic disk benchmark", () => {
	it(
		"runs the real git baseline and candidate with identical synthetic inputs",
		async () => {
			const sharedSourceVerification = await prepareRealBaseline();
			const cases = [16 * 1024, 50 * 1024].flatMap((bytes) => [1, 12, 50].map((count) => ({ count, bytes })));
			const results = [];

			for (const benchmarkCase of cases) {
				const { count, bytes } = benchmarkCase;
				const pair = async (phase: "ledger" | "context", first: Variant) => {
					const second: Variant = first === "baseline" ? "candidate" : "baseline";
					const run = phase === "ledger" ? runLedger : runContext;
					const firstResult = await run(first, count, bytes);
					const secondResult = await run(second, count, bytes);
					expect(firstResult.ledger).toEqual(secondResult.ledger);
					if ("outputs" in firstResult && "outputs" in secondResult) expect(firstResult.outputs).toEqual(secondResult.outputs);
					return { [first]: firstResult, [second]: secondResult } as Record<Variant, LedgerResult | ContextResult>;
				};

				await pair("ledger", "baseline");
				await pair("context", "candidate");
				const samples = {
					ledgerOnly: { baseline: [] as Measurement[], candidate: [] as Measurement[] },
					context: { baseline: [] as Measurement[], candidate: [] as Measurement[] },
				};
				for (let round = 0; round < 5; round += 1) {
					const first: Variant = round % 2 === 0 ? "baseline" : "candidate";
					const ledger = await pair("ledger", first);
					const context = await pair("context", first);
					for (const variant of ["baseline", "candidate"] as const) {
						samples.ledgerOnly[variant].push(onlyMeasurement(ledger[variant]));
						samples.context[variant].push(onlyMeasurement(context[variant]));
					}
				}

				expect(samples.ledgerOnly.baseline[0]?.appendFileCalls).toBe(count);
				expect(samples.ledgerOnly.candidate[0]?.appendFileCalls).toBe(1);
				expect(samples.context.baseline[0]?.appendFileCalls).toBe(count * 3);
				expect(samples.context.candidate[0]?.appendFileCalls).toBe(3);
				results.push({
					...benchmarkCase,
					ledgerOnly: {
						baseline: { summary: summary(samples.ledgerOnly.baseline), samples: samples.ledgerOnly.baseline },
						candidate: { summary: summary(samples.ledgerOnly.candidate), samples: samples.ledgerOnly.candidate },
					},
					context: {
						baseline: { summary: summary(samples.context.baseline), samples: samples.context.baseline },
						candidate: { summary: summary(samples.context.candidate), samples: samples.context.candidate },
					},
				});
			}

			await writeFile(
				resolve(outputPath!),
				`${JSON.stringify(
					{
						generatedAt: new Date().toISOString(),
						baselineHead: BASELINE_HEAD,
						baselineMethod: "git show of real index.ts and ledger.ts; only baseline index ledger import path rewritten",
						sharedSourceVerification,
						runtime: {
							node: process.version,
							npm: execFileSync("npm", ["--version"], { encoding: "utf8" }).trim(),
							os: platform(),
							osRelease: release(),
							arch: arch(),
						},
						warmupPairs: 1,
						measuredSamplesPerVariant: 5,
						p95Note: "With five samples, nearest-rank p95 equals the maximum sample.",
						callCounts: "instrumented node:fs/promises function calls, not operating-system syscall counts",
						cases: results,
					},
					null,
					2,
				)}\n`,
				"utf8",
			);
		},
		120_000,
	);
});
