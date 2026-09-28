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
  "observationPackFullSends": 2,
  "cacheWriteReadRatio": 12.5
}
```

Feature keys may be omitted and then default to `false`. `observationPackFullSends` may be omitted and then defaults to `2`; when present it must be a non-negative integer. `cacheWriteReadRatio` may be omitted and then defaults to `12.5`; when present it must be a finite non-negative number, and `0` explicitly means that a cache write adds no cost relative to a cache read. `evidencePreservingReducerProvider` and `evidencePreservingReducerModel` may be omitted and then use the built-in reducer route; when present each must be a non-empty string. Unknown keys, unsupported versions, malformed JSON, non-boolean feature values, invalid full-send counts, invalid ratios, and invalid reducer model fields stop extension loading with a direct error.

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
- `observationPackFullSends`: selects how many provider requests still carry a large tool result in full; see [observationPackFullSends](#observationpackfullsends).
- `evidencePreservingReducer`: registers a `tool_result` handler and delegates long diagnostic-log reduction to the configured reducer provider/model.
- `evidencePreservingReducerProvider`: provider namespace used to resolve the reducer model through Pi's model registry.
- `evidencePreservingReducerModel`: model id used for Evidence-Preserving Reducer.
- `onlineContextCompact`: registers `update_plan` and boundary-driven native compaction after the other SoL-Pi context transformers.
- `cacheWriteReadRatio`: supplies the single economic decision ratio used by Online Context Compact.

## observationPackFullSends

The Observation Pack projection sends a tool result larger than 10 KB in full for its first `observationPackFullSends` provider requests and then replaces it with a short placeholder for every later request. The default is `2`.

The first replacement changes a message that has already participated in a provider request, so every prompt-cache prefix from that point onward is invalidated and re-billed at the provider's non-cached input rate. The replacement is not free even though it shrinks the context: it trades a one-time re-bill of the remaining context against keeping those tokens in context for the rest of the session.

Set `0` when the provider bills prompt caching and the context is large. The placeholder is then projected from the very first request, so the projected message never changes after it has been sent and no cached prefix is invalidated. The observation stays archived and `obs_recall` still returns the original bytes; the model simply never sees the raw payload inside the provider context.

Local measurements from one user-wide install with a 400k-500k token context on an OpenAI-compatible gateway, taken over 61 sessions and 215-1580 provider requests each:

- 329 packed observations produced 325 first-time replacements. One measured request re-billed 379k of a 475k-token prompt at the non-cached rate while only a 96.4k prefix stayed cached; the replacement was the only change to the outgoing history at that point.
- On that install the rewrites cost more than they saved, because the tail being re-billed (200k+ tokens) was far larger than the payload being removed (6k-30k tokens) and the prompt cache reported only a 10-12x read/paid price ratio.

Keep the default when the provider has no prefix cache, when the context is small, or when the agent must see the raw payload. The mechanism is unchanged either way: it still writes one archive object per observation and still fails open.

## Evidence-Preserving Reducer runtime inputs

The release entry supplies the run label and session-derived storage. It uses one configurable model route:

- **Reducer provider/model** — from `evidencePreservingReducerProvider` and `evidencePreservingReducerModel` in the effective `sol-pi.json`. If omitted, SoL-Pi uses its built-in reducer route. SoL-Pi resolves that model through Pi's model registry and still relies on Pi-managed authentication; do not put credentials in `sol-pi.json`.

## Online Context Compact runtime inputs

The release entry uses two runtime inputs:

- **Context window** — from `ExtensionContext.getContextUsage()`, used for window-pressure protection.
- **Cache write/read ratio** — from `cacheWriteReadRatio` in the effective `sol-pi.json`. The value remains fixed for the session and is not recomputed when the model changes. It drives one runtime decision and is not a cost report.

The configured ratio stays fixed for the loaded extension. The mechanism stores its current plan, progress summaries, request horizon, context growth, and compaction debt as versioned custom entries in Pi's session log. After a successful compaction it sends one hidden, generic message with `triggerTurn: true`, which starts a new turn and instructs the assistant to rebuild its plan. A settlement barrier keeps print and JSON modes in the same Pi invocation until that continuation settles, so callers do not need to resume the session or inject `Continue working`. Cancelling or exiting does not schedule an automatic continuation. The mechanism creates no separate Online Context Compact files. The programmatic factory exposes only a matching retained-tail value for installations whose Pi compaction setting differs from the default.

## Pi integration

SoL-Pi reads no dedicated environment variables. Evidence-Preserving Reducer resolves its configured reducer provider/model through `ExtensionContext.modelRegistry` and uses Pi-managed authentication. If the configured reducer model is unavailable or the nested model call fails, the original tool result continues unchanged.

SoL-Pi does not configure shell paths, command prefixes, storage paths, run IDs, provider URLs, reasoning levels, timeouts, or per-mechanism enable flags through environment variables. Apart from the EPR reducer provider/model route in `sol-pi.json`, model selection remains with Pi. Action Fusion uses Pi's default shell behavior. Persistent artifacts are derived from Pi's session directory and session ID.

## Trust

A project-local config can enable file mutation, shell execution, local archival, and remote diagnostic-log reduction. SoL-Pi waits for Pi's `session_start` context and ignores the project file unless `ctx.isProjectTrusted()` is true. Prefer the global file when you want one personal configuration across trusted projects.
