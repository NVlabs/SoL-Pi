# Pi Compatibility

SoL-Pi is developed and tested against `@earendil-works/pi-coding-agent` 0.85.1 and remains compatible with the originally supported 0.84.2 release. The current 19 test files (140 tests), type checking, package inspection, public API checks, and offline extension startup passed on both releases. Previous checks covered the public API surface of Pi 0.81.1, the base used by the original Pi fork; they are not a current full-suite compatibility guarantee. The runtime range is deliberately expressed as a peer dependency because Pi owns installation and upgrade of its packages; it is not a guarantee for every Pi version.

SoL-Pi imports only public package exports:

- `createEditToolDefinition`
- `createWriteToolDefinition`
- `createBashToolDefinition`
- extension types and `ExtensionAPI.registerTool`
- `context`, `before_provider_request`, `tool_result`, `turn_end`, `agent_settled`, and `session_before_tree` extension events
- native compaction events, `ExtensionContext.getContextUsage()`, and `ExtensionContext.compact()`
- `ExtensionContext.model` and `ExtensionContext.modelRegistry`
- the public session-manager methods exposed through `ExtensionContext`

## Action Fusion

The built-in edit/write definitions capture their working directory, so SoL-Pi caches one definition per `ctx.cwd`. Its own per-file queue surrounds the built-in mutation and follow-up command. It does not nest Pi's built-in mutation queue.

Action Fusion decodes `file://` targets with Node's `fileURLToPath()` before resolving the queue and hash-check path. This keeps file URLs, including percent-encoded filenames and Pi's optional `@` prefix, aligned with the file handled by the built-in mutation tool.

On Windows it applies the same drive-path conversion Pi's own resolver applies, so Git Bash, MSYS, Cygwin, and WSL targets such as `/c/src/app.ts` and home-relative `~\` paths resolve to the file the built-in mutation tool wrote. On other platforms those inputs keep their POSIX meaning.

The queue covers only fused operations registered by this SoL-Pi instance. External processes, direct built-in-tool calls outside the replacement, and unrelated extensions are not globally locked. SoL-Pi hashes the target immediately before launching `then_run` and skips the command if it observes an intervening content change.

## ObservationPack

ObservationPack changes only the messages projected through the public `context` event. Stored session history remains intact. Original bytes and the JSONL ledger live under the session-derived SoL-Pi directory.

## Evidence-Preserving Reducer

The reducer handles public `tool_result` events and resolves the configured reducer provider/model through Pi's model registry before calling `ExtensionContext.modelRegistry.complete()` when available. For the Pi 0.81.1 fork, which exposes no registry `complete()` method, it resolves authentication for that reducer model through `getApiKeyAndHeaders()` and calls the shared `@earendil-works/pi-ai/compat` completion API. The reducer preserves the original result whenever the configured reducer model is unavailable or eligibility, model-call, schema, source-hash, exact-quote, size, or likely-secret checks fail.

When reducing failed bash or fused-command output, the reducer separates Pi's terminal exit-code, timeout, cancellation, or missing-exit-code status from the captured log and retains it after the receipt. Pi appends this status outside the captured output, so a truncated command's full-output file does not contain it. Keeping the status outside the reduction and source archive preserves the execution outcome without depending on model-selected evidence or adding a model call; the receipt-size comparison covers only the replaceable log.

All persistent paths use `SessionManager.getSessionDir()` and `getSessionId()`, which are present in both the fork and Pi 0.85.1. If the session directory is empty (`--no-session` or `SessionManager.inMemory()`), SoL-Pi lazily creates a private `sol-pi-<session-id>-<random>/` directory under `os.tmpdir()`. Its path is reused by session ID across contexts and both archiving mechanisms while the extension is loaded. These files remain available after worker shutdown for callers that need to read evidence; cleanup is left to the host or caller. SoL-Pi creates no configurable storage-path surface.

The unpublished shared artifact layout is not read or migrated. Each persistent session starts from its own `<sessionDir>/sol-pi/<sessionId>/` directory; ephemeral sessions use the temporary fallback above.

## Online Context Compact

Online Context Compact uses ordinary public `context` and `before_provider_request` handlers instead of fork-only post-transform observer methods. Public handlers run in extension load order, so the SoL-Pi entrypoint registers Online Context Compact after its other context transformers. A third-party transformer loaded later is outside the context-growth observation used by its estimate.

The native cut is selected from session entries, while removable-token savings are measured from the corresponding messages in the latest observed projection. ObservationPack placeholders are therefore priced at their projected size. Dropped messages, unseen additions, and ambiguous matches contribute no proven savings; the estimator never substitutes their raw byte counts or reruns context hooks to estimate them.

