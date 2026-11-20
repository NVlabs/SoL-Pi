# SoL-Pi v2 for Claude Code: model switching proxy

A local HTTP proxy between Claude Code and the Anthropic Messages API. Opus 5.5 hands routine work to Haiku 5.5 and
implementation of an already decided design to Sonnet 5.5. Judges approve the hand-off and the return to Opus.

This is a proxy, not a Claude Code plugin. A `.claude-plugin` manifest cannot install the process underneath
`ANTHROPIC_BASE_URL`; use the included `claude-solpi` launcher. It uses bash and Python 3.8+ (standard library only).
Claude Code's own compaction settings are unchanged.

## Use

With Claude Code installed and `claude` on PATH, set your own Anthropic API key and run:

```sh
export ANTHROPIC_API_KEY="<your Anthropic API key>"
export CCSAVE_UPSTREAM=https://api.anthropic.com
export ANTHROPIC_MODEL=claude-opus-5-5
/path/to/SoL-Pi/v2/claude-code/claude-solpi --effort high --disallowedTools Agent
```

The launcher starts a local proxy, waits for its port file, sets `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` for Claude
Code, passes through every argument and stdin, and stops the proxy when Claude Code exits. It preserves Claude Code's
exit status. On a normal exit the proxy has up to eight seconds to finish active requests and record their costs. Ctrl-C
belongs to foreground Claude Code. On TERM/HUP the launcher signals the client’s process group and its other live
descendants, then kills survivors after about ten seconds. The key is forwarded in request headers; it is not stored in proxy state. Use `claude-solpi --continue`
to resume with the same log and state. Use a separate `CCSAVE_LOG` for each concurrent conversation.

The default records directory is `$XDG_STATE_HOME/sol-pi-v2/<project-key>/`, or
`~/.local/state/sol-pi-v2/<project-key>/` if `XDG_STATE_HOME` is unset or relative. The key is the SHA-256 of the
absolute working directory. The proxy does not look for `.ccsave` in a checkout. To adopt **trusted** old records,
set `CCSAVE_LOG` to their log path explicitly. Keep the log, its `.state` and `.saved.json` together; the launcher
also writes `.err` beside them. **Both the log and the state file can contain task content**:
judge/note text and upstream diagnostics in the log; briefs, notes and message boundaries in state. New records and
directories are private to the invoking user. Check permissions on existing logs and backups; Claude Code keeps its own umask.
The proxy itself requires `CCSAVE_UPSTREAM` and refuses to start without an HTTP(S) base URL.

| Setting | Default / effect |
|---|---|
| `CCSAVE_CHEAP_MODEL` | Overrides `cheap-model.txt`: `claude-haiku-5-5`. Empty disables all hand-offs. |
| `CCSAVE_MID_MODEL` | Overrides `mid-model.txt`: `claude-sonnet-5-5`. Empty prevents new implementation hand-offs; an active Sonnet stint can resume. |
| `CCSAVE_JUDGE_MODEL` | Overrides `judge-model.txt`: `claude-haiku-5-5`. Empty disables all hand-offs. |
| `CCSAVE_LOG` | Defaults to `ccsave.jsonl` in the private project-keyed directory above, including for the direct proxy. Use a trusted directory for overrides. |
| `CCSAVE_SAVED_FILE` | `<log>.saved.json`; overrides the status file location. |
| `CCSAVE_PORT` | `0` (a free loopback port). |
| `CCSAVE_PING_S` | `270` seconds between idle cache keep-alives. |
| `CCSAVE_JUDGE_EVERY`, `CCSAVE_RETURN_EVERY` | Judge counter thresholds: `5` for Opus and `10` for the cheap model. |
| `CCSAVE_RETRY_S` | `3,10,30` seconds for 429 retries; tests inject short waits. |
| `CCSAVE_PRICES` | JSON mapping model IDs to five prices; see below. |

