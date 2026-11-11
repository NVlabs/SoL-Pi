/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type BashOperations,
	createBashToolDefinition,
	type ExtensionAPI,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	type ActionFusionOptions,
	assertUnchangedBeforeCommand,
	createActionFusionExtension,
	executeMutationThenRun,
} from "../src/sol-pi/extensions/action-fusion/index.ts";
import { withFusedFileQueue } from "../src/sol-pi/extensions/action-fusion/file-queue.ts";
import { runFusedMutation } from "../src/sol-pi/extensions/action-fusion/then-run.ts";
import { componentText, fakeToolContext, plainTheme, type ToolExecuteContext } from "./helpers.ts";

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

function createContext(cwd: string, overrides: Record<string, unknown> = {}): ToolExecuteContext {
	return fakeToolContext(cwd, { cwd, ...overrides });
}

function tuiContext(cwd: string) {
	const notify = vi.fn();
	const setStatus = vi.fn();
	return { ctx: createContext(cwd, { mode: "tui", hasUI: true, ui: { notify, setStatus } }), notify, setStatus };
}

/**
 * Pi 0.99 changed bash to return a non-zero exit as an `isError` result; 0.84
 * throws. Detected from the installed bash, not from a version string.
 */
async function bashReturnsNonZeroExit(): Promise<boolean> {
	const bash = createBashToolDefinition(tmpdir(), { operations: { exec: async () => ({ exitCode: 7 }) } });
	try {
		await bash.execute("probe", { command: "exit 7" }, undefined, undefined, createContext(tmpdir()));
		return true;
	} catch {
		return false;
	}
}

