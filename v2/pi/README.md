# SoL-Pi v2 for Pi

A standalone extension for Pi 1.2.0 that reduces model cost by handing routine work from a strong model to a cheaper model on the same API. A judge approves the hand-off and checks when the strong model should return. The cheap model writes a short note that replaces its stint in the strong model's requests; the session file retains the original steps.

The package selects its behavior from the configured strong model's API: `openai-responses` or `anthropic-messages`. Shared code lives once. Pi itself is not modified, and the package has no runtime dependencies beyond the Pi host.

## GPT: GPT-6.1 Sol → GPT-6 Luna

| Area | What happens |
|---|---|
| Hand-off | From Sol's tenth call, a judge checks every ten calls whether the next steps carry out a decision already made: running checks, applying an established fix, small edits, or reporting results. Design, unclear failures, algorithms, correctness reasoning, and proofs stay with Sol. |
| Cheap work | Luna sees the whole conversation and gets a reminder to continue toward the task's goal. |
| Return | Every ten Luna calls, the judge checks for stalled progress, worse results, or proof work. A failed return judgment returns to Sol at the next turn end. Ending Luna's run also returns to Sol. |
| Context | A note replaces each completed stint that SoL-Pi handed off. Sol's own earlier history stays unchanged. If a note fails, Luna's steps remain visible while the note is retried, up to three total attempts. |
| Compaction | SoL-Pi does not initiate priced compaction on GPT. When Pi compacts for its context window, overflow, or `/compact`, a cheaper model writes a summary of Pi's chosen range. |
| Tools | GPT keeps the host's bash at startup. After wrapping Pi's built-in bash on Claude, SoL-Pi restores its stock description and effective shell settings on GPT. Bash supplied by another extension is left alone on both APIs. |

## Claude: Claude Opus 5.5 → Claude Haiku 5.5

| Area | What happens |
|---|---|
| Hand-off | The same ten-call schedule approves routine next steps. Haiku takes over from Opus on the Anthropic Messages API. |
| Cheap work | Haiku sees the conversation and gets the continuation reminder. |
| Return | Every ten Haiku calls, the judge checks stalled progress, worse results, and whether the next step needs hard reasoning: design, a new algorithm or component, a substantial refactor, an unclear failure, correctness or performance reasoning, or a proof. A failed judgment or Haiku ending its turn returns to Opus. |
| Context | Haiku's note replaces its completed stint. Until a note succeeds, a short notice tells Opus to check the files; Haiku's turns are not sent to Opus. Notes have at most three attempts per durable hand-off, across processes and compactions. Background results delivered during a stint follow the note verbatim, with a bounded head and tail, even if compaction removed their delivery turns. If the entire stint was compacted before hand-back, outstanding results follow the compacted context. |
| Long commands | With Pi's built-in bash, the wrapper preserves the effective command prefix and normalized shell path. A command still running after two minutes continues in the background. Its result arrives with a later tool result: job, command, elapsed minutes, exit/failed status and up to about 4,000 characters from the beginning and end of the available structured output (display text if absent). If another extension supplies bash, it keeps control: no yield wrapper or description change. |
| Recovery | Finished background results are saved before delivery. A new process delivers outstanding results at its first non-nested tool result. If a job was still running when the old process ended, the model is told its result was not captured so it can rerun or check it. |
| Compaction | Priced compaction runs when expected savings cover its cost. Haiku writes the summary, and selected turns may remain verbatim. Pi's own compaction uses a separate summary-only prompt covering Pi's entire chosen range. |

On restart, GPT restores its forward count from strong-model messages. A fresh process on the original strong Claude model starts a new ten-call count, as measured. Within a restored cheap stint both APIs resume the forward count saved at hand-off and count the transition as the first return-check step. A pending return runs before the periodic cadence; a declined return is not repeated at a restart boundary. A manual selection cancels pending switches. If an earlier automatic switch lands late, SoL-Pi switches back to the user's selection without recording a second manual change.

**Redaction limitation:** Yielded output bypasses other extensions’ bash-result handlers. Pi 1.2.0 can execute another tool call through its policy hooks, but has no extension API to submit an already-completed execution for another bash-result pass. A yielded command's bounded output can therefore be stored in the session and forwarded on a later tool result without a bash-specific redactor seeing it. Do not enable this wrapper where such redaction is required; a policy-provided bash is left alone.

## Install and use

Install Pi 1.2.0, then install this directory once:

```sh
npm install --global @earendil-works/pi-coding-agent@1.2.0
pi install /path/to/SoL-Pi/v2/pi
pi list
```