Environment values win over files, including empty values. If a model file is absent, the cheap model is unset and
mid/judge fall back to the cheap model. With hand-offs disabled, request bodies pass through exactly, cache markers
included: no bridge or judges. Chunked uploads are dechunked and sent with the original entity bytes and their length.
The upstream receives one `Accept-Encoding: identity` and must honor it; the proxy does not decompress unsolicited
encodings. Idle keep-alives remain separate requests until the client exits.

## Status line and estimated saving

Add this to Claude Code's `statusLine` setting (replace the absolute path):

```json
{
  "statusLine": {
    "type": "command",
    "command": "\"/absolute/path/to/SoL-Pi/v2/claude-code/statusline.sh\""
  }
}
```

It prints `⚡ SoL-Pi · claude-haiku-5-5 · ~$0.42 saved`, updating the model on hand-off and return. The launcher exports
an absolute status file path for Claude Code and its status command. The small JSON file is written atomically and the total
survives a restart when the saved file matches the ledger ID in state. A fresh state, another conversation, or an older
status file without that ID starts at zero. A status-file override does not combine totals from different logs. If you
run the status command outside the launcher, set `CCSAVE_SAVED_FILE` or `CCSAVE_LOG`; without either it shows “starting”.

The estimate is **cheap-model usage priced at Opus's rates − cheap-model cost − judge and note cost**. It includes
input, output, cache reads and cache writes. Current-generation judges count, even rejected hand-offs; stale answers do not charge a newer generation or conversation; a negative saving is possible.
It excludes keep-alive cost and any effect on later Opus usage or task quality. It is an estimate, not an invoice.
Unknown prices are listed in `unpriced_models`, and the status line labels the total a partial estimate.

The shipped assumptions, in USD per million tokens, are not a live price feed and were not verified against the official
API during this offline revision:

| Model | Input | Output | Cache read | 5-minute cache write | 1-hour cache write |
|---|---:|---:|---:|---:|---:|
| `claude-opus-5-5` | 5 | 25 | 0.5 | 6.25 | 10 |
| `claude-sonnet-5-5` | 3 | 15 | 0.3 | 3.75 | 6 |
| `claude-haiku-5-5` | 1 | 5 | 0.1 | 1.25 | 2 |

Override any model with `CCSAVE_PRICES='{"claude-opus-5-5":[5,25,0.5,6.25,10]}'`. Values must be five finite,
non-negative numbers in the column order above. Exact model IDs take precedence over their final slash-separated name.
Choose rates before starting a conversation; already accumulated costs retain their original rates.

## What it does