Compaction preserves the current plan, request-horizon samples, and context-growth history. Every plan update uses the same step-ID/status comparison, including the first update after compaction. A boundary requires a previously registered unfinished step to become completed. Newly introduced completed IDs establish history without creating a boundary, so re-keyed completed snapshots do not retrigger compaction. An assistant must register a step before completing it to make that completion eligible for OCC. Economic compaction has a two-provider-request cooldown; context-window protection can override it. A new user task following a fully completed plan resets the request-horizon samples while preserving unpaid cache debt.

Pi does not expose its active retained-tail compaction setting through the public extension context. The standalone extension therefore uses the Pi 0.85.1 default of 20,000 tokens for its economic estimate. Its programmatic factory accepts an explicit matching value for a non-default Pi setting.

Pi 0.85.1's `ExtensionContext.compact()` aborts the active agent before it summarizes, and `agent_settled` fires only once a whole run has drained every turn, retry, auto-compaction, and queued continuation. A plan boundary that selects compaction therefore saves its plan and progress state, calls `ExtensionContext.abort()` to stop the run, and runs compaction from the `agent_settled` that stop produces. The handler awaits the compaction's own `onComplete`/`onError` callbacks. On success, the extension sends a hidden reminder through public `ExtensionAPI.sendMessage()` with `triggerTurn: true`, so Pi starts a new turn against the compacted context and continues the current plan. The reminder asks it to preserve existing step IDs when updating progress; an immediate plan update is not required.

A settlement barrier keeps the original `agent_settled` dispatch open until a synchronously triggered continuation settles. Print- and JSON-mode processes therefore complete the compact-and-continue sequence within the same Pi invocation; an outer driver does not need to resume the session or send `Continue working`. Successful compaction schedules a continuation. The exact native refusals `Nothing to compact (session too small)` and `Already compacted`, and Pi's explicit incomplete-summary token-cap error, also resume the interrupted task with the existing context. These skips are recorded as `sol-pi-online-context-compact-skipped` entries and shown as TUI warnings; they do not record a compaction or charge new cache debt. Plan-only turns cannot retry compaction until successful non-plan tool work or new user input occurs. Cancelling or exiting does not schedule a continuation. Other compaction errors still propagate.

Pi 0.85.1 does not return a promise from `ExtensionAPI.sendMessage()` and starts the requested turn synchronously, so it uses the extension's settlement barrier. Newer hosts can keep the context idle and defer the turn until settled handlers return; OCC returns control to such a host instead of waiting on the deferred turn or reporting a false start failure. A later-loaded third-party extension that performs long asynchronous work in its own `agent_settled` handler needs an integration test with that extension set.

Pi reports the session as idle while an extension-requested manual compaction is running. SoL-Pi cancels `session_before_tree` during that interval to prevent tree navigation from moving the active leaf underneath the compaction. Navigation works normally after the compaction callback settles.

Online Context Compact reads `ExtensionContext.getContextUsage()` for both the context window and the provider-counted context size. When Pi reports no size — as it does between a compaction and the next answered request — the boundary falls back to its own estimate.

The standalone entry passes `cacheWriteReadRatio` from `sol-pi.json` directly into Online Context Compact's economic check. It does not inspect model price metadata. Changing models during a session does not change the ratio; users who want a different decision policy update the configuration and start a new session.

## Interactive TUI

The lightning savings treatment uses Pi 0.85.1's public `renderCall`,
`renderResult`, `ctx.ui.notify()`, and keyed `ctx.ui.setStatus()` APIs. It checks
`ctx.mode === "tui"` rather than `ctx.hasUI`, because RPC mode also reports UI
support. The renderer therefore changes only the interactive terminal display;
it does not change session messages, provider requests, tool results, JSON
events, print output, or RPC UI requests.

## Test doubles

The test suite drives every extension through the same public `ExtensionAPI` and `ExtensionContext` surface Pi provides, over a real public `SessionManager`, without calling a remote model provider. That keeps the suite zero-spend and independent of the deleted Pi monorepo test harness. Suites that need a genuine session tree — branch order, compaction entries, custom entries, resume — use `SessionManager.inMemory()` or `SessionManager.create()` rather than reimplementing them.

`tests/pi-package-integration.test.ts` loads the actual TypeScript entrypoint through Pi's `DefaultResourceLoader`, reads a trusted all-enabled project configuration, and executes a fused write/command and a plan update in a real `AgentSession`. `tests/online-context-compact-agent-session.test.ts` verifies one and two consecutive native compactions and waits for automatic continuation before the original prompt returns. These integration tests use Pi's deterministic faux provider; they verify runtime compatibility, not live provider authentication or token savings.

The 0.84.2 backward-compatibility run used an isolated copy of the current source and tests, separate dependencies, and an empty Pi agent directory. Only the copy's four Pi development dependency versions, lockfile, and installation-guide version mentions changed. No source or test changes were needed. The run included all four mechanisms and the native compaction/continuation integration tests; it did not repeat live-provider benchmarks on 0.84.2.
