# Configuration

SoL-Pi reads one effective JSON configuration file at extension startup. It uses Pi's public `CONFIG_DIR_NAME` and `getAgentDir()` APIs rather than assuming fixed directories.

## Search order

1. `<working-directory>/<Pi config directory>/sol-pi.json`, only after Pi marks the project trusted
2. `<Pi agent directory>/sol-pi.json`
3. Built-in defaults when neither file exists

For the official Pi distribution, the first two locations normally resolve to `.pi/sol-pi.json` and `~/.pi/agent/sol-pi.json`.

The project file replaces the global file. SoL-Pi does not merge them.

## Schema

```json
{
  "version": 1,
  "actionFusion": false,
  "observationPack": false,
  "evidencePreservingReducer": false,
  "evidencePreservingReducerProvider": "provider-id",
  "evidencePreservingReducerModel": "model-id",
  "onlineContextCompact": false,
  "cacheWriteReadRatio": 12.5
}
```

Feature keys may be omitted and then default to `false`. `cacheWriteReadRatio` may be omitted and then defaults to `12.5`; when present it must be a finite non-negative number, and `0` explicitly means that a cache write adds no cost relative to a cache read. `evidencePreservingReducerProvider` and `evidencePreservingReducerModel` may be omitted and then use the built-in reducer route; when present each must be a non-empty string. Unknown keys, unsupported versions, malformed JSON, non-boolean feature values, invalid ratios, and invalid reducer model fields stop extension loading with a direct error.

For the managed all-enabled installation described in the [agent installation and configuration protocol](../agents-install.md), validate the effective file before starting Pi:

```bash
node scripts/check-sol-pi-config.mjs \
  --config /absolute/path/to/effective/sol-pi.json \
  --require-all-enabled
```

This preflight does not make every valid SoL-Pi configuration all-enabled. Without `--require-all-enabled`, omitted feature keys retain their normal `false` defaults. The managed workflow uses the flag because its acceptance criterion is that all four mechanisms are active.

## Feature behavior

- `actionFusion`: registers SoL-Pi replacements for Pi's `edit` and `write` tools.
- `observationPack`: registers `obs_recall` and a provider-context projection handler.
- `evidencePreservingReducer`: registers a `tool_result` handler and delegates long diagnostic-log reduction to the configured reducer provider/model.
- `evidencePreservingReducerProvider`: provider namespace used to resolve the reducer model through Pi's model registry.
- `evidencePreservingReducerModel`: model id used for Evidence-Preserving Reducer.
- `onlineContextCompact`: registers `update_plan` and boundary-driven native compaction after the other SoL-Pi context transformers. On Pi 1.x, `update_plan` is declared to the model only and cannot be called from codemode scripts.
- `cacheWriteReadRatio`: supplies the single economic decision ratio used by Online Context Compact.

## Evidence-Preserving Reducer runtime inputs

The release entry supplies the run label and session-derived storage. It uses one configurable model route:

- **Reducer provider/model** — from `evidencePreservingReducerProvider` and `evidencePreservingReducerModel` in the effective `sol-pi.json`. If omitted, SoL-Pi uses its built-in reducer route. SoL-Pi resolves that model through Pi's model registry and still relies on Pi-managed authentication; do not put credentials in `sol-pi.json`.

Before calling the reducer model, SoL-Pi leaves diagnostic output unchanged when its precautionary secret check detects credential assignments, command-shaped password/passphrase flags with values, or private-key armor (including PGP private keys). This is not a complete secret scanner; ordinary password-related test names, assertion diagnostics, and flag documentation remain eligible for reduction.

## Online Context Compact runtime inputs

The release entry uses these runtime inputs:

- **Context window** — from `ExtensionContext.getContextUsage()`, used for window-pressure protection.
- **Compaction settings** — on Pi 1.x, the retained tail and the window-protection reserve follow Pi's effective `compaction.keepRecentTokens` and `compaction.reserveTokens`, including a `compaction.modelOverrides["<provider>/<id>"]` entry for the current model. Pi 0.84.2 does not expose its settings to extensions, so SoL-Pi uses Pi's defaults of 20,000 and 16,384 tokens there.
- **Cache write/read ratio** — from `cacheWriteReadRatio` in the effective `sol-pi.json`. The value remains fixed for the session and is not recomputed when the model changes. It drives one runtime decision and is not a cost report.

The configured ratio stays fixed for the loaded extension. The mechanism stores its current plan, progress summaries, request horizon, context growth, and compaction debt as versioned custom entries in Pi's session log. After a successful compaction it sends one hidden, generic message with `triggerTurn: true`, which starts a new turn and asks the assistant to continue the current plan, preserving existing step IDs when updating progress. Newly introduced completed steps are recorded as history and do not create completion boundaries. Economic compaction has a two-provider-request cooldown; context-window protection can override it. Known native refusals and incomplete-summary token-cap failures are recorded as skips, resume the task, and block plan-only compaction retries until successful non-plan tool work or new user input. If the compaction fails for any other non-cancellation reason, it sends a hidden message that tells the assistant to continue from the current plan, then reports the error. Print and JSON modes finish that continuation in the same Pi invocation, so callers do not need to resume the session or inject `Continue working`. Cancelling the compaction or exiting Pi does not schedule an automatic continuation. The mechanism creates no separate Online Context Compact files. The programmatic factory accepts an explicit retained-tail value, which overrides Pi's setting.

## Pi integration

SoL-Pi reads no dedicated environment variables. Evidence-Preserving Reducer resolves its configured reducer provider/model through `ExtensionContext.modelRegistry` and uses Pi-managed authentication. If the configured reducer model is unavailable or the nested model call fails, the original tool result continues unchanged.

SoL-Pi does not configure shell paths, command prefixes, storage paths, run IDs, provider URLs, reasoning levels, timeouts, or per-mechanism enable flags through environment variables. Apart from the EPR reducer provider/model route in `sol-pi.json`, model selection remains with Pi. Action Fusion uses Pi's built-in Bash execution, with `shellPath` and `shellCommandPrefix` inherited from Pi's file-backed settings at extension startup. Global settings apply everywhere; project settings override them only after project trust. Malformed settings stop initialization rather than silently selecting a different shell. Persistent artifacts are derived from Pi's session directory and session ID.

For native Windows with Git for Windows installed outside the default directories, configure its Bash executable in Pi's `settings.json` (not `sol-pi.json`), for example:

```json
{
  "shellPath": "D:/Tools/Git/bin/bash.exe"
}
```

Replace that example path with your actual Git Bash installation. `then_run.command` remains a Bash command even if the model's ordinary command tool is PowerShell; Git Bash is a native Windows program and does not require WSL. Do not point `shellPath` at `powershell.exe`, because the built-in Bash tool invokes it with Bash arguments. Restart the extension after changing shell settings.

This bridge reads file-backed settings, not SDK/CLI-only in-memory overrides. Embedded runtimes can pass explicit `bashOptions` to `createActionFusionExtension`; programmatic execution overrides remain supported.

## Trust

A project-local config can enable file mutation, shell execution, local archival, and remote diagnostic-log reduction. SoL-Pi waits for Pi's `session_start` context and ignores the project file unless `ctx.isProjectTrusted()` is true. Prefer the global file when you want one personal configuration across trusted projects.