| Area | Mechanism |
|---|---|
| Hand-off judge | At the Opus counter threshold (default 5), Haiku reads the task and recent work. Routine steps go to Haiku; implementation of a decided design goes to Sonnet. Design, unclear failures, new algorithms, correctness reasoning and proofs stay on Opus. |
| Waiting | Keep Opus when the next step only waits for a job while other parts still need design or new code. The return judge gives work back in the same situation. |
| Formal proofs | A proof verdict latches the current conversation to Opus. As in v23, a proof-only verdict reaches disk on the next state save; a restart before then may judge again. A new conversation starts unlatched. |
| Stint | The cheap model sees the task, the judge's brief, recent work and its own steps. Hook-only feedback and bare “continue”, “continue working”, “keep going”, “go on” or “proceed” prompts can extend the stint if the return judge explicitly keeps it. Case, spaces and final punctuation are ignored for bare continues. Any other text, including text alongside hook feedback, ends the stint. |
| Way back | At the cheap counter threshold (default 10) and at turn ends, judge whether Opus is needed. A failed or malformed return judgement gives work back on the next request. A compaction instruction ends the stint even without tools or thinking. |
| Hand-back note | Replace the stint with a note describing done, state, open and unverified work. If the note call fails, use a transcript without thinking. Boundary instructions remain after the note. Split a mixed message only at that boundary, removing cheap tool results with their calls. Extended hooks and bare continues fold into the note with their original message count and cache markers. |
| History mismatch | Use v23’s length and truncated tail check. Recover matching notes; replace uncertain turns from possible cheap ranges with omission notices and take their paired results with them. With no cheap stint, keep the incoming messages. |
| Failures | Malformed-request statuses (400/404/413/422), 401/403 and 5xx retry on Opus; 429 does so after retries. A cheap stream succeeds only with a terminal `message_stop` and no error or interruption. Outstanding requests at restart force handback. If the cheap request cannot be recorded before sending, route it to Opus instead. |
| Keep-warm | After 270 seconds idle, resend the newest Opus request with an automated “ok” instruction to keep its five-minute prompt cache alive. Stop when the parent or launcher's Claude Code child exits, with a separate watcher even while an upstream call is blocked. Both poll every five seconds; there is no hourly cutoff. |
| Bridge | Add an ephemeral cache marker at the end of Opus's previous request if that message is unchanged and fewer than four markers exist. This lets Opus reuse that cached prefix after the conversation grows or a stint ends. Log each insertion as `kind: "bridge"`, with model, message and block indexes. Disabled in pass-through mode. |
| State | Persist stint ranges, notes and counts beside the log. Pending hand-off approvals expire on a typed instruction or restart. Routing waits for judges/notes are serialized. Matching v23 state files retain their notes. Claude Code session metadata identifies the conversation when available, otherwise the first message does; recognized compaction keeps proofs and savings. New conversations discard unrelated ranges. Use separate logs for independent conversations with identical initial tasks and no session metadata. |

The counters advance on **main requests other than compaction**: add the number of newly submitted assistant tool calls,
with a minimum of one per request, even for zero tool calls or an identical replay. A pending decision or proof latch can
suppress a judge; after a return the hand-off judge can look again early. No threshold is fitted to the benchmark.
The proxy logs HTTP status, completion and reason, usage, judges, switches, notes, bridge insertions, mismatches and pings;
it does not log request headers.

## Measured

The results below describe **v23 at `f391b4b`, tag `solpi-v2-evaluated`** in the team's internal repository, not the current code. Runs used the NVIDIA
gateway and its standard prices; these saving percentages are not official Anthropic API measurements.

Two-hour runs on the 39 held-out EdgeBench tasks, compared with the same Claude Code without the proxy, at the same time
(one agent, no sub-agents). Gateway speed changes by hour, so each run had its own same-time control.

| Comparison | Tasks | Cheaper | Score difference (0–100) |
|---|---|---|---|
| Two runs (11-12) pooled against their two same-time controls | 39 | **41.3%** [33.4, 48.7] | **+0.3** [-2.7, +3.6] |
| v21, two runs pooled | 39 | 46.8% [36.5, 56.6] | -2.9 [-7.0, +1.1] |

Score comparisons use equal judging coverage and 90% intervals over tasks. On the 36 fully judged tasks: -0.9
(-0.3 raw); without Lean tasks: -0.4 (31 tasks). A single run's score difference swings by about 6 points.
v23's waiting rule reduced the large losses from waiting on jobs and gave up about 5 percentage points of saving.

Measured setup: Claude Code 2.1.288, Opus 5.5, `--effort high`, `MAX_THINKING_TOKENS=16384`, no ultracode,
`--disallowedTools Agent`, Python 3.11. Tasks used `claude -p "<task>" --output-format stream-json --verbose
--dangerously-skip-permissions`; resumes used `claude --continue -p "Continue working."`. One proxy per process.
The internal gateway setup is kept in the team's internal repository.

A separate gateway smoke test at `fc3eb7d24` used Claude Code 2.1.288 on a 30-file chain, then resumed with
`--continue -p "Continue working."`. All 5 Opus and 13 Haiku requests returned 200. The hand-off judge approved;
the return and extension judges kept Haiku. The proxy logged 4 bridge insertions and estimated $0.29 saved.
That was a functional check, not a new benchmark measurement. The release fixes below were tested offline.