Pi's manifest loads `pi-entry.ts`, which resolves the stock bash factory through Pi's extension loader and installs `extension.js`. The latter also supports explicit `-e` and native loading. Add `--local` to `pi install` for a project-only declaration, or omit it for your personal Pi installation. No repeated `-e` argument is needed.

For a Git distribution whose repository root contains this package, use `pi install git:HOST/OWNER/REPOSITORY@REF`. This checkout is a monorepo: use the package directory above. Pi 1.2.0's Git source syntax does not select a package subdirectory; installing the monorepo root would install its different root package.

Configure Pi's official provider credentials through Pi or its standard environment variables (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`), then run:

```sh
pi --provider openai --model gpt-6.1-sol --thinking xhigh
pi --provider anthropic --model claude-opus-5-5 --thinking high
```

These provider names and model ids were checked against Pi 1.2.0's built-in catalog. SoL-Pi uses Pi's model registry for every nested call; it does not read credential files or configure provider URLs. For non-interactive use, provide a prompt and close stdin as appropriate for Pi's mode.

## Model choices and environment variables

Explicit environment overrides come first. Values are `provider/model-id`. An override that does not resolve writes a `model-override` session entry and a warning in the TUI, once per variable/value per session controller. That role behaves exactly as when no cheaper model exists: an invalid hand-off override prevents hand-off, an invalid judge override prevents judging, and an invalid summary override disables priced compaction while Pi’s own compaction uses the current model to write its summary. No alternative cheaper model is selected for that role.

| Variable | Purpose |
|---|---|
| `SOLPI_HANDOFF_MODEL` | Model that takes over routine work. An explicit target must be available, have configured auth, use the same API and differ from the strong model. Otherwise SoL-Pi warns and skips the forward judge. |
| `SOLPI_JUDGE_MODEL` | Model judging both hand-off and return. It may use another API or provider. |
| `SOLPI_SUMMARY_MODEL` | Writer for compaction summaries, including during a stint. The default pair is resolved from the stint's strong model. Hand-back notes use the cheap model recorded for that stint, not this override. |

Without an override, the known pairs are:

| Strong model | Hand-off and compaction summary | Default judge on the official provider |
|---|---|---|
| `openai/gpt-6.1-sol` | `openai/gpt-6-luna` | `openai/gpt-6-luna` |
| `openai/gpt-6.2-sol` | `openai/gpt-6-luna` | `openai/gpt-6-luna` |
| `anthropic/claude-opus-5-5` | `anthropic/claude-haiku-5-5` | `anthropic/claude-haiku-5-5` |

GPT-6.2 Sol was checked on five small coding tasks through the NVIDIA gateway adapter, not on the 2-hour benchmark: all five passed their tests on the first try in both arms, and SoL-Pi cost 46% less than plain Pi ($0.40 against $0.74; one run per task, so a working check rather than a measurement). Pi 1.2.0's built-in `openai` catalog does not list `gpt-6.2-sol`; use a custom provider that registers it.

Pair matching uses the final model-id segment, so provider route prefixes work too. Pair choices must be available and cheaper than the configured model. For judges, a single provider serving both families uses the cheapest available known companion, on either API. This preserves Luna as the evaluated NVIDIA gateway's judge for both Sol and Opus. Only when no known choice applies does SoL-Pi use the cheapest cheaper chat model of the provider; hand-off and summary fallbacks also require the same API. Without a cheaper model, SoL-Pi makes no hand-off or priced cut; on Pi's own compaction the current model can write the summary.

With official providers, an Opus session's default judge is Haiku. To reproduce the evaluated Luna judge choice with an OpenAI key available in Pi:

```sh
SOLPI_JUDGE_MODEL=openai/gpt-6-luna pi --provider anthropic --model claude-opus-5-5 --thinking high
```

This reproduces the judge choice, not the gateway tariff or all other benchmark settings.

## Interactive savings display

Only Pi's TUI shows notices and a persistent status-bar entry:

```text
⚡ SoL-Pi · handed to GPT-6 Luna
⚡ SoL-Pi · back on GPT-6.1 Sol
Money saved · ~$0.42 (this stint) · ~$3.10 (this session)
```

The estimate prices the stint's tokens at the strong model's rates, subtracts the cheap model's actual cost, then subtracts judge and note calls, including failed note attempts. One-hour cache writes cost twice the input rate, as in Pi 1.2.0; shorter writes use the cache-write rate, with the applicable input-size tier. Session totals are rebuilt from session records. `~` marks an estimate, not an invoice; totals can be negative. In the TUI the return note is written before displaying its cost. Print and RPC modes have no display changes and keep their existing note-call timing.

## What decides compaction

