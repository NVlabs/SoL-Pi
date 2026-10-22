# Pi Compatibility

SoL-Pi requires `@earendil-works/pi-coding-agent` 0.84.2 or newer. It is tested against Pi 0.84.2, the supported floor, Pi 1.0.4, and Pi 1.3.0, the development dependency. Other versions are untested; Pi changed behavior SoL-Pi depends on in 0.87 and 0.99. `scripts/check-pi-compat.mjs` warns on an untested version and fails on it under `--strict`. Each tested version is checked by installing its four Pi packages over the development dependency (for 1.0.4 also `@earendil-works/pi-codemode`, `pi-mcp` and `chord` at 1.0.4) and running type checking, the complete test suite, and `scripts/check-pi-compat.mjs --strict`. The four Pi packages `@earendil-works/pi-agent-core`, `pi-ai`, `pi-coding-agent`, and `pi-tui` must have the same version. The runtime range is deliberately expressed as an open-ended peer dependency because Pi owns installation and upgrade of its packages; the declared floor is 0.84.2.

Install Pi 1.3.0 rather than an earlier 1.x release. Before 1.3.0, Pi depends on its internal `@earendil-works/pi-*` packages with caret ranges, so a fresh install now pairs Pi 1.0.x or 1.1.0 with the 1.3.0 internals and Pi fails to load (`pi-codemode` 1.3.0 no longer exports `MCP_TYPESCRIPT_PREAMBLE`). Pi 1.3.0 pins them exactly. `scripts/check-pi-compat.mjs` warns when Pi's internal packages come from another release.