const nonZeroExitIsResult = await bashReturnsNonZeroExit();

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

	it.each([
		{ label: "default checkout name", cwd: join(tmpdir(), "SoL-Pi"), path: "target.ts" },
		{ label: "unrelated checkout name", cwd: join(tmpdir(), "plain-checkout"), path: "target.ts" },
		{ label: "repository name in the target path", cwd: join(tmpdir(), "plain-checkout"), path: "SoL-Pi/target.ts" },
	])("renders a fused mutation as an English lightning savings call ($label)", ({ cwd, path }) => {
		const { write } = loadFusedTools();
		const fusedArgs = {
			path,
			content: "export {};\n",
			then_run: { command: "npm test" },
		};
		const fused = write.renderCall!(fusedArgs, plainTheme, {
			cwd,
			args: fusedArgs,
		} as never);
		const plainArgs = { path, content: "export {};\n" };
		const plain = write.renderCall!(plainArgs, plainTheme, {
			cwd,
			args: plainArgs,
		} as never);

		expect(componentText(fused)).toContain("⚡ SoL-Pi · Action Fusion");
		expect(componentText(fused)).toContain("Money saved · 1 model round-trip avoided");
		// A normal path or its OSC 8 hyperlink may contain the repository name.
		expect(componentText(plain)).not.toContain("⚡ SoL-Pi · Action Fusion");
		expect(componentText(plain)).not.toContain("Money saved · 1 model round-trip avoided");
	});

	it("drops the savings banner once a fused call settles as an error", () => {
		const { edit, write } = loadFusedTools();
		const cases = [
			{
				tool: write,
				args: { path: "target.ts", content: "export {};\n", then_run: { command: "npm test" } },
			},
			{
				tool: edit,
				args: { path: "target.ts", edits: [{ oldText: "a", newText: "b" }], then_run: { command: "npm test" } },
			},
		];
		for (const { tool, args } of cases) {
			const render = (isError: boolean) => {
				const context = {
					args,
					toolCallId: "call-1",
					invalidate: () => {},
					lastComponent: undefined,
					state: {},
					cwd: process.cwd(),
					executionStarted: true,
					argsComplete: false,
					isPartial: false,
					expanded: false,
					showImages: false,
					isError,
				};
				const result = {
					content: [{ type: "text" as const, text: isError ? "[then_run:failed]\nboom" : "[then_run:succeeded]\nok" }],
					details: undefined,
				};
				const call = componentText(tool.renderCall!(args, plainTheme, context as never));
				const rendered = componentText(
					tool.renderResult!(result, { expanded: false, isPartial: false }, plainTheme, context as never),
				);
				return { call, rendered };
			};

			const succeeded = render(false);
			expect(succeeded.call).toContain("Money saved · 1 model round-trip avoided");
			expect(succeeded.rendered).toContain("Money saved · 1 model round-trip avoided");
			const failed = render(true);
			expect(failed.call).not.toContain("SoL-Pi");
			expect(failed.rendered).not.toContain("SoL-Pi");
		}
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
			createContext(dir, { mode: "tui", hasUI: true, ui: { notify, setStatus } }),
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
		const run = write.execute(
			"write-2",
			{ path: filePath, content: "keep me\n", then_run: { command: "exit 7" } },
			undefined,
			undefined,
			createContext(dir),
		);

		if (nonZeroExitIsResult) {
			// Pi 0.99+: bash returns the exit as an error result.
			const result = await run;
			expect((result as { isError?: boolean }).isError).toBe(true);
			expect(text(result)).toContain("Successfully wrote");
			expect(text(result)).toContain("[then_run:failed]\nvalidation failed");
			expect(text(result)).toContain("Command exited with code 7");
			expect(text(result)).not.toContain("[then_run:succeeded]");
		} else {
			// Pi 0.84: bash throws on a non-zero exit.
			await expect(run).rejects.toThrow(/Successfully wrote[\s\S]*\[then_run:failed\][\s\S]*validation failed/u);
		}
		expect(await readFile(filePath, "utf8")).toBe("keep me\n");
	});

	it("reports a real non-zero exit as a failure without a savings notice, even if the output looks successful", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "real-exit.txt");
		const { ctx, notify, setStatus } = tuiContext(dir);
		const { write } = loadFusedTools();
		const run = write.execute(
			"write-real-exit",
			{
				path: filePath,
				content: "kept\n",
				then_run: { command: "echo 'checking [then_run:succeeded]'; echo boom >&2; exit 7" },
			},
			undefined,
			undefined,
			ctx,
		);

		let observed: string;
		if (nonZeroExitIsResult) {
			const result = await run;
			expect((result as { isError?: boolean }).isError).toBe(true);
			expect((result as { structuredContent?: unknown }).structuredContent).toBeUndefined();
			observed = text(result);
		} else {
			observed = await run.then(
				() => {
					throw new Error("expected then_run to fail");
				},
				(error: Error) => error.message,
			);
		}
		expect(observed).toContain("[then_run:failed]");
		expect(observed).toContain("boom");
		expect(observed).toContain("Command exited with code 7");
		expect(await readFile(filePath, "utf8")).toBe("kept\n");
		expect(notify).not.toHaveBeenCalled();
		expect(setStatus).not.toHaveBeenCalled();
	});

	it.skipIf(!nonZeroExitIsResult)("keeps the edit diff details when then_run exits non-zero", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "diff.txt");
		await writeFile(filePath, "before\n", "utf8");
		const { edit } = loadFusedTools({ bashOptions: { operations: { exec: async () => ({ exitCode: 3 }) } } });

		const result = await edit.execute(
			"edit-fail",
			{ path: filePath, edits: [{ oldText: "before", newText: "after" }], then_run: { command: "check" } },
			undefined,
			undefined,
			createContext(dir),
		);

		expect((result as { isError?: boolean }).isError).toBe(true);
		expect((result.details as { diff?: string } | undefined)?.diff).toContain("after");
		expect(text(result)).toContain("[then_run:failed]");
		expect(await readFile(filePath, "utf8")).toBe("after\n");
	});

	it("announces savings after a real successful command but not for calls nested in a script", async () => {
		const dir = await createTempDir();
		const { write } = loadFusedTools();
		const direct = tuiContext(dir);
		const nested = tuiContext(dir);

		const directResult = await write.execute(
			"call-1",
			{ path: "direct.txt", content: "x\n", then_run: { command: "echo ok" } },
			undefined,
			undefined,
			direct.ctx,
		);
		const nestedResult = await write.execute(
			"call-2/1",
			{ path: "nested.txt", content: "x\n", then_run: { command: "echo ok" } },
			undefined,
			undefined,
			nested.ctx,
		);

		expect(text(directResult)).toContain("[then_run:succeeded]\nok");
		expect(text(nestedResult)).toContain("[then_run:succeeded]\nok");
		expect(direct.notify).toHaveBeenCalledWith(
			"⚡ SoL-Pi · Action Fusion\nMoney saved · 1 model round-trip avoided",
			"info",
		);
		expect(nested.notify).not.toHaveBeenCalled();
		expect(nested.setStatus).not.toHaveBeenCalled();
	});

	it("does not announce savings for a mutation without then_run", async () => {
		const dir = await createTempDir();
		const { ctx, notify } = tuiContext(dir);
		const { write } = loadFusedTools();

		await write.execute("write-no-then-run", { path: "plain.txt", content: "x\n" }, undefined, undefined, ctx);

		expect(notify).not.toHaveBeenCalled();
	});

	it("skips the command when the mutation returns an error result", async () => {
		const dir = await createTempDir();
		let bashCalls = 0;
		const options = {
			toolCallId: "mutation-error",
			absolutePath: join(dir, "never.txt"),
			thenRun: { command: "must not run" },
			mutate: async () => ({
				content: [{ type: "text" as const, text: "mutation refused" }],
				details: undefined,
				isError: true,
			}),
			bashOptions: {
				operations: {
					exec: async () => {
						bashCalls++;
						return { exitCode: 0 };
					},
				},
			},
			signal: undefined,
			ctx: createContext(dir),
		};

		const { result, status } = await runFusedMutation(options);
		const plain = await executeMutationThenRun(options);

		expect(status).toBe("skipped");
		expect((result as { isError?: boolean }).isError).toBe(true);
		expect(text(result)).toContain("mutation refused");
		expect(text(result)).toContain("[then_run:skipped]");
		expect(text(plain)).toContain("[then_run:skipped]");
		expect(bashCalls).toBe(0);
	});

	it("reports the then_run status explicitly", async () => {
		const dir = await createTempDir();
		await writeFile(join(dir, "status.txt"), "mutated\n", "utf8");
		const base = {
			absolutePath: join(dir, "status.txt"),
			mutate: async () => ({ content: [{ type: "text" as const, text: "mutated" }], details: undefined }),
			signal: undefined,
			ctx: createContext(dir),
		};
		const succeeded = await runFusedMutation({
			...base,
			toolCallId: "status-ok",
			thenRun: { command: "ok" },
			bashOptions: { operations: { exec: async () => ({ exitCode: 0 }) } },
		});
		const none = await runFusedMutation({
			...base,
			toolCallId: "status-none",
			thenRun: undefined,
			bashOptions: undefined,
		});
		const failing = runFusedMutation({
			...base,
			toolCallId: "status-failed",
			thenRun: { command: "fail" },
			bashOptions: { operations: { exec: async () => ({ exitCode: 1 }) } },
		});

		expect(succeeded.status).toBe("succeeded");
		expect((succeeded.result as { isError?: boolean }).isError).toBeUndefined();
		expect(none.status).toBe("none");
		expect(text(none.result)).toBe("mutated");
		if (nonZeroExitIsResult) {
			expect((await failing).status).toBe("failed");
		} else {
			await expect(failing).rejects.toThrow("[then_run:failed]");
		}
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
