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

**Provider switchers.** Tools such as cc-switch write `ANTHROPIC_BASE_URL` into Claude Code's settings, and the settings override the
environment. Set `CCSAVE_UPSTREAM` to that URL: the launcher passes the proxy's URL with `--settings`, which overrides user and
project settings for this session. If a settings file names a different URL, the launcher stops and names the file. Managed
settings that set the URL cannot be overridden, so the launcher refuses to start under them.

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
| `CCSAVE_PING_S` | `270` seconds between idle cache keep-alives; `0` turns keep-warm off. |
| `CCSAVE_PING_IDLE_CAP_S` | `3600` seconds without a request from Claude Code, after which keep-alives stop until its next request. A long benchmark run can raise it. |
| `CCSAVE_JUDGE_EVERY`, `CCSAVE_RETURN_EVERY` | Judge counter thresholds: `5` for Opus and `10` for the cheap model. |
| `CCSAVE_RETRY_S` | `3,10,30` seconds for 429 retries; tests inject short waits. |
| `CCSAVE_PRICES` | JSON mapping model IDs to five prices, or to two lists of five by prompt length; see below. |

Environment values win over files, including empty values. If a model file is absent, the cheap model is unset and
mid/judge fall back to the cheap model. With hand-offs disabled, request bodies pass through exactly, cache markers
included: no bridge or judges. Chunked uploads are dechunked and sent with the original entity bytes and their length.
The upstream receives one `Accept-Encoding: identity` and must honor it; the proxy does not decompress unsolicited
encodings. Idle keep-alives remain separate requests and follow the interval and idle cap above.

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

It prints `⚡ SoL-Pi · claude-haiku-5-5 · ~$0.42 saved after $0.04 keep-warm`, updating the model on hand-off and return. The launcher exports
an absolute status file path for Claude Code and its status command. The small JSON file is written atomically and the total
survives a restart when the saved file matches the ledger ID in state. A fresh state, another conversation, or an older
status file without that ID starts at zero. A status-file override does not combine totals from different logs. If you
run the status command outside the launcher, set `CCSAVE_SAVED_FILE` or `CCSAVE_LOG`; without either it shows “starting”.

The estimate is **completed cheap-model usage priced at Opus's rates − cheap-model cost − judge and note cost − keep-alive cost**. It includes
input, output, cache reads and cache writes. Current-generation judges count, even rejected hand-offs; stale answers do not charge a newer generation or conversation; a negative saving is possible.
The status line shows the keep-alive cost, already subtracted, after the saving.
It excludes any effect on later Opus usage or task quality. It is an estimate, not an invoice.
Unknown prices are listed in `unpriced_models`, and the status line labels the total a partial estimate. A keep-alive
that got no answer, or a success without usage, is counted in `unpriced_pings` and does the same. A keep-alive answered
with an error status adds nothing.

