/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BashOperations, ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	type ActionFusionOptions,
	assertUnchangedBeforeCommand,
	createActionFusionExtension,
} from "../src/sol-pi/extensions/action-fusion/index.ts";
import { withFusedFileQueue } from "../src/sol-pi/extensions/action-fusion/file-queue.ts";
import { componentText, plainTheme } from "./helpers.ts";

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
}

type ObjectSchema = { properties: Record<string, unknown>; required?: string[] };
type FusedTools = { edit: ToolDefinition; write: ToolDefinition };

function objectSchema(tool: ToolDefinition): ObjectSchema {
	return tool.parameters as unknown as ObjectSchema;
}

function loadFusedTools(options?: ActionFusionOptions): FusedTools {
	const registered = new Map<string, ToolDefinition>();
	const pi = {
		registerTool: (tool: ToolDefinition) => registered.set(tool.name, tool),
	} as unknown as ExtensionAPI;
	createActionFusionExtension(options)(pi);
	const edit = registered.get("edit");
	const write = registered.get("write");
	if (!edit || !write) throw new Error("action fusion did not register edit and write");
	return { edit, write };
}

function createContext(cwd: string, overrides: Partial<ExtensionContext> = {}): ExtensionContext {
	return {
		mode: "json",
		hasUI: false,
		cwd,
		model: undefined,
		sessionManager: {
			getSessionFile: () => undefined,
			getSessionId: () => "action-fusion-test",
		},
		ui: {},
		...overrides,
	} as unknown as ExtensionContext;
}

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-then-run-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("action fusion then_run", () => {
	it("adds an optional command and timeout object to edit and write", () => {
		const { edit, write } = loadFusedTools();

		expect(objectSchema(write).properties.then_run).toMatchObject({
			type: "object",
			description:
				"Command to run next on this file after the write succeeds — e.g. run, build, start/restart, install, or check it; optional timeout in seconds. Skipped if the write fails; a non-zero exit is reported but keeps the write.",
			properties: {
				command: { type: "string" },
				timeout: { type: "number" },
			},
			required: ["command"],
		});
		expect(objectSchema(edit).properties.then_run).toMatchObject({
			type: "object",
			description:
				"Command to run next on this file after the edit succeeds — e.g. run, build, start/restart, install, or check it; optional timeout in seconds. Skipped if the edit fails; a non-zero exit is reported but keeps the edit.",
			properties: {
				command: { type: "string" },
				timeout: { type: "number" },
			},
			required: ["command"],
		});
		expect(objectSchema(write).required).not.toContain("then_run");
		expect(objectSchema(edit).required).not.toContain("then_run");
	});

	it("keeps the built-in path and content parameters", () => {
		const { edit, write } = loadFusedTools();

		expect(Object.keys(objectSchema(write).properties)).toEqual(["path", "content", "then_run"]);
		expect(Object.keys(objectSchema(edit).properties)).toEqual(["path", "edits", "then_run"]);
		expect(write.name).toBe("write");
		expect(edit.name).toBe("edit");
	});

	it("renders a fused mutation as an English lightning savings call", () => {
		const { write } = loadFusedTools();
		const fusedArgs = {
			path: "target.ts",
			content: "export {};\n",
			then_run: { command: "npm test" },
		};
		const fused = write.renderCall!(fusedArgs, plainTheme, {
			cwd: process.cwd(),
			args: fusedArgs,
		} as never);
		const plainArgs = { path: "target.ts", content: "export {};\n" };
		const plain = write.renderCall!(plainArgs, plainTheme, {
			cwd: process.cwd(),
			args: plainArgs,
		} as never);

		expect(componentText(fused)).toContain("⚡ SoL-Pi · Action Fusion");
		expect(componentText(fused)).toContain("Money saved · 1 model round-trip avoided");
		expect(componentText(plain)).not.toContain("SoL-Pi");
	});

	it("runs write then_run through bash after the written content is visible", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "written.txt");
		const commands: string[] = [];
		const operations: BashOperations = {
			exec: async (command, cwd, { onData }) => {
				commands.push(command);
				expect(cwd).toBe(dir);
				expect(await readFile(filePath, "utf8")).toBe("new content\n");
				onData(Buffer.from("write check passed\n"));
				return { exitCode: 0 };
			},
		};
		const { write } = loadFusedTools({ bashOptions: { operations } });

		const result = await write.execute(
			"write-1",
			{ path: filePath, content: "new content\n", then_run: { command: "check write" } },
			undefined,
			undefined,
			createContext(dir),
		);

		expect(commands).toEqual(["check write"]);
		expect(text(result)).toContain("[then_run:succeeded]");
		expect(text(result)).toContain("write check passed");
	});

	it("announces savings only after a fused command succeeds in TUI mode", async () => {
		const dir = await createTempDir();
		const notify = vi.fn();
		const setStatus = vi.fn();
		const { write } = loadFusedTools({
			bashOptions: { operations: { exec: async () => ({ exitCode: 0 }) } },
		});

		await write.execute(
			"write-tui",
			{ path: "target.ts", content: "export {};\n", then_run: { command: "npm test" } },
			undefined,
			undefined,
			createContext(dir, { mode: "tui", hasUI: true, ui: { notify, setStatus } as never }),
		);

		expect(notify).toHaveBeenCalledWith(
			"⚡ SoL-Pi · Action Fusion\nMoney saved · 1 model round-trip avoided",
			"info",
		);
	});

	it("runs edit then_run after the edited content is visible", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "edited.txt");
		await writeFile(filePath, "before\n", "utf8");
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				expect(await readFile(filePath, "utf8")).toBe("after\n");
				onData(Buffer.from("edit check passed\n"));
				return { exitCode: 0 };
			},
		};
		const { edit } = loadFusedTools({ bashOptions: { operations } });

		const result = await edit.execute(
			"edit-1",
			{ path: filePath, edits: [{ oldText: "before", newText: "after" }], then_run: { command: "check edit" } },
			undefined,
			undefined,
			createContext(dir),
		);

		expect(text(result)).toContain("[then_run:succeeded]");
		expect(text(result)).toContain("edit check passed");
	});

	it("leaves a mutation without then_run untouched", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "plain.txt");
		let bashCalls = 0;
		const operations: BashOperations = {
			exec: async () => {
				bashCalls++;
				return { exitCode: 0 };
			},
		};
		const { write } = loadFusedTools({ bashOptions: { operations } });

		const result = await write.execute(
			"write-plain",
			{ path: filePath, content: "plain\n" },
			undefined,
			undefined,
			createContext(dir),
		);

		expect(bashCalls).toBe(0);
		expect(text(result)).not.toContain("[then_run:");
		expect(await readFile(filePath, "utf8")).toBe("plain\n");
	});

	it("preserves a successful mutation when then_run fails", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "preserved.txt");
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.from("validation failed\n"));
				return { exitCode: 7 };
			},
		};
		const { write } = loadFusedTools({ bashOptions: { operations } });

		await expect(
			write.execute(
				"write-2",
				{ path: filePath, content: "keep me\n", then_run: { command: "exit 7" } },
				undefined,
				undefined,
				createContext(dir),
			),
		).rejects.toThrow("[then_run:failed]");
		expect(await readFile(filePath, "utf8")).toBe("keep me\n");
	});

	it("skips then_run and reports it when the mutation fails", async () => {
		const dir = await createTempDir();
		let bashCalls = 0;
		const operations: BashOperations = {
			exec: async () => {
				bashCalls++;
				return { exitCode: 0 };
			},
		};
		const { edit } = loadFusedTools({ bashOptions: { operations } });

		await expect(
			edit.execute(
				"edit-2",
				{
					path: "missing.txt",
					edits: [{ oldText: "before", newText: "after" }],
					then_run: { command: "must not run" },
				},
				undefined,
				undefined,
				createContext(dir),
			),
		).rejects.toThrow("[then_run:skipped]");
		expect(bashCalls).toBe(0);
	});

	it("keeps the file queue locked through then_run", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "ordered.txt");
		const thenRunStarted = deferred();
		const finishThenRun = deferred();
		const events: string[] = [];
		const operations: BashOperations = {
			exec: async () => {
				events.push("then_run:start");
				thenRunStarted.resolve();
				await finishThenRun.promise;
				events.push("then_run:end");
				return { exitCode: 0 };
			},
		};
		const { write } = loadFusedTools({
			bashOptions: { operations },
			writeOptions: {
				operations: {
					mkdir: async () => {},
					writeFile: async (path, content) => {
						events.push(`write:${content}`);
						await writeFile(path, content);
					},
				},
			},
		});
		const ctx = createContext(dir);

		const first = write.execute(
			"write-3",
			{ path: filePath, content: "first", then_run: { command: "block" } },
			undefined,
			undefined,
			ctx,
		);
		await thenRunStarted.promise;
		const second = write.execute("write-4", { path: filePath, content: "second" }, undefined, undefined, ctx);
		await delay(20);
		expect(events).toEqual(["write:first", "then_run:start"]);

		finishThenRun.resolve();
		await Promise.all([first, second]);
		expect(events).toEqual(["write:first", "then_run:start", "then_run:end", "write:second"]);
	});

	it("passes then_run timeout through to the bash operation", async () => {
		const dir = await createTempDir();
		const operations: BashOperations = {
			exec: async (command, _cwd, { timeout }) => {
				expect(command).toBe("check with timeout");
				expect(timeout).toBe(12);
				return { exitCode: 0 };
			},
		};
		const { write } = loadFusedTools({ bashOptions: { operations } });

		const result = await write.execute(
			"write-timeout",
			{ path: "timeout.txt", content: "content\n", then_run: { command: "check with timeout", timeout: 12 } },
			undefined,
			undefined,
			createContext(dir),
		);

		expect(text(result)).toContain("[then_run:succeeded]");
	});

	it("passes the command unchanged to Pi's default bash behavior", async () => {
		const dir = await createTempDir();
		const commands: string[] = [];
		const operations: BashOperations = {
			exec: async (command) => {
				commands.push(command);
				return { exitCode: 0 };
			},
		};
		const { write } = loadFusedTools({ bashOptions: { operations } });

		await write.execute(
			"write-default-shell",
			{ path: "default-shell.txt", content: "content\n", then_run: { command: "check default shell" } },
			undefined,
			undefined,
			createContext(dir),
		);

		expect(commands).toEqual(["check default shell"]);
	});

	it("serializes direct uses of the extension queue", async () => {
		const events: string[] = [];
		const firstStarted = deferred();
		const releaseFirst = deferred();
		const queuePath = join(tmpdir(), "action-fusion-queue");
		const first = withFusedFileQueue(queuePath, async () => {
			events.push("first:start");
			firstStarted.resolve();
			await releaseFirst.promise;
			events.push("first:end");
		});
		await firstStarted.promise;
		const second = withFusedFileQueue(queuePath, async () => {
			events.push("second");
		});
		await delay(20);
		expect(events).toEqual(["first:start"]);
		releaseFirst.resolve();
		await Promise.all([first, second]);
		expect(events).toEqual(["first:start", "first:end", "second"]);
	});

	it("skips the command when the target changes after mutation", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "changed-before-command.txt");
		await writeFile(filePath, "mutation result\n");

		await expect(
			assertUnchangedBeforeCommand(filePath, async () => {
				await writeFile(filePath, "external change\n");
			}),
		).rejects.toThrow("[then_run:skipped] target content changed after the fused mutation");
	});
});