## Changes since the measured version (v23)

These changes **have not been re-measured**. This is the inventory relative to `f391b4b`, including changes that can fire
in `claude -p`, resumes in a new process, restarts, stop hooks, compaction, failed requests and two-hour runs. Items name
the internal review issue they answer.

**Can change benchmark results:**

- Issue 9 bugs 1–2 / issue 14 A: check appended user text (new blocks or a suffix inside a saved text block) before approvals or mismatch recovery. Typed instructions end a stint
  through its note. Split only at a stint boundary; pair results by `tool_use_id` across consecutive result messages, including on edits and v23 resumes.
  Recognize compaction independently of tools/thinking, retain the instruction outside the note and include later cheap replies.
- Issue 9 bug 3 / A10 / B3 (items 8, 10): pending hand-off approvals expire on typed instructions and restart. Stale asynchronous
  judges cannot change routing, proof state or the current generation’s savings.
- Issue 9 bug 4: after v23’s length/tail check fails, log recovery, retain matching notes and omit uncertain cheap-range turns,
  not arbitrary unseen assistant turns. Discard legacy offsets with no supporting history when that check fails.
  Reset cadence counters as in v23; leave Opus-only history alone. See the editing limits below.
- Issue 9 bug 5: session ID takes precedence over the first task. Without metadata, recognize a matching compaction reply or,
  when unavailable, Claude Code’s continuation preamble. The previous request being compaction is not enough. Preserve
  proofs and totals on continuation; reset on a new conversation, including in disabled mode. Only new conversations clear bridge endpoints.
- A9: persist the user boundary and cheap-range fingerprints/anchors for recovery. Check the first task, last user and
  tail on ordinary requests; fingerprint new active-stint messages and scan a stint when closing or rendering it. At the
  first hand-off, index Opus assistant turns by tool ID (message digest for text-only turns), then add only new Opus turns.
  State saves still serialize these identities, recorded stints, marks and notes. A mismatch with possible cheap ranges scans the incoming history;
  an unchanged Opus-only replay neither hashes nor stores the entire history. Adopt matching v23 ranges and notes.
- Issue 5 bug 1: failed or malformed return judgements give work back at the next request.
- Issue 9 bug 6: 401/403 and 5xx fall back to Opus with a note, even with a short diagnostic body. Require a terminal
  `message_stop` on requested streams regardless of MIME type. Request only identity encoding upstream and parse LF,
  CRLF and CR across read boundaries. Close short downstream responses and log completion and
  reason alongside status. Stream failure or a request outstanding at restart forces handback. Track requests individually;
  late fallback uses its own snapshot, never closes a replacement stint, and never republishes stale bridge endpoints.
  If writing the in-flight state fails, log the failure and use Opus without dispatching that request to the cheap model.
- A1 (item 7): serialize routing, including extension-judge and note waits, before constructing the outgoing view.
- Issue 9 bug 7 (items 9, 13): keep-warm has no one-hour cutoff. A separate five-second watcher also stops the proxy when the
  launcher’s child exits, or its parent exits while an upstream call is blocked; remove the unused last-main-request time.
- Issue 14 B / issue 10: disabled cheap/judge models pass the original entity bytes, including chunked uploads, with no bridge.
  Freeze the open stint at the first disabled history request, without a judge or note call; a later Opus view can use its
  transcript. Track explicit session changes even without tools. Require an explicit
  HTTP(S) upstream with a valid port before publishing readiness; ship official model IDs, give environment settings precedence, and honor empty settings (including
  disabling new implementation hand-offs with an empty mid model). Add configurable retry waits; defaults remain 3/10/30 s.
- Issue 11 / B1–B2 / B5 (item 11): add the launcher, port readiness checks, argument/stdin/status forwarding and per-launch
  temporary paths; preserve foreground SIGINT and terminate the child’s process tree on TERM/HUP with bounded escalation.
  Normal exit drains active proxy bookkeeping before shutdown; an upstream still blocked at the deadline is not a completed response.