The built-in rates, in USD per million tokens, are from Anthropic's pricing page
(<https://platform.claude.com/docs/en/about-claude/pricing>), read on 2026-11-23. They are not a live price feed:

| Model | Input | Output | Cache read | 5-minute cache write | 1-hour cache write |
|---|---:|---:|---:|---:|---:|
| `claude-opus-5-5` | 4 | 20 | 0.2 | 5 | 8 |
| `claude-sonnet-5-5` | 2 | 10 | 0.1 | 2.5 | 4 |
| `claude-haiku-5-5`, prompts up to 100k tokens | 0.1 | 0.5 | 0.01 | 0.125 | 0.2 |
| `claude-haiku-5-5`, prompts over 100k tokens | 0.5 | 2.5 | 0.05 | 0.625 | 1 |

A request's prompt is its input, cache-read and cache-write tokens. Over 100,000 of them, Haiku's second row prices the
whole request, output included.

Override any model with `CCSAVE_PRICES='{"claude-opus-5-5":[4,20,0.2,5,8]}'`. A value is five finite, non-negative
numbers in the column order above, used for every prompt length, or two such lists for prompts up to and over 100,000
tokens, as in `CCSAVE_PRICES='{"claude-haiku-5-5":[[0.1,0.5,0.01,0.125,0.2],[0.5,2.5,0.05,0.625,1]]}'`. Exact model IDs
take precedence over their final slash-separated name.
Choose rates before starting a conversation; already accumulated costs retain their original rates.

## What it does

| Area | Mechanism |
|---|---|
| Hand-off judge | At the Opus counter threshold (default 5), Haiku reads the task and recent work. Routine steps go to Haiku; implementation of a decided design goes to Sonnet. Design, unclear failures, new algorithms, correctness reasoning and proofs stay on Opus. |
| Waiting | Keep Opus when the next step only waits for a job while other parts still need design or new code. The return judge gives work back in the same situation. |
| Formal proofs | A proof verdict latches the current conversation to Opus. A proof-only verdict reaches disk on the next state save; a restart before then may judge again. A new conversation starts unlatched. |
| Stint | The cheap model sees the task, the judge's brief, recent work and its own steps. Hook-only feedback and bare “continue”, “continue working”, “keep going”, “go on” or “proceed” prompts can extend the stint if the return judge explicitly keeps it. Case, spaces and final punctuation are ignored for bare continues. Any other text, including text alongside hook feedback, ends the stint. |
| Way back | At the cheap counter threshold (default 10) and at turn ends, judge whether Opus is needed. A failed or malformed return judgement gives work back on the next request, and so does a turn-end judgement that takes longer than 60 seconds. A compaction instruction ends the stint even without tools or thinking. |
| Hand-back note | Replace the stint with a note describing done, state, open and unverified work. If the note call fails or takes longer than 60 seconds, use a transcript without thinking; later requests use the note once it is ready. Boundary instructions remain after the note. Split a mixed message only at that boundary, removing cheap tool results with their calls. Extended hooks and bare continues fold into the note with their original message count and cache markers. |
| History mismatch | A history shorter than the previous request's, or a change in the first 4,000 characters of that request's last message (serialized, cache markers aside), is a mismatch; edits elsewhere do not count. Recover matching notes; replace uncertain turns from possible cheap ranges with omission notices and take their paired results with them. With no cheap stint, keep the incoming messages. |
| Failures | Malformed-request statuses (400/404/413/422), 401/403 and 5xx retry on Opus; 429 does so after retries. A cheap stream succeeds only with a terminal `message_stop` and no error or interruption. Outstanding requests at restart force handback. If the cheap request cannot be recorded before sending, route it to Opus instead. |
| Keep-warm | After 270 seconds idle, resend the newest Opus request with an automated “ok” instruction to keep its five-minute prompt cache alive. Each ping pays a cache read of the whole context: about $0.04 at a 200k-token context and Opus 5.5's cache-read rate, about $0.50 an hour, and proportionally more for a larger context. Pings stop after an hour without a request from Claude Code (`CCSAVE_PING_IDLE_CAP_S`), which caps an idle session at about an hour of pings, and resume with its next request; the proxy's own pings, judges and notes do not count as requests. Stop when the parent or launcher's Claude Code child exits, with a separate watcher even while an upstream call is blocked. Both poll every five seconds. |
| Bridge | Add an ephemeral cache marker at the end of Opus's previous request if that message is unchanged and fewer than four markers exist. This lets Opus reuse that cached prefix after the conversation grows or a stint ends. Log each insertion as `kind: "bridge"`, with model, message and block indexes. Disabled in pass-through mode. |
| State | Persist stint ranges, notes and counts beside the log. Pending hand-off approvals expire on a typed instruction or restart. Routing waits for judges/notes are serialized. State files from the measured revision keep their notes when the history matches. Claude Code session metadata identifies the conversation when available, otherwise the first message does; recognized compaction keeps proofs and savings. New conversations discard unrelated ranges. Use separate logs for independent conversations with identical initial tasks and no session metadata. |

The counters advance on **main requests other than compaction**: add the number of newly submitted assistant tool calls,
with a minimum of one per request, even for zero tool calls or an identical replay. A pending decision or proof latch can
suppress a judge; after a return the hand-off judge can look again early. No threshold is fitted to the benchmark.
The proxy logs HTTP status, completion and reason, usage, judges, switches, notes, bridge insertions, mismatches and pings;
it does not log request headers.

## Measured

The results below describe **v23 at `f391b4b`, tag `solpi-v2-evaluated`** in the team's internal repository, not the current code. The savings
reflect the gateway rates used in the evaluation; end-to-end testing on the official Anthropic API is still outstanding.

Two-hour runs on the 39 held-out EdgeBench tasks, compared with the same Claude Code without the proxy, at the same time
(one agent, no sub-agents). Gateway speed changes by hour, so each run had its own same-time control.

| Comparison | Tasks | Cheaper | Score difference (0–100) |
|---|---|---|---|
| Two runs (11-12) pooled against their two same-time controls | 39 | **41.3%** [33.4, 48.7] | **+0.3** [-2.7, +3.6] |

Score comparisons use equal judging coverage and 90% intervals over tasks. On the 36 fully judged tasks: -0.9
(-0.3 raw); without Lean tasks: -0.4 (31 tasks). A single run's score difference swings by about 6 points.

Measured setup: Claude Code 2.1.288, Opus 5.5, `--effort high`, `MAX_THINKING_TOKENS=16384`, no ultracode,
`--disallowedTools Agent`, Python 3.11. Tasks used `claude -p "<task>" --output-format stream-json --verbose
--dangerously-skip-permissions`; resumes used `claude --continue -p "Continue working."`. One proxy per process.

The changes since v23 were tested offline and have not been re-measured.

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
mismatches, proof/savings identity, stale judges, concurrent routing, HTTP/stream failures and restarts, bridge logging, exact pass-through, keep-warm/client exit, model/upstream configuration,
launcher arguments/stdin/exit/SIGINT/bounded cleanup, and savings/prices/status output. The waiting-policy test routes deterministic mock
judge responses based on the instructions sent; it does not validate a real judge's reasoning.

The official API setup and real Claude Code TUI/statusLine have not been smoke-tested in this offline revision. Versions
other than Claude Code 2.1.288 remain untested. Original results cover one runner, one gateway and two runs per task;
the pooled saving interval reaches 33%. No live performance or price claims are made for this revision.