SoL-Pi works with Pi codemode in both `codemode.mode: "on"` and `"only"` on Pi 1.x; see [Codemode](#codemode). Pi 0.84.2 has no codemode.

## Checking an installed Pi

From a SoL-Pi source checkout, install the checkout's dependencies and check the Pi that will load the extension:

```bash
npm ci --ignore-scripts
node scripts/check-pi-compat.mjs --pi-root "$(npm root -g)/@earendil-works/pi-coding-agent"
```

`--pi-root` accepts the `pi-coding-agent` package directory, a project that depends on it, or a global `node_modules` root. Without it, the script checks the checkout's development dependency; `npm run check:pi` runs that form. The script reports the Pi version, how its bash tool reports a non-zero exit, whether bash declares an output schema, and whether codemode is available. It fails when the version is below 0.84.2 or when a Pi export or method that SoL-Pi uses is missing. A version of at least 0.84.2 that is not in the tested set prints a warning and still passes; `--strict` turns warnings into failures. The script is not part of the npm package, so run it from a checkout. It uses the checkout's TypeScript to skip type-only imports; without `npm ci` it checks every imported name as a runtime value and prints a warning, so `--strict` fails even on a tested Pi.

## Public API surface

SoL-Pi imports only public package exports:

- `createEditToolDefinition`
- `createWriteToolDefinition`
- `createBashToolDefinition`
- `SettingsManager.create()`, `getShellPath()`, `getShellCommandPrefix()`, and `drainErrors()`
- extension types and `ExtensionAPI.registerTool`
- `session_start`, `session_shutdown`, `input`, `context`, `before_provider_request`, `message_end`, `tool_result`, `turn_end`, `agent_settled`, `session_before_compact`, `session_compact`, `session_before_tree`, and `session_tree` extension events
- `ExtensionContext.getContextUsage()` and `ExtensionContext.compact()`
- `ExtensionContext.model` and `ExtensionContext.modelRegistry`
- the public session-manager methods exposed through `ExtensionContext`

Three Pi 1.x additions are used only when present:

- `ExtensionAPI.getSettings()`, which Online Context Compact feature-detects to read Pi's effective compaction settings;
- the public `buildSessionProjection()` helper, which Online Context Compact uses to account for context edits before estimating Pi's cut point;
- the tool `exposure` field, which Online Context Compact sets on `update_plan`. Pi 0.84.2 ignores it.

Only Online Context Compact handles `before_provider_request`, to count requests; it never changes the payload.

## Action Fusion

SoL-Pi caches one built-in edit/write definition per `ctx.cwd`. Pi 0.84.2's definitions resolve paths against the directory they were created with; Pi 1.x resolves them against `ctx.cwd` at execution, so both agree. Its own per-file queue surrounds the built-in mutation and follow-up command. It does not nest Pi's built-in mutation queue.

Action Fusion decodes `file://` targets with Node's `fileURLToPath()` before resolving the queue and hash-check path. This keeps file URLs, including percent-encoded filenames and Pi's optional `@` prefix, aligned with the file handled by the built-in mutation tool.

On Windows it applies the same drive-path conversion Pi's own resolver applies, so Git Bash, MSYS, Cygwin, and WSL targets such as `/c/src/app.ts` and home-relative `~\` paths resolve to the file the built-in mutation tool wrote. On other platforms those inputs keep their POSIX meaning.

The queue covers only fused operations registered by this SoL-Pi instance. External processes, direct built-in-tool calls outside the replacement, and unrelated extensions are not globally locked. SoL-Pi hashes the target immediately before launching `then_run` and skips the command if it observes an intervening content change.

`then_run` runs through Pi's public `createBashToolDefinition(ctx.cwd, options)`. At extension startup, Action Fusion reads Pi's file-backed `shellPath` and `shellCommandPrefix` through the public `SettingsManager`, respecting project trust, and passes them to that Bash tool; malformed settings stop initialization rather than silently selecting another shell. On native Windows this selects a custom Git Bash installation instead of a legacy WSL `bash.exe`. SDK/CLI in-memory shell overrides are not visible through this file-backed bridge; embedded callers can pass explicit `bashOptions`. A bash override registered by another extension does not apply to `then_run`.

A non-zero `then_run` exit is a tool failure on every supported Pi version. The file mutation is never rolled back.

- **Pi 0.84.2** — bash throws on a non-zero exit, so the fused call fails with an error containing the mutation output, `[then_run:failed]`, the command output, and `Command exited with code N`.
- **Pi 1.x** — bash returns a non-zero exit as an error result, so the fused call returns an error result (`isError: true`). It keeps the mutation's text and details, including the edit diff, and adds a `[then_run:failed]` block followed by the command output.
- **Every version** — a timeout or an abort fails the call with an error that keeps the mutation output.
- **A command killed by a signal** — Pi 0.84.2's bash gets no exit code for it and reports the command as successful, so the fused call reports `[then_run:succeeded]` with the output so far. Pi 0.86 and later report it as a failure; on Pi 1.x the shell reports exit code 128 plus the signal number, so the fused call fails like any other non-zero exit.

If the mutation fails, the command is not run and the call fails with `[then_run:skipped]`.

## ObservationPack

ObservationPack changes only the messages projected through the public `context` event. Pi passes `context` handlers a cloned copy of the conversation, so stored session history remains intact. ObservationPack replaces the content of those message objects in place and returns nothing. Since Pi 0.87, a handler that returns different message objects makes Pi merge every mid-conversation system message, such as prompt sections and tool-declaration deltas, into one leading system message, which breaks the provider's cached prefix on every later request. The in-place edit keeps those messages where they are on Pi 1.x and behaves the same on Pi 0.84.2.

Original bytes and the JSONL ledger live under the session-derived SoL-Pi directory.

## Evidence-Preserving Reducer

The reducer handles public `tool_result` events and resolves the configured reducer provider/model through Pi's model registry before calling `ExtensionContext.modelRegistry.complete()`, which Pi 0.84.2 and 1.0.x provide. The reducer preserves the original result whenever the configured reducer model is unavailable or eligibility, model-call, schema, source-hash, exact-quote, size, or likely-secret checks fail.

Reducer archive reuse requires atomic no-follow file access and fails closed when the platform does not expose it. Tests cover this unavailable-capability behavior without depending on error wording; simulating an absent `O_NOFOLLOW` flag does not establish native Windows validation.

Candidates are bash results and edit/write results that carry `then_run`. Pi 1.x marks a call that another tool made through `ctx.executeTool()`, such as a codemode script call, with `parentToolCallId`. The reducer ignores such results without archiving, journaling, or calling a model: they never enter the transcript, so reducing them would save no context, and they keep their `structuredContent`. The `codemode` tool's own result is never a candidate.

A receipt's status follows the result's `isError` flag. The reducer also reads the result's own exit signal from the inline text, not from Pi's full-output temporary file, which lacks the status line:

- `structuredContent.exit_code` on Pi 1.x bash results;
- otherwise a trailing `Command exited with code N` line;
- for fused results, the first `[then_run:failed]` or `[then_run:succeeded]` marker, with a trailing non-zero `Command exited with code N` line also counting as a failure.

When the signal disagrees with `isError`, the reducer leaves the original output unchanged and journals a fallback with reason `exit-state-mismatch`, so a failed command never receives a `status=success` receipt. Fused results carry no structured exit code, so a passing `then_run` command whose own last output line reads `Command exited with code N` (N other than 0) is left unreduced.

All persistent paths use `SessionManager.getSessionDir()` and `getSessionId()`, which every supported Pi version provides. If the session directory is empty (`--no-session` or `SessionManager.inMemory()`), SoL-Pi lazily creates a private `sol-pi-<session-id>-<random>/` directory under `os.tmpdir()`. Its path is reused by session ID across contexts and both archiving mechanisms while the extension is loaded. These files remain available after worker shutdown for callers that need to read evidence; cleanup is left to the host or caller. SoL-Pi creates no configurable storage-path surface.

The unpublished shared artifact layout is not read or migrated. Each persistent session starts from its own `<sessionDir>/sol-pi/<sessionId>/` directory; ephemeral sessions use the temporary fallback above.

## Online Context Compact

Online Context Compact uses ordinary public `context` handlers instead of fork-only post-transform observer methods, plus `session_before_compact` as described below. Public handlers run in extension load order, so the SoL-Pi entrypoint registers Online Context Compact after its other context transformers. A third-party transformer loaded later is outside the context-growth observation used by its estimate. Pi 1.x does not show system messages to `context` handlers, so mid-conversation system messages are outside that estimate until Pi reports provider-counted usage for the next request.

It counts a provider request only when it carries an agent-loop context: a `context` event marks the next `before_provider_request` as a request, and the assistant `message_end` that ends that request clears the mark. Each agent request therefore counts once, as in SoL-Pi 0.1.0, on every supported Pi version. It does not count:

- **Builds that never reach the provider.** After a boundary stop, Pi 0.84.2 and 1.0.x still build one more request for the aborted run; its `context` event arrives with an aborted signal and Pi rejects the request before calling the provider. The same holds for any build that fails before the provider is called.
- **Pi 1.x cache-warming replays.** They re-send the last request through `before_provider_request` without a `context` event.

Session start, tree navigation, compaction, and shutdown clear a pending mark. Pi's built-in providers emit `before_provider_request` by calling `onPayload`, and Pi's custom-provider guide requires custom providers to call it too. Requests to a provider that does not call it are never counted.

The native cut is estimated from Pi's canonical session projection when available (Pi 1.x), and from raw session entries on Pi 0.84.2. Removable-token savings are measured from corresponding messages in the latest observed extension projection. ObservationPack placeholders are therefore priced at their projected size, context edits are applied before choosing the cut, and retained system checkpoints are excluded from savings. Dropped messages, unseen additions, and ambiguous matches contribute no proven savings; the estimator never substitutes their raw byte counts or reruns context hooks. Pi's special recovery-omission suffix can allow a larger removable prefix than the public cut-point helper predicts; OCC conservatively underestimates savings in that case.

Compaction preserves the current plan, request-horizon samples, and context-growth history. Every plan update uses the same step-ID/status comparison, including the first update after compaction. A boundary requires a previously registered unfinished step to become completed. Newly introduced completed IDs establish history without creating a boundary, so re-keyed completed snapshots do not retrigger compaction. An assistant must register a step before completing it to make that completion eligible for OCC. Economic compaction has a two-provider-request cooldown; context-window protection can override it. A new user task following a fully completed plan resets the request-horizon samples while preserving unpaid cache debt.

On Pi builds whose `ExtensionAPI` has `getSettings()` (1.0.x), Online Context Compact reads Pi's effective `compaction.keepRecentTokens` and `compaction.reserveTokens`. A per-model `compaction.modelOverrides["<provider>/<id>"]` entry for the current `ctx.model` takes precedence, as in Pi. The reserve is used for window-pressure protection. On Pi 0.84.2 it uses the documented defaults of 20,000 retained-tail tokens and a 16,384-token reserve. An explicit `keepRecentTokens` passed to the programmatic factory overrides the retained tail on every version.

`ExtensionContext.compact()` aborts the active agent before it summarizes, and `agent_settled` fires only once a whole run has drained every turn, retry, auto-compaction, and queued continuation. A plan boundary that selects compaction therefore saves its plan and progress state, calls `ExtensionContext.abort()` to stop the run, and runs compaction from the `agent_settled` that stop produces. The handler awaits the compaction's own `onComplete`/`onError` callbacks. On success, the extension sends a hidden reminder through public `ExtensionAPI.sendMessage()` with `triggerTurn: true`, so Pi starts a new turn against the compacted context and continues the current plan. The reminder asks it to preserve existing step IDs when updating progress; an immediate plan update is not required.

The exact native refusals `Nothing to compact (session too small)` and `Already compacted`, and Pi's explicit incomplete-summary token-cap error, resume the interrupted task with the existing context. These skips are recorded as `sol-pi-online-context-compact-skipped` entries and shown as TUI warnings; they do not record a compaction or charge new cache debt. Plan-only turns cannot retry compaction until successful non-plan tool work or new user input occurs.

If the boundary compaction fails for any other non-cancellation reason (excluding `AbortError` and `Compaction cancelled`), the extension still sends a hidden reminder with `triggerTurn: true`. It says that compaction did not complete and to continue from the current plan. The failure is then reported as an `agent_settled` extension error. A cancelled compaction schedules no continuation, and neither does exiting Pi. A Pi build that never emits `agent_settled` starts no boundary compaction.

How the continuation settles depends on the Pi version. Either way, print- and JSON-mode processes complete the compact-and-continue sequence within the same Pi invocation; an outer driver does not need to resume the session or send `Continue working`.

- **Before Pi 0.87 (0.84.2)** — `sendMessage()` starts the requested turn synchronously but returns no promise. A settlement barrier keeps the original `agent_settled` dispatch open until the continuation settles. This depends on Pi starting the turn synchronously. A later-loaded third-party extension that performs long asynchronous work in its own `agent_settled` handler is outside this guarantee and needs an integration test with that extension set.
- **Pi 0.87 and later (1.0.x)** — Pi defers a turn requested from `agent_settled` until every settled handler returns and awaits it before its own settlement completes. The extension detects this, because the session is still idle after `sendMessage()`, and returns without waiting.

While a boundary compaction is selected, from the boundary's stop until the `agent_settled` that runs it, Online Context Compact cancels Pi's own threshold compaction (`session_before_compact` with reason `"threshold"`). Otherwise Pi could run it for the stopped run first and consume the selection, leaving the boundary without a continuation. Manual and overflow compactions are never cancelled.

On Pi 0.84.2, the session reports idle while an extension-requested manual compaction is running. SoL-Pi cancels `session_before_tree` during that interval to prevent tree navigation from moving the active leaf underneath the compaction. Pi 1.x itself refuses tree navigation during a compaction. Navigation works normally after the compaction callback settles.

Online Context Compact reads `ExtensionContext.getContextUsage()` for both the context window and the provider-counted context size. When Pi reports no size — as it does between a compaction and the next answered request — the boundary falls back to its own estimate.

The standalone entry passes `cacheWriteReadRatio` from `sol-pi.json` directly into Online Context Compact's economic check. It does not inspect model price metadata. Changing models during a session does not change the ratio; users who want a different decision policy update the configuration and start a new session.

## Codemode

Pi 1.x codemode lets the model run a script that calls other tools through `ctx.executeTool()`. With `codemode.mode: "on"`, declared tools stay declared and are also callable from scripts. With `"only"`, they are hidden from the model and listed in the `codemode` tool description instead. Calls made from a script get the id `<codemode call id>/<n>`, and their results reach only the script, not the transcript. Every mechanism loads and runs in both modes:

| Mechanism | `codemode.mode: "on"` | `codemode.mode: "only"` |
|---|---|---|
| Action Fusion | Fused edit/write stay declared to the model and are also callable from scripts. | Fused edit/write are callable from scripts only. |
| ObservationPack | Large text results of direct tools and of `codemode` itself are packed. `obs_recall` is declared directly and callable from scripts. | `codemode` results are packed. `obs_recall` is listed in the `codemode` description and callable from scripts. |
| Evidence-Preserving Reducer | Reduces direct bash and fused edit/write results as before. Script calls are skipped. | No effect in normal operation: the model reaches bash, edit, and write through scripts, and script calls are skipped. It makes no model calls. |
| Online Context Compact | `update_plan` stays declared to the model and is not callable from scripts. | Same as `"on"`. |

**Action Fusion.** Scripts call `tools.edit` and `tools.write`; the `then_run` parameter appears in their script declarations. Edit and write declare no output schema, so following codemode's rule a successful call resolves to the combined text, including `[then_run:succeeded]` and the command output. A failed command (`[then_run:failed]`) or a failed mutation (`[then_run:skipped]`) rejects with an `Error` whose message holds that text. The file change is kept, so scripts that run `then_run` should use `try`/`catch` or `Promise.allSettled()`. Codemode lists script calls inside its own TUI row, so they show neither the Action Fusion banner nor the savings notice: a script already chains tools inside one model request.

**ObservationPack.** A `codemode` result is an ordinary tool result. Successful text-only results over 10 KiB are sent in full for two provider requests and then replaced by a placeholder naming `tool: codemode`. Tool calls made inside a script are not in the transcript and are never packed; only the script's output is. `tools.obs_recall({ id, offset })` resolves to the recall text, a header followed by the original bytes. The placeholder still says to call `obs_recall`; its wording is unchanged so placeholder bytes stay stable.

**Evidence-Preserving Reducer.** Because script calls are skipped, a script calling `tools.bash` gets Pi's own result: the call resolves to Pi's structured value `{ output, exit_code, truncated, full_output_path?, wall_time_seconds }`, and a non-zero exit resolves rather than rejects. A timeout, an abort, or a missing exit code rejects. The `codemode` result itself is never reduced.

**Online Context Compact.** `update_plan` is registered with exposure `"model-only"`: a script call would get a nested id that no turn reports as a tool result, so its plan boundary could never compact. The model calls `update_plan` directly in both modes, and plan boundaries compact and continue as described above.

## Interactive TUI

The lightning savings treatment uses Pi's public `renderCall`, `renderResult`,
`ctx.ui.notify()`, and keyed `ctx.ui.setStatus()` APIs. It checks
`ctx.mode === "tui"` rather than `ctx.hasUI`, because RPC mode also reports UI
support. The renderer therefore changes only the interactive terminal display;
it does not change session messages, provider requests, tool results, JSON
events, print output, or RPC UI requests.

Action Fusion's savings notice appears only after the follow-up command
succeeds. Its banner on a fused edit/write row shows while the call runs and
after it succeeds, and is removed once the call ends as an error.

## Test doubles

The test suite drives every extension through the same public `ExtensionAPI` and `ExtensionContext` surface Pi provides, over a real public `SessionManager`, with no provider registered. That keeps the suite zero-spend and independent of the deleted Pi monorepo test harness. Suites that need a genuine session tree — branch order, compaction entries, custom entries, resume — use `SessionManager.inMemory()` or `SessionManager.create()` rather than reimplementing them. Suites that need Pi's real agent loop or codemode run a real `AgentSession` with Pi's faux provider; the codemode suites run only on Pi versions that ship codemode. The faux provider does not call `onPayload`, so suites that check Online Context Compact's request count call it from the faux responses, as built-in providers do.

`tests/pi-package-integration.test.ts` loads the actual TypeScript entrypoint through Pi's `DefaultResourceLoader`, reads a trusted all-enabled project configuration, and executes a fused write/command and a plan update in a real `AgentSession`. `tests/online-context-compact-agent-session.test.ts` verifies one and two consecutive native compactions and waits for automatic continuation before the original prompt returns. These integration tests use Pi's deterministic faux provider; they verify runtime compatibility, not live provider authentication or token savings.