Claude's priced cuts use model prices, measured token and cache usage, expected future requests based on requests so far, and file re-reads observed after earlier cuts. A prior of three file re-reads applies before the session supplies its own measurements. A five-minute cache lifetime helps price long tool turns. No benchmark time limit or task-specific threshold controls the policy. Priced summaries retain their KEEP/DECLINE decisions; Pi's own compactions have already chosen the removed range and kept tail.

## Measured results

The GPT checkpoint at `f391b4b` is byte-for-byte the measured GPT candidate. The Opus result was measured on commit `c75207d`. For Opus, `f391b4b` is the replay baseline: it adds a release fix that stops the writer producing the same note twice across processes. [HISTORY.md](HISTORY.md) identifies both checkpoint directories, which are in the team's internal repository. The figures use NVIDIA gateway prices, not current official-provider bills. Runs lasted two hours on a set of 39 held-out tasks, compared with plain Pi using the same strong model and thinking level.

| GPT, Sol at `xhigh` | Task-runs | Plain Pi bill | SoL-Pi bill | Cheaper | Score difference, 0–100 scale |
|---|---:|---:|---:|---:|---:|
| Round 1, 2026-11-13 | 22 | $127.88 | $72.87 | 43.0% | -3.5 points |
| Round 2, 2026-11-14/15 | 39 | $223.98 | $128.90 | 42.4% | +0.3 points |
| Round 3, 2026-11-14/15 | 38 | $181.15 | $118.91 | 34.4% | -6.5 points |
| Round 4, 2026-11-15/16 | 39 | $193.66 | $117.83 | 39.2% | -3.2 points |
| All four rounds | **138** | **$726.67** | **$438.51** | **39.7%** | **-3.2 points** |

The older frozen tariff gave 34.2% cheaper across those GPT rounds. The measured GPT configuration used 272,000-token windows. Task scores and costs varied substantially between runs; the comparisons use paired tasks from the same round.

| Claude | Tasks | Cheaper than plain Pi | Score difference, 0–100 scale |
|---|---:|---:|---:|
| Opus 5.5 at `high` | 39 | **42.7%** (**38.2%** at the older frozen tariff) | **-2.1 points** |

The Opus baseline pooled five plain Pi arms per task (historical identifiers are in HISTORY.md). Its reported score difference has about ±4 points of uncertainty at 90%. The evaluated gateway used Luna as the Opus judge.

## Changes since the measured code

The initial merge reproduced both tagged replays. The Opus replay already includes the note-persistence release fix described above. Subsequent changes are listed by the internal review issue they answer:

- **Issue 5 bug 1 / issue 6 bug 2:** an empty, failed, throwing, or unparsable return judge gives control back at the next turn end. A failed hand-off judgment leaves the strong model in place. **A2:** an unconsumed return decision, including failure, survives restart and runs before the periodic cadence until the model switch succeeds. Returning at agent end also consumes it.
- **Issue 5 bug 2:** only recorded SoL-Pi hand-offs are summarized. Switch records identify both models; manual selections cancel pending switches and preserve other history. Session start and tree navigation rebuild controller state from the selected branch; abandoned jobs, judges and writers cannot publish there. Model-change records use provider/modelId, not entry ids. Switch ownership is recorded only if Pi still has the expected model and selection epoch after the switch. Judges are scoped to that epoch, including while in flight.
- **Issue 6 bug 1 / denied edits:** Pi's own compaction uses a summary-only prompt for the whole range. Priced Claude compaction retains KEEP/DECLINE. Neither compactor opens an edited path. The verbatim section uses only the text returned by a successful, untruncated full read after a confirmed write or edit. A write request or edit acknowledgement alone does not supply a file snapshot. Without confirmed contents only the path is kept, with one log entry and a TUI warning.
- **Issue 6 bug 3:** note records include nested-call usage and the writer, so costs can be reconstructed.
- **Issue 7 bug 1:** background results are saved with bounded output and exit status. Parallel hooks reserve one carrier per result per batch. After restart only a persisted carrier containing the notice counts as delivery. Live jobs survive `/tree` by launch-entry ID; results are published only on a branch containing the launch. Legacy job numbers may repeat: their launches remain distinct and migrated output gets the same head-and-tail bound. Interrupted jobs without a captured result produce an uncaptured-result notice. A carried result follows its note, or follows the compacted context if the stint disappeared. Only an outgoing strong-model context acknowledges it. After acknowledgement, a later compaction can retire fully compacted results.
- **Issue 7 bug 2:** a steering message separates notes, and a compacted suffix can need a new one. Reuse requires a matching start, step count and whole range: new notes record a fingerprint, older ones are checked against the saved branch messages. The budget is **three outer writer attempts**, each with the measured writer's inner retries on transient errors (5-second backoff, doubling within the cache lifetime). This is not a limit of three completion requests. All ranges of a hand-off share the budget across compaction and restart. Each outer attempt is reserved before dispatch, even if no reply returns. With no note, GPT keeps the raw range and Claude gets the no-note notice.
- **Issue 7 bug 3:** an active hand-off preserves the forward count at the transition, and both APIs restore return cadence including the transition step. Without an active hand-off the normal GPT and Claude paths follow their respective measured restart rules. Counts after a manual selection are scoped to that selection.
- **Issue 7 bug 4:** a process starting on the cheap model restores its owned stint and strong return model, including from the evaluated switch-record format. Its strong model's history is preserved.
- **Issue 7 bug 5:** package lookup is injectable in tests, so installed-host resolution no longer changes test outcomes.
- **Issue 7 bug 6:** the stop hint uses only the observed shell PID. If no single live child can be identified, there is no stop hint.
- **Issue 10:** the gateway adapter is outside the public package. Known model pairs, including the summary writer during a stint, avoid unrelated tiny models on the official providers without changing the evaluated gateway choices. Missing, unavailable, unauthenticated, self or cross-API hand-off overrides warn and suppress the forward judge; cross-provider judges remain supported.
- **Issue 11:** a proper package name and Pi manifest enable a one-step local or package-root Git installation.
- **Issue 12:** the TUI shows switches and estimated net savings. It prices the projected conversation excluding system messages, like Pi's context handler. Non-interactive runs retain their timing. **B3:** one-hour cache writes use Pi’s twice-input price.
- **Issue 5 simplifications / issue 13:** duplicate modules, inactive reasoning and prompt handlers, the unused Claude fold, GPT codemode branches, and no-effect stubs were removed. Historical headers and version labels moved to HISTORY.md; new session records use `sol-pi-v2` and measured sessions still restore (**B4**). Old version folders remain at the tag.
- **Bash selection:** GPT startup leaves the host tool intact. Claude checks the active tool after all session-start handlers: Pi's stock source and definition guidelines distinguish it from synthesized SDK overrides. External tools, unverified tools and a missing host factory disable the wrapper, with one log entry and a TUI warning. The wrapper and the restored GPT definition preserve Pi's shell settings.

