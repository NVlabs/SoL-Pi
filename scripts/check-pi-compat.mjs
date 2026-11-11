/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

/*
 * Check that a Pi installation provides the public APIs SoL-Pi uses at runtime.
 *
 * Usage:
 *   node scripts/check-pi-compat.mjs [--pi-root <dir>] [--strict]
 *
 *   --pi-root <dir>  Check the Pi found at <dir> instead of this repo's devDependency. <dir> may be
 *                    the @earendil-works/pi-coding-agent package directory, a project that depends on
 *                    it, or a global node_modules root (`npm root -g`). Sibling Pi packages are resolved
 *                    from pi-coding-agent itself, the same way Pi's extension loader resolves them.
 *   --strict         Treat warnings (untested Pi version, unexpected bash behaviour) as failures.
 *                    Use it to confirm an installation matches the tested set below.
 *
 * Version policy:
 *   - Below PI_FLOOR: fail. SoL-Pi is not supported there.
 *   - In TESTED_PI_VERSIONS: pass.
 *   - Any other version >= PI_FLOOR: warn (exit 0) unless --strict. The API checks below still run,
 *     so a missing export or method fails regardless of the version.
 *
 * Checks:
 *   - Every named import from @earendil-works/* in src/ that survives TypeScript import elision
 *     exists on the resolved module. Each file is transpiled first because tsconfig does not use
 *     verbatimModuleSyntax: `import { ExtensionAPI }` used only as a type is dropped at runtime, as
 *     it is by Pi's extension loader. Without typescript installed every imported name is checked,
 *     with a warning. (`@earendil-works/pi-ai` is checked against its compat entrypoint, as Pi's
 *     loader aliases it.)
 *   - Pi's own @earendil-works/pi-* dependencies are installed at pi-coding-agent's version. Pi before
 *     1.3.0 does not pin them, so a fresh install of Pi 1.0.x or 1.1.0 now mixes in newer ones and fails to
 *     load. A mismatch is a warning.
 *   - Methods SoL-Pi calls on Pi objects (ModelRegistry, SessionManager, SettingsManager).
 *   - Reports how bash reports a non-zero exit (throws "Command exited with code N" on Pi <= 0.98,
 *     returns an isError result on Pi >= 0.99; SoL-Pi handles both) and whether the built-in
 *     codemode extension is available. Any other bash behaviour (for example a spawn failure) is a
 *     warning.
 *
 * Exit codes: 0 compatible, 1 incompatible (or a warning under --strict, or Pi cannot be loaded),
 * 2 usage error.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PI_FLOOR = "0.84.2";
const TESTED_PI_VERSIONS = ["0.84.2", "1.0.4", "1.3.0"];
const PI_CODING_AGENT = "@earendil-works/pi-coding-agent";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const warnings = [];

function usage(message) {
	if (message) console.error(`check-pi-compat: ${message}`);
	console.error("Usage: node scripts/check-pi-compat.mjs [--pi-root <dir>] [--strict]");
	process.exit(2);
}

function parseArgs(argv) {
	const options = { piRoot: undefined, strict: false };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--strict") options.strict = true;
		else if (arg === "--pi-root") {
			const value = argv[++index];
			if (!value) usage("--pi-root needs a directory");
			options.piRoot = value;
		} else if (arg.startsWith("--pi-root=")) options.piRoot = arg.slice("--pi-root=".length);
		else if (arg === "--help" || arg === "-h") usage();
		else usage(`unknown argument: ${arg}`);
	}
	return options;
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function isPackageDir(dir, name) {
	const manifest = join(dir, "package.json");
	return existsSync(manifest) && readJson(manifest).name === name;
}

/** Locate a package directory with Node's node_modules lookup, starting at `fromDir`. */
function findPackageDir(name, fromDir) {
	const lookup = createRequire(join(fromDir, "noop.js")).resolve.paths(name) ?? [];
	for (const base of [fromDir, ...lookup]) {
		const dir = join(base, name);
		if (isPackageDir(dir, name)) return dir;
	}
	return undefined;
}

/** Resolve an ESM `exports` subpath to a file URL (only the conditions Pi packages use). */
function exportUrl(packageDir, subpath) {
	const manifest = readJson(join(packageDir, "package.json"));
	let target = typeof manifest.exports === "object" ? manifest.exports[subpath] : undefined;
	if (target === undefined && subpath === ".") target = typeof manifest.exports === "string" ? manifest.exports : manifest.main;
	while (target && typeof target === "object") target = target.import ?? target.default ?? target.node;
	if (typeof target !== "string") throw new Error(`${manifest.name} does not export "${subpath}"`);
	return pathToFileURL(join(packageDir, target)).href;
}

function compareVersions(left, right) {
	const parse = (version) => version.split("-")[0].split(".").map((part) => Number.parseInt(part, 10) || 0);
	const a = parse(left);
	const b = parse(right);
	for (let index = 0; index < 3; index++) {
		if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
	}
	return 0;
}

