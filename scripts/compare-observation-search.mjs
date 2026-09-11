/* SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createObservationPackExtension } from "../src/sol-pi/extensions/observation-pack/index.ts";
import { ensureStored, observationPath, placeholderFor } from "../src/sol-pi/extensions/observation-pack/observation.ts";

const outputPath = process.argv.indexOf("--out") >= 0 ? process.argv[process.argv.indexOf("--out") + 1] : undefined;
if (!outputPath) throw new Error("Usage: node --experimental-strip-types scripts/compare-observation-search.mjs --out /absolute/result.json");

const root = await mkdtemp(join(tmpdir(), "sol-pi-search-compare-"));
const sessionId = "comparison";
const archiveRoot = join(root, "sol-pi", sessionId);
const initialLines = [
	"front needle alpha",
	"case Needle needle",
	"repeated needle needle needle",
];
const boundaryPrefix = `${initialLines.join("\n")}\nboundary `;
const body = `${boundaryPrefix}${"x".repeat(4095 - Buffer.byteLength(boundaryPrefix))}☾needle\nmiddle ${"padding\n".repeat(900)}tail needle omega`;
if (Buffer.byteLength(body.slice(0, body.indexOf("☾n")), "utf8") !== 4095) throw new Error("boundary fixture did not cross byte 4096");
const contentHash = createHash("sha256").update(body).digest("hex");
const id = `obs_${createHash("sha256").update(`compare\0compare\0${contentHash}`).digest("hex").slice(0, 24)}`;
const observation = { id, contentHash, filePath: observationPath(archiveRoot, id), toolName: "compare", text: body, bytes: Buffer.byteLength(body), lines: body.split("\n").length, tokens: Math.ceil(body.length / 4) };
try {
await ensureStored(observation);

const registeredTools = [];
createObservationPackExtension()({ registerTool: (tool) => registeredTools.push(tool), on: () => undefined });
const recall = registeredTools.find((tool) => tool.name === "obs_recall");
if (!recall) throw new Error("obs_recall was not registered");
const context = { signal: undefined, sessionManager: { getSessionDir: () => root, getSessionId: () => sessionId } };
const archivePath = observationPath(archiveRoot, id);

function sourceStarts(query, offset = 0) {
	const needle = Buffer.from(query);
	const bytes = Buffer.from(body);
	const starts = [];
	for (let index = bytes.indexOf(needle, offset); index >= 0; index = bytes.indexOf(needle, index + 1)) starts.push(index);
	return starts;
}

function shellLiteral(query) {
	for (const command of [["rg", ["-F", "-n", "-b", "-o", "--no-heading", "--", query, archivePath]], ["grep", ["-F", "-b", "-o", "--", query, archivePath]]]) {
		const result = spawnSync(command[0], command[1], { encoding: "utf8" });
		if (result.error?.code === "ENOENT") continue;
		if (result.status !== 0 && result.status !== 1) throw new Error(`shell baseline failed: ${command[0]} ${result.stderr ?? ""}`);
		const starts = (result.stdout ?? "").split("\n").flatMap((line) => {
			const match = command[0] === "rg" ? /^\d+:(\d+):/u.exec(line) : /^(\d+):/u.exec(line);
			return match?.[1] === undefined ? [] : [Number(match[1])];
		});
		const argvBytes = [command[0], ...command[1]].reduce((total, argument) => total + Buffer.byteLength(argument, "utf8"), 0) + command[1].length;
		return { command: `${command[0]} ${command[1].slice(0, 5).join(" ")}`, status: result.status, starts, stdoutBytes: Buffer.byteLength(result.stdout ?? ""), argvBytes, argvConvention: "UTF-8 executable and argument bytes separated by one NUL byte", stderr: result.stderr || undefined };
	}
	return { command: "unavailable", status: null, note: "Neither rg nor grep was available; shell baseline omitted." };
}

async function page() {
	const started = performance.now();
	let offset = 0;
	let calls = 0;
	let requestBytes = 0;
	let resultBytes = 0;
	let recalled = "";
	for (;;) {
		const args = { id, offset };
		requestBytes += Buffer.byteLength(JSON.stringify(args));
		const result = await recall.execute("compare-page", args, undefined, undefined, context);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		resultBytes += Buffer.byteLength(text);
		const first = text.indexOf("\n");
		const second = text.indexOf("\n", first + 1);
		recalled += text.slice(second + 1);
		const details = result.details;
		offset = details.nextOffset;
		calls += 1;
		if (details.eof) break;
	}
	if (recalled !== body) throw new Error("paged recall did not preserve source bytes");
	return { calls, requestBytes, resultBytes, returnedSourceBytes: Buffer.byteLength(recalled, "utf8"), elapsedMs: performance.now() - started, sourceFidelity: true };
}

async function search(query) {
	const toolStarted = performance.now();
	let offset = 0;
	let calls = 0;
	let resultBytes = 0;
	let requestBytes = 0;
	let scannedBytes = 0;
	const matches = [];
	let eof = false;
	while (!eof) {
		const args = { id, query, offset };
		requestBytes += Buffer.byteLength(JSON.stringify(args));
		const result = await recall.execute("compare", args, undefined, undefined, context);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		resultBytes += Buffer.byteLength(text);
		const details = result.details;
		scannedBytes += details.scannedBytes ?? 0;
		matches.push(...details.matches);
		offset = details.nextOffset;
		eof = details.eof;
		calls += 1;
		if (calls > 100) throw new Error("search did not converge");
	}
	const toolElapsedMs = performance.now() - toolStarted;
	const shellStarted = performance.now();
	const shell = shellLiteral(query);
	return { calls, requestBytes, resultBytes, scannedBytes, toolElapsedMs, shellElapsedMs: performance.now() - shellStarted, matches, sourceStarts: sourceStarts(query), shell };
}

const started = performance.now();
const queries = ["needle", "Needle", "☾n", "missing"];
const searches = {};
for (const query of queries) searches[query] = await search(query);
const paging = await page();
const elapsedMs = performance.now() - started;
for (const [query, result] of Object.entries(searches)) {
	const starts = result.matches.map((match) => match.byteOffset);
	if (JSON.stringify(starts) !== JSON.stringify(result.sourceStarts)) throw new Error(`source mismatch for ${query}`);
	if (result.shell.status === 0 && JSON.stringify(starts) !== JSON.stringify(result.shell.starts)) throw new Error(`shell source mismatch for ${query}`);
	if (result.shell.status === 1 && (starts.length !== 0 || result.shell.starts.length !== 0)) throw new Error(`shell miss mismatch for ${query}`);
	for (const match of result.matches) {
		if (Buffer.from(body).subarray(match.contextStart, match.contextEnd).toString("utf8") !== match.context) throw new Error(`context mismatch for ${query}`);
	}
}
const schema = recall.parameters;
const baselineDescription = "Read a stored large tool result by observation id and byte offset.";
const baselinePrompt = "Recall a paged excerpt from a previously replaced large tool result";
const baselineSchema = { type: "object", required: ["id"], properties: { id: { type: "string", description: "Observation id from a placeholder" }, offset: { type: "integer", minimum: 0, description: "Byte offset, default 0" } } };
const baselinePlaceholderBytes = Buffer.byteLength(placeholderFor(observation).replace("; add query for literal search; continue with next_offset", "; continue with returned next_offset"));
const oldBytes = { schema: Buffer.byteLength(JSON.stringify(baselineSchema)), description: Buffer.byteLength(baselineDescription), promptSnippet: Buffer.byteLength(baselinePrompt), placeholder: baselinePlaceholderBytes };
const newBytes = { schema: Buffer.byteLength(JSON.stringify(schema)), description: Buffer.byteLength(recall.description), promptSnippet: Buffer.byteLength(recall.promptSnippet), placeholder: Buffer.byteLength(placeholderFor(observation)) };
const report = {
	method: "real registered obs_recall against a synthetic session archive; Buffer literal scan is the source-position oracle; rg -F or grep -F is an ordinary-shell literal baseline when available",
	limits: "No model calls. Timings are one-run descriptive wall times, not general performance evidence. Search scannedBytes is prefix plus search scan bytes and excludes context excerpt reads. The synthetic archive path is known internally; discovery is excluded. Shell argv bytes use NUL separators and are command serialization only, not Pi Bash schema or billing. Shell wall time includes process startup and file I/O; shell archive bytes scanned, Pi transport, model billing, and tokenizer counts are unavailable (null), not zero.",
	baseline: { schema: baselineSchema, description: baselineDescription, promptSnippet: baselinePrompt, placeholderBytes: baselinePlaceholderBytes },
	newTool: { schema, description: recall.description, promptSnippet: recall.promptSnippet, placeholderBytes: Buffer.byteLength(placeholderFor(observation)) },
	byteTotals: { baseline: oldBytes, new: newBytes, delta: Object.fromEntries(Object.keys(oldBytes).map((key) => [key, newBytes[key] - oldBytes[key]])) },
	bodyBytes: Buffer.byteLength(body), elapsedMs, paging, searches,
};
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ outputPath, elapsedMs, queries }));
} finally {
	await rm(root, { recursive: true, force: true });
}