**What can change benchmark results:** the yield message now says `To stop its shell while it is running: kill -TERM <PID>` instead of matching command text, or omits the hint if no PID is known. Background delivery/recovery, active-stint recovery, failed-return handling, compaction prompts and confirmed file snapshots can also change model-visible work. The outer-attempt cap matters after failures, interruptions, or more than three distinct ranges. These changes have not been re-measured. TUI pricing, manual selections and nonstandard bash are separate from the benchmark path. The default official Opus judge is Haiku rather than the evaluated Luna.

## Offline validation

From this folder:

```sh
npm_config_update_notifier=false npm_config_offline=true npm test
node scripts/equivalence.mjs
node scripts/equivalence.mjs --allow-intended
node --test scripts/equivalence.test.mjs
```

Tests use mocks and make no model calls. The replay reads both tagged baselines into temporary directories and compares scripted sessions with hand-offs, notes, compaction, background bash and new-process resumes. It requires a checkout of the team's internal repository with the tag; without it, the comparison tests that load the tagged checkpoints are skipped. Strict mode exits nonzero when differences exist; `--allow-intended` accepts only reviewed differences. `SOLPI_EQ_TRACE_DIR` can save detailed local traces; `SOLPI_EQ_EXTENSION` can select a saved merged snapshot. These are replay-only settings, not runtime configuration.

Stage 1: 163 GPT observations and 161 Claude observations, zero differences from the tagged replay. Round four: **14 GPT and 34 Claude differing observations, all reviewed, zero unexplained**. Mutation tests reject duplicated/misplaced carried output, an erased resumed judge payload, and a durable reservation delayed until after the writer replies. The internal adapter separately tests gateway catalog and mid-stint writer parity.

Round three exercised the supplied Pi 1.2.0 in a temporary home, with its matching loader and bundled SDK, scripted turns and mocked completions. In that script both explicit loading and `pi install` discovery produced judges at calls 10 and 20, the continuation line on every cheap request, and a note on every strong request after the stint. Sol/Luna used xhigh/medium effort and Pi's bash; Opus/Haiku used high/medium and the yield-note bash. A separate restart test holds the process cuts fixed: delaying the first judge reply and losing an in-flight reply at the boundary moves the second logged GPT decision from 20 to 21 in both the tagged code and this package. Timing in one scripted run is not a guarantee for every restart.

Round four also checked both loading paths on the bundled host, the restricted bash supplied by the SDK or an extension, and Pi's default parallel tool execution. The completed job appeared on the first carrier only, as in the tagged Claude code. These are offline host checks, not a new benchmark or a live provider test.