- Issue 12 / issue 9 bridge: add price-configurable, persisted savings/status output, an absolute launcher status path and
  bridge-insertion logs. Bill each cheap response to its sending generation; log late retired costs without altering the
  active estimate. Bill fallback notes to their conversation. Bind the status file to a persisted ledger ID across
  restart/compaction. Default to private state outside the checkout; isolate status-line Python from project imports.
  Publish records from exclusive temporary files by atomic replace and refuse symlink destinations, without changing
  Claude’s umask. JSONL records are appended in place through a descriptor that refuses symlinks and non-regular files.

**Documentation, refactoring and test changes:** short module docstring with extracted HISTORY.md; shared decision/kind/
reason parsing; public Anthropic usage and separate internal gateway instructions; bridge, status-line and proxy (not
plugin) documentation; merged rejection tests, bounded waits, delayed/concurrent/stream/signal regressions and before/after
checks, isolated test environments, parallel signal cases and a mixed-boundary state fixture written by `f391b4b`.
The shipped tests do not need Git history. Python remains standard-library only.

Restored v23 behavior is not an additional change: Opus-only messages are not split; extended hooks and bare continues
fold into notes with unchanged message counts and marker positions; older edits alone do not trigger mismatch recovery;
keep-warm polls every five seconds; side-call text and error bodies are logged; mismatch recovery keeps bridge end points.
Proof-only verdicts retain v23’s save timing. Only return/extension judges require HTTP 200; hand-off and note text
are interpreted as in v23. The launcher restores the child’s default SIGINT disposition before executing `claude`.
The original judge prompts, 5/10-call cadences, model-selection policy, cheap intro, transcript limits, bridge insertion
algorithm and waiting policy remain. See [HISTORY.md](HISTORY.md) for earlier versions.

## Tests and limits

The proxy assumes Claude Code **appends to its history**. It does not reliably handle these edits:

- **Shorten an earlier tool result**, then append compaction: cheap-model turns can reach Opus without a note.
- **Remove a trailing system message**: the cheap reply can shift outside the saved range and reach Opus without a note.
- **Edit a continuation summary in place**: the proxy can forget the open stint and pass cheap turns to Opus without a note.
- **Overlap identical retries** that continue from different replies: a note meant for cheap work can cover an Opus reply and its tool result instead.
- **Append the compaction instruction inside an existing text block** of an already sent message, with no tools or thinking in the request: the instruction is not recognized and the stint stays open.

Text-suffix detection needs a boundary saved by this version. A tool that detached and was reparented *before* the
launcher received TERM/HUP may no longer be identifiable as Claude’s child. If storage remains unwritable, Opus
can still answer but the on-disk history and estimate may be stale. Use separate log **and** status paths for concurrent runs.

Two small implementation costs remain: an approved hand-off can parse the judge’s JSON several times, and rendering
and note writing assemble the stint steps separately.

Run `python3 -B test_ccsave.py` in this directory. Tests use only a local mock gateway and a stub `claude`; no keys or real API
calls. They cover hand-offs, routine/implementation routing, notes and extensions, compaction with/without tool results,
retained boundary instructions and folded hooks on later requests, appended compaction blocks, approval expiry,
mismatches, v23 state migration, proof/savings identity, stale judges, concurrent routing, HTTP/stream failures and restarts, bridge logging, exact pass-through, keep-warm/client exit, model/upstream configuration,
launcher arguments/stdin/exit/SIGINT/bounded cleanup, and savings/prices/status output. The waiting-policy test routes deterministic mock
judge responses based on the instructions sent; it does not validate a real judge's reasoning.

The official API setup and real Claude Code TUI/statusLine have not been smoke-tested in this offline revision. Versions
other than Claude Code 2.1.288 remain untested. Original results cover one runner, one gateway and two runs per task;
the pooled saving interval reaches 33%. No live performance or price claims are made for this revision.