function sourceFiles(dir) {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return sourceFiles(path);
		return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
	});
}

/** This checkout's typescript, or undefined when dependencies are not installed. */
function loadTypeScript() {
	try {
		return createRequire(join(repoRoot, "noop.js"))("typescript");
	} catch {
		return undefined;
	}
}

/** Named value imports from Pi packages in src/, keyed by module specifier. */
function piValueImports() {
	const ts = loadTypeScript();
	if (!ts) warnings.push("typescript is not installed; every imported Pi name is checked as a runtime value (run npm ci)");
	const imports = new Map();
	const pattern = /import\s+(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*["'](@earendil-works\/[^"']+)["']/g;
	for (const file of sourceFiles(join(repoRoot, "src"))) {
		let code = readFileSync(file, "utf8");
		// Keep only the imports that remain at runtime: names used solely as types are elided.
		if (ts) {
			const compilerOptions = { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 };
			code = ts.transpileModule(code, { fileName: file, compilerOptions }).outputText;
		}
		for (const match of code.matchAll(pattern)) {
			const names = imports.get(match[2]) ?? new Set();
			for (const raw of match[1].split(",")) {
				const name = raw.trim().split(/\s+as\s+/)[0].trim();
				if (name && !name.startsWith("type ")) names.add(name);
			}
			imports.set(match[2], names);
		}
	}
	return imports;
}

function splitSpecifier(specifier) {
	const [scope, name, ...rest] = specifier.split("/");
	const packageName = `${scope}/${name}`;
	// Pi's extension loader aliases the pi-ai root to its compat entrypoint (a superset of the root).
	if (packageName === "@earendil-works/pi-ai" && rest.length === 0) return { packageName, subpath: "./compat" };
	return { packageName, subpath: rest.length === 0 ? "." : `./${rest.join("/")}` };
}

async function probeBashNonZeroExit(createBashToolDefinition) {
	const cwd = mkdtempSync(join(tmpdir(), "sol-pi-compat-"));
	try {
		const bash = createBashToolDefinition(cwd);
		const result = await bash.execute(
			"sol-pi-compat-probe",
			{ command: "echo out; exit 3" },
			AbortSignal.timeout(15_000),
			undefined,
			undefined,
		);
		if (result?.isError !== true) {
			warnings.push("bash returned a non-error result for a non-zero exit; SoL-Pi expects a throw or isError");
			return "returns a non-error result (unexpected)";
		}
		const exitCode = result.structuredContent?.exit_code;
		return `returns isError result${exitCode === undefined ? "" : ` (structuredContent.exit_code=${exitCode})`} (Pi >= 0.99 behaviour)`;
	} catch (error) {
		const message = String(error?.message ?? error);
		// Pi <= 0.98 throws the command output followed by this status line.
		const exitLine = /^Command exited with code \d+$/m.exec(message)?.[0];
		if (exitLine) return `throws (Pi <= 0.98 behaviour): ${exitLine}`;
		const reason = message.trim().split("\n").at(-1)?.slice(0, 120) ?? "";
		warnings.push(`bash probe threw for a reason other than a non-zero exit: ${reason}`);
		return `throws an unexpected error: ${reason}`;
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

const options = parseArgs(process.argv.slice(2));
const searchRoot = resolve(options.piRoot ?? repoRoot);
if (!existsSync(searchRoot)) usage(`--pi-root does not exist: ${searchRoot}`);

const modules = new Map();
async function loadModule(piDir, specifier) {
	if (!modules.has(specifier)) {
		const { packageName, subpath } = splitSpecifier(specifier);
		const packageDir = packageName === PI_CODING_AGENT ? piDir : findPackageDir(packageName, piDir);
		if (!packageDir) throw new Error(`${packageName} not found from ${piDir}`);
		modules.set(specifier, await import(exportUrl(packageDir, subpath)));
	}
	return modules.get(specifier);
}

/**
 * Pi's own `@earendil-works/pi-*` dependencies whose installed version differs from pi-coding-agent's.
 * Releases before Pi 1.3.0 declare them with caret ranges, so a fresh install now pulls the newest
 * internals; Pi 1.0.x and 1.1.0 then fail to load. Pi 1.3.0 pins them exactly.
 */
function mixedInternalPackages(piDir, version) {
	const dependencies = readJson(join(piDir, "package.json")).dependencies ?? {};
	return Object.keys(dependencies)
		.filter((name) => name.startsWith("@earendil-works/pi-"))
		.flatMap((name) => {
			const dir = findPackageDir(name, piDir);
			const installed = dir ? readJson(join(dir, "package.json")).version : undefined;
			return installed && installed !== version ? [`${name.slice("@earendil-works/".length)} ${installed}`] : [];
		});
}

async function checkPi() {
	const piDir = isPackageDir(searchRoot, PI_CODING_AGENT) ? searchRoot : findPackageDir(PI_CODING_AGENT, searchRoot);
	if (!piDir) {
		errors.push(`${PI_CODING_AGENT} not found from ${searchRoot}`);
		return;
	}

	const version = readJson(join(piDir, "package.json")).version;
	console.log(`Pi: ${PI_CODING_AGENT}@${version} (${piDir})`);
	if (compareVersions(version, PI_FLOOR) < 0) {
		errors.push(`Pi ${version} is below the supported floor ${PI_FLOOR}`);
	} else if (!TESTED_PI_VERSIONS.includes(version)) {
		warnings.push(`Pi ${version} is not in the tested set (${TESTED_PI_VERSIONS.join(", ")}); API checks still apply`);
	}
	const mixed = mixedInternalPackages(piDir, version);
	if (mixed.length > 0) {
		warnings.push(
			`Pi ${version} is installed with internal packages from other releases (${mixed.join(", ")}). ` +
				`Pi releases before 1.3.0 do not pin them, so a fresh install mixes versions and Pi 1.0.x and 1.1.0 fail to load; ` +
				`install Pi 1.3.0, or pin each of these packages to ${version}`,
		);
	}

	for (const [specifier, names] of piValueImports()) {
		let module;
		try {
			module = await loadModule(piDir, specifier);
		} catch (error) {
			errors.push(`Cannot load ${specifier}: ${error.message}`);
			continue;
		}
		for (const name of names) {
			if (module[name] === undefined) errors.push(`Missing public Pi API: ${specifier} ${name}`);
		}
	}

	let pi;
	try {
		pi = await loadModule(piDir, PI_CODING_AGENT);
	} catch (error) {
		const message = `Cannot load ${PI_CODING_AGENT}: ${error.message}`;
		if (!errors.includes(message)) errors.push(message);
		return;
	}
	const exportedVersion = pi.VERSION;
	if (typeof exportedVersion === "string" && exportedVersion !== version) {
		warnings.push(`VERSION export (${exportedVersion}) differs from package.json (${version})`);
	}
	for (const [name, value] of Object.entries({
		createBashToolDefinition: pi.createBashToolDefinition,
		createEditToolDefinition: pi.createEditToolDefinition,
		createWriteToolDefinition: pi.createWriteToolDefinition,
		getAgentDir: pi.getAgentDir,
		modelRegistryFind: pi.ModelRegistry?.prototype.find,
		modelRegistryGetApiKeyAndHeaders: pi.ModelRegistry?.prototype.getApiKeyAndHeaders,
		sessionManagerGetBranch: pi.SessionManager?.prototype.getBranch,
		sessionManagerGetEntries: pi.SessionManager?.prototype.getEntries,
		sessionManagerGetLeafId: pi.SessionManager?.prototype.getLeafId,
		sessionManagerGetSessionDir: pi.SessionManager?.prototype.getSessionDir,
		sessionManagerGetSessionId: pi.SessionManager?.prototype.getSessionId,
		settingsManagerCreate: pi.SettingsManager?.create,
		settingsManagerDrainErrors: pi.SettingsManager?.prototype.drainErrors,
		settingsManagerGetShellCommandPrefix: pi.SettingsManager?.prototype.getShellCommandPrefix,
		settingsManagerGetShellPath: pi.SettingsManager?.prototype.getShellPath,
	})) {
		if (typeof value !== "function") errors.push(`Missing public Pi API: ${name}`);
	}
	if (typeof pi.CONFIG_DIR_NAME !== "string" || pi.CONFIG_DIR_NAME.length === 0) {
		errors.push("Missing public Pi API: CONFIG_DIR_NAME");
	}

	if (typeof pi.createBashToolDefinition === "function") {
		console.log(`bash non-zero exit: ${await probeBashNonZeroExit(pi.createBashToolDefinition)}`);
		const outputSchema = pi.createBashToolDefinition(repoRoot).outputSchema !== undefined;
		console.log(`bash outputSchema: ${outputSchema ? "yes (codemode scripts receive structuredContent)" : "no"}`);
	}
	console.log(
		`codemode: ${typeof pi.createCodemodeExtension === "function" ? "available (createCodemodeExtension)" : "not available"}`,
	);
	console.log(
		`ModelRegistry.complete: ${typeof pi.ModelRegistry?.prototype.complete === "function" ? "yes" : "no (pi-ai compat complete is used)"}`,
	);
}

// A broken install (unreadable manifest, a probe that throws) is reported like any other failure.
try {
	await checkPi();
} catch (error) {
	errors.push(`Pi check failed: ${error?.message ?? error}`);
}

for (const warning of warnings) console.warn(`WARN: ${warning}`);
for (const error of errors) console.error(`ERROR: ${error}`);
const failed = errors.length > 0 || (options.strict && warnings.length > 0);
console.log(failed ? "Pi compatibility: FAIL" : `Pi compatibility: OK${warnings.length > 0 ? " (with warnings)" : ""}`);
process.exitCode = failed ? 1 : 0;
