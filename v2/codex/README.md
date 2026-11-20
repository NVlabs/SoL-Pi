# SoL-Pi v2 for Codex: model switching proxy (Responses proxy)

A local proxy between the Codex CLI and an OpenAI Responses API provider. Python 3.8+ standard library only. Codex runs GPT-6.1 Sol at
`xhigh` by default. A judge can hand execution of an existing plan to GPT-6 Luna and return it to Sol when the work needs a new decision. Codex still owns the underlying conversation; the proxy changes the view sent upstream. The evaluated v12 is commit `f391b4b`, tagged `solpi-v2-evaluated`; this folder includes later fixes.
Version history is in [HISTORY.md](HISTORY.md).

## Measured

2-hour runs on the 39 held-out EdgeBench tasks, against plain Codex (the same Codex, model and reasoning level, without
the proxy) run the same day, through the NVIDIA gateway at its standard prices. 90% intervals over tasks.

| Runs | Tasks | Cheaper | Score difference (0-100) |
|---|---|---|---|
| **Main run (11-09/10) against plain Codex of 11-09** | 26 billed / 32 settled | **50.0%** [44.3, 55.0] | **+1.2** (+2.1 [-0.8, +5.1] at equal judging coverage) |
| Completion run (11-12) on the other 7 tasks, against same-time plain Codex | 5 billed / 4 scored | 42.8% [31.9, 56.9] | -4.4 (Lean judging still open) |
| All 39 tasks together, at the last reading | 39 | | -1.8 [-6.0, +2.3] at equal coverage, Lean judging open |

- **Score reading:** a run's score is its best judged submission. The benchmark's judge left part of the submissions
  unscored; "settled" tasks are those with nothing left to rescore. Without the Lean tasks the main run reads +1.6.
- **Comparator:** plain Codex costs about 30% more on a fast-gateway day than on a slow one (more steps in the fixed 2
  hours), so the saving is measured against plain runs of the same day.

### Setup measured

- **Codex CLI:** 0.162.0 with GPT-6.1 Sol, `model_reasoning_effort = "xhigh"`, the NVIDIA gateway as a
  Responses API provider, `codex exec ... --dangerously-bypass-approvals-and-sandbox`; the runner restarts Codex (and the
  proxy) when it stops before the 2 hours.
- **Proxy:** one proxy per Codex process, started before it, with `CCSAVE_LOG` beside Codex's sessions.

## What it does

| Area | Mechanism |
|---|---|
| Hand-off judge | At the default cadence of 10 counts, Luna reads the task and the recent work as a judge and decides whether the next steps only carry out what is already decided (running and checking experiments, variants of a change that works, an established fix). Design, unclear failures and proofs stay with Sol. After a return, the first eligible request carrying Sol’s work can trigger a new judgement (v12). |
| Stint | On approval the conversation's next request goes to Luna only if its user and developer instructions still match the judged state, with the judge's reason as its brief: carry those steps out and end the turn with a short report once they are done, or as soon as the next step needs a new decision. A subsequent user or developer message gives the work back. |
| Way back | The return judge sees the original brief and checks whether Luna is stuck or the next step needs Sol. An appended user/developer message or a compaction ends the stint. A failed return judge gives work back on the next request; a failed hand-off judge leaves Sol in charge. On Luna 401/403/429/5xx or a connection failure before relay, the proxy sends the same request to Sol. A 408 is relayed, but the proxy reserves Sol for the retry before Codex sees the headers. A failed stream also reserves its retry; a transport error after completion does not undo the work. |
| Hand-back note | Luna writes a note from its steps (done, state, open, unverified). The note replaces only a range whose content still matches. Instructions and calls needed by later tool results stay visible. Unnoted or revised evidence stays raw and can enter Sol’s cache. The proxy attempts a note at most three times per matching range across restarts. A shorter failed prefix can need its own note. On failure, Sol waits at most a quarter second for note writing; a late note is saved for later matching requests. |
| Keep-warm | While Luna works, the proxy periodically re-sends Sol’s last request for that key, asking for “ok”, to keep the prefix eligible for cache hits. The default interval is 270 seconds; pings stop after an hour away. As in v12, key adoption does not transfer the old keep-warm request. |
| Compaction cache | Codex can omit the leading `additional_tools` item when asking for a summary. The proxy restores a recognized prefix and sets `tool_choice` to `none`, so the provider can reuse its cached history. A compaction during a stint gives the work back to Sol, which receives the note if one is available. |
| Guidelines | One developer message after Codex's instructions: batch independent reads; keep reasoning short on routine steps. |
| State | Stints and counts are kept in `<CCSAVE_LOG>.state`. A new key normally needs an unambiguous match of the whole historical prefix and top-level instructions to adopt a state. Failed-request reservations are an exception (see Known limitations). Files from v12 and earlier review rounds start fresh, including counters. An edit under the same key can retain notes for unchanged ranges. |

Each eligible non-compaction request counts newly observed tool calls (including calls inside code-mode scripts), **at least one count per eligible request**, even when no tool ran. Reserved retries do not advance the judge. An outstanding judge is not duplicated.

A bare continue is a user message whose entire text, ignoring case, whitespace and final punctuation, is “continue”,
“continue working”, “keep going”, “go on” or “proceed”, with no image/file content. When appended, as in v12, it may consume a pending
hand-off approval, and it ends an already running stint. Other new user/developer instructions invalidate an approval
or end a running stint with its note. The instruction guard also covers top-level `instructions` and nontext content.
Compaction alone preserves a pending approval, as in v12; a compaction carrying new instructions drops it.

## Use

Install Codex separately and make your own `OPENAI_API_KEY` available in the environment. The launcher uses a custom
Responses provider named `solpi`, with that key and a local proxy URL. It sets the provider on the command line;
no persistent Codex configuration change is needed.

```sh
export CCSAVE_UPSTREAM=https://api.openai.com
D=/path/to/SoL-Pi/v2/codex
"$D/codex-solpi"                       # interactive Codex
# or: "$D/codex-solpi" exec "Run the tests and fix failures."
```

`codex-solpi` is a Unix launcher requiring `/usr/bin/env -S` and `python3` and `codex` on PATH. Descendant cleanup uses macOS’s process API or, on other Unix systems, `/bin/ps -eo pid=,ppid=`.
It starts an isolated Python proxy and waits up to ten seconds for its port file. Newly created proxy files are private;
Codex runs with the caller’s umask, stdin, stdout and process group. The launcher never assigns the terminal or changes job control.
The proxy shares the launcher's group and blocks INT: on shutdown it tells the launcher whether the group already received INT.
The launcher forwards a PID-directed interrupt, but does not send a second INT to group members after Ctrl-C. It preserves
an inherited ignored HUP. On shutdown it rescans surviving tracked descendants and escalates to KILL after a grace period.
Normal exit preserves Codex’s status; a handled signal, including during cleanup, returns 128 plus the signal number.
The launcher prints the estimate to stderr after shutting down the proxy.

The isolated Python supervisor installs SIGINT handling even if a noninteractive Bash started it with `&` and SIGINT
ignored. A background job still does not receive the terminal’s foreground Ctrl-C: signal its PID directly (INT or TERM).
The default model is `gpt-6.1-sol` at `xhigh`; pass `-m MODEL` or a reasoning configuration override to change it. `-m gpt-6.2-sol` was checked on five small coding tasks (2026-11-19): all five passed their tests on the first try in both arms, and the proxy cost 22% less than plain Codex ($0.82 against $1.05; one run per task, so a working check rather than a measurement).
Codex 0.162.1 drops root-level `-c` settings when a subcommand supplies its own. The launcher puts its defaults immediately
after `exec`/`e`, `exec resume`, `exec review`, `resume` or `review` (first for interactive use), before your overrides and
before `--`. For example, `exec -c 'model_reasoning_effort="high"' -- '-literal prompt'` keeps the proxy. An explicit
override of the provider or its URL can still bypass it.

- `CCSAVE_UPSTREAM` is required, including for manual startup: the API origin without `/v1`. Missing or empty means
  startup fails. There is no default upstream.
- `CCSAVE_CHEAP_MODEL` wins over `cheap-model.txt` whenever it is set. `CCSAVE_CHEAP_MODEL=''` disables hand-offs,
  judges and new note calls. Matching notes still render; a running Luna interval closes before the first ordinary disabled Sol request. Unwritten notes can be attempted when hand-offs are enabled again. When unset, the file supplies `gpt-6-luna`. No official model catalog was available in the offline
  review; this keeps the fallback identifier, without claiming verified OpenAI availability.
- The launcher creates a unique log under `$XDG_STATE_HOME/sol-pi-v2/<project-hash>/` (default `~/.local/state/sol-pi-v2/<project-hash>/`). The hash is SHA-256 of the absolute working-directory path. Keep this state root outside the checkout. New records directories and files are created with modes 0700 and 0600 respectively, subject to the caller’s umask.
- Set `CCSAVE_LOG` to a stable, process-exclusive file to reuse its adjacent `.state` on restart. Use a trusted directory and regular, user-owned files; symlinks and multiply linked files are refused, not followed. The directory that holds the records must be yours and not writable by others; above it, only other users' directories and world-writable ones without the sticky bit are refused, so a group-writable shared project tree works. Existing permissions are **not** changed: an explicitly supplied readable log stays readable. State is replaced atomically from an exclusively created random temporary file. Do not share a log between live proxies.
- `CCSAVE_PORT` selects a fixed port instead of a free one; leave it unset for multiple sessions.
  `CCSAVE_PORT_FILE` is for manual startup; the launcher always owns a unique temporary port file.
- `CCSAVE_JUDGE_EVERY` defaults to 10 counts; `CCSAVE_PING_S` defaults to 270 seconds.
- `CCSAVE_PROVIDER` and `CCSAVE_ENV_KEY` can rename the launcher's provider and key environment variable.
  Defaults are `solpi` and `OPENAI_API_KEY`. The launcher reads no key value into its arguments.

### Log contents

The JSONL log stores request/ping/side-call model IDs, usage, status or error class, timing, request paths,
compaction flags, switches and fallback reasons. Request records retain v12's `main` field (false for Responses)
and add `strong_model`, the originally requested model used by the estimate. The `lowered` field was removed with the
reasoning lever. Failed Luna attempts are logged separately from their Sol fallbacks. Responses records mark observed
success with `completed: true`. A pre-completion stream failure has an `error`; a disconnect after a terminal event
does not produce a second record or revise its timing or cost.
Side-call records store **judge answers and note text, truncated to 2,000 characters**, plus v12's `error_body` (the first
300 bytes of a non-200 side response). It does not record authorization headers or raw request transcripts; error bodies
can contain provider-returned text. Set `CCSAVE_LOG_TEXT=0` to omit `text` and `error_body`; usage and metadata remain.
The separate `.state` file still needs notes and briefs for continuity, along with counters, conversation keys and
history/instruction fingerprints, the tool definition prefix used for compaction, and failed-request identities and their note ranges. It does not persist full request bodies or headers. `CCSAVE_LOG_TEXT=0` does not remove those state contents.

### Savings estimate

The exit estimate is Luna's successful work priced at the original strong model's rates, minus Luna's actual cost and
all judge and note costs, including reported billed usage on failed calls. Only successful Luna responses receive
counterfactual strong-model credit: HTTP 200 **and** an SSE `response.completed` or a JSON object with `status: "completed"`.
Successful work is logged once with its terminal usage before delivery, without waiting for HTTP EOF. Partial usage is
used only for billed failures. When inspecting older records without a completion flag, the estimate charges reported
usage but awards no strong-model credit. The label uses the configured models’ IDs from the log. Cached input is counted
once at the cache-read rate, and output includes any reasoning tokens
reported in the API's output usage. Negative savings are shown when overhead exceeds the saving.
It covers only the current launch's records, even when a log is reused. Unknown prices or missing successful-call usage
produce “unavailable”, not a zero estimate. Failed calls without reported usage are treated as unbilled. For a pre-relay HTTP fallback, collection of error-body usage is limited to 64 KiB and a quarter-second read window; a missing or unfinished body can therefore understate cost.

`savings.py` has a small list-price table (USD per million tokens: input / cached input / output):

| Model | Up to 272k input | Above 272k input |
|---|---|---|
| `gpt-6.1-sol` | 2 / 0.1 / 10 | 4 / 0.2 / 15 |
| `gpt-6.2-sol` | 2 / 0.1 / 10 | 4 / 0.2 / 15 |
| `gpt-6-luna` | 0.1 / 0.01 / 0.5 | 0.2 / 0.01 / 0.75 |

These are standard list prices recorded on 2026-11-15 (`gpt-6.2-sol` on 2026-11-18), documented in
the measured GPT experiment (folder `experiments/sol-pi-v2-e160-gpt` at tag `solpi-v2-evaluated` in the team's internal repository). They are an offline snapshot, **not verified current
OpenAI prices**. Set `CCSAVE_PRICES` to the provider's applicable list rates; consult its current pricing documentation
before interpreting the estimate. An override is JSON mapping model IDs to `[input, cached_input, output]` (all context
sizes), or to two such rows for the normal and above-272k rates. Exact model IDs are checked first, then the final
slash-separated component. For example:

```sh
export CCSAVE_PRICES='{"gpt-6.1-sol":[2,0.1,10],"gpt-6-luna":[0.1,0.01,0.5]}'
```

This is a token-price estimate, not a counterfactual bill: Sol might have taken different steps or produced different
output. It does not estimate savings from compaction or notes shortening later Sol contexts, or the cost/benefit of
keep-warm pings. Discounts, service tiers, and requests interrupted before usage arrives are not reliably priced.

### Manual startup

For a persistent custom provider, put the following in Codex's configuration, substituting the proxy's actual port
(or override `model_providers.solpi.base_url` on the command line). Use your own `OPENAI_API_KEY` in the environment.

```toml
model = "gpt-6.1-sol"
model_provider = "solpi"
model_reasoning_effort = "xhigh"

[model_providers.solpi]
name = "SoL-Pi"
base_url = "http://127.0.0.1:PORT/v1"
wire_api = "responses"
env_key = "OPENAI_API_KEY"
```

A bash example with explicit proxy lifecycle (the launcher above handles this for you):

```bash
D=/path/to/SoL-Pi/v2/codex
R=$(mktemp -d)
export CCSAVE_UPSTREAM=https://api.openai.com
export CCSAVE_LOG="$R/ccsave.jsonl" CCSAVE_PORT_FILE="$R/port"
python3 -I "$D/ccsave.py" &
proxy_pid=$!
trap 'kill "$proxy_pid" 2>/dev/null; wait "$proxy_pid" 2>/dev/null' EXIT
for ((i=0; i<100; i++)); do
    [[ -s "$R/port" ]] && break
    kill -0 "$proxy_pid" 2>/dev/null || break
    sleep 0.1
done
[[ -s "$R/port" ]] || exit 1
port=$(cat "$R/port")
codex -c "model_providers.solpi.base_url=\"http://127.0.0.1:$port/v1\""
```

## Changes since the measured version (v12)

These changes have **not been re-measured**. The evaluated source is commit `f391b4b`, tag `solpi-v2-evaluated`, in the team's internal repository.

### Can change benchmark results

These include normal requests, resumes, restarts, compaction, return judgements and failed requests, as well as optional
configuration and logging used by a run.

- Remove the routine-step reasoning downgrade and its `lowered` log field. Keep the guidelines and the keep-warm ping’s trailing low-effort item.
- Guard approvals and active stints against changed user/developer content and top-level instructions. Recognize role-bearing messages without `type`, keep new instructions visible outside notes, and bind an outstanding judgement to the state, generation and instructions it judged, not its former key. Appended bare continues retain v12 routing.
- Give the return judge the original stint brief. Only accept judge/note text from a completed HTTP-200 Responses object. A failed return judge gives work back on the next request; a failed hand-off judge does not switch.
- Match new keys by the full content prefix plus top-level instructions, not a tail position. Include text, images, files, tool definitions, reasoning summaries, encrypted/compaction payloads and reference targets. Normalize replay metadata and call IDs without losing which call produced each result. Only unambiguous ordinary adoption moves the routing lock. Older incompatible state starts fresh, including counters. Keep v12’s same-key head-edit behavior and per-key keep-warm ownership.
- Serialize ordinary routing during note writing. Before writing or using a note, verify the range digest. Keep raw revised evidence and keep a call if a later result still names it. Retry failed notes up to three times per matching range across restarts. Notes can still render with hand-offs disabled; close the active interval before recording Sol work in that mode.
- Persist the tool prefix for first-request compaction after restart. Return active compactions to Sol with the note, re-arm the quick judge, and keep v12’s return-reason precedence. Compaction alone does not cancel a pending approval.
- Before relay, Luna 401/403/429/5xx or connection failures fall back to Sol; a relayed failure such as 408 reserves Sol before the headers leave the proxy. Bound the fallback error-body read and the failure-path note wait separately. Use the issuing stint’s accepted history for its note and the failed request’s own prefix for fallback; if the note is late, send the raw range and keep writing it. An exact retry stays on Sol without rewinding a newer stint; its continuation is not reserved.
- Negotiate identity encoding and inspect SSE events or JSON while forwarding original body bytes. Accept CR, LF and CRLF across reads, deflate and concatenated gzip members. Finalize main responses and complete judge/note objects without waiting for HTTP EOF. Credit only observed successful work. Preserve broken downstream framing on transport failure, even after a completed event. Close upstream connections per request.
- Require and validate an explicit HTTP(S) upstream, including the port. Use the standard cheap-model file by default; an environment override wins, including an empty value disabling hand-offs. Add optional log text suppression and `strong_model`/failed-attempt accounting; keep the `main` and side `error_body` fields.
- Add the isolated per-process launcher and project-keyed private records outside the checkout. Refuse unsafe paths and atomically replace state. Place provider defaults at the invoked command level, before user overrides. Preserve Codex’s umask and job control, avoid duplicate foreground INT, honor ignored HUP, rescan surviving descendants, and choose signal status after cleanup. Estimate this launch’s token-price difference with configured model labels, price overrides and reported billed failures.

### Other changes

- Remove unused Claude Code `/messages` handling and move the historical header changelog to `HISTORY.md`.
- Compute Sol’s transformed view once per request; do not rewrite note state when no retry is pending.
- Consolidate offline tests into one proxy suite and one launcher/estimate suite. Use an explicit mock model, a state fixture and a reproducible body-for-body replay against `f391b4b`, and bounded waits for expected persisted judge transitions independent of text logging.
- Separate internal gateway instructions into the team's internal repository; update usage, pricing limits, compatibility and source hashes here.

## Known limitations

- If several saved conversations match a new key but only one reserved the failed request, its reservation can win. Sol may receive that conversation’s note instead of the raw evidence.
- Only the exact failed request is reserved for Sol. If a newer Luna stint exists, the request after Sol’s retry can go to Luna and its note can include Sol’s work.
- Replacing the last message is not the same as appending one. Replaying `Continue.` as `continue` and adding a tool step can leave Luna working where v12 would return to Sol.
- Inserting an instruction earlier in history can shift the saved positions. The proxy can discard the active stint without a note and send its raw work to Sol.
- The estimate’s label lists every observed strong model, even one used only on a strong-model request. That name can appear although its prices did not enter the dollar amount.
- Command-level provider placement targets the commands listed under Use. On another Codex subcommand, a local `-c` can discard the launcher’s provider settings; check the displayed provider before sending a task.
- Cleanup can track only descendants it observes. A helper that forks and reparents between scans can survive the launcher.

## Checks and limits

- From this directory: `python3 test_proxy.py` (75 tests), `python3 test_launcher.py` (28 tests), or `python3 -m unittest discover -v` (103 together). For inherited signals, also run in noninteractive Bash with `& pid=$!; wait "$pid"`. `python3 fixtures/replay_v12.py` compares all 31 routed requests and 13 side calls against `f391b4b` (it needs that commit of the team's internal repository and reports "skipped" without it). These checks use only loopback mocks and a stub Codex, without a key.
- A cluster smoke test with real Codex CLI 0.162.1 on the previous revision, **without** a subcommand-level `-c`, saw 11 Sol and 7 Luna requests, all HTTP 200. The judge approved, the resumed `Continue working.` ended the stint with a note, and the launcher printed its estimate. A subcommand-level `-c` exposed the provider bug fixed here. The release changes were tested offline, not against a live API; the smoke test is not a benchmark remeasurement.
- The historical 11-09 smoke ran Codex 0.162.0 through v12 with a stop hook and a judge every three calls: three Sol
  requests, ten Luna requests, correct result, no proxy errors. It did not exercise a return.
- Sol and Luna responses stream through as they arrive, including completion before HTTP EOF. A response that has
  already reached Codex cannot be replaced by a Sol response; failures before completion instead reserve Codex’s retry for Sol.
- Counts and notes survive in a process-exclusive state file; keep-warm request bodies and in-flight judges do not.
  The proxy handles Codex histories sent in `input`, not server-side continuation using only a response ID.
- The measured setup had one runner and one run per task. The all-39-task score reading still had Lean judging open.

## Files

Current source hashes (the evaluated hashes remain available at `f391b4b` in the team's internal repository):

| File | sha256 |
|---|---|
| `ccsave.py` | `5f1a33e2357627f5053cb83ea861411bb36454c5863d44e9ae7971d2b36deff4` |
| `cheap-model.txt` | `efa699956dcbbd3079e1eec7674ca75f524ca7591ab0291d5e95ca2a603c9e97` |
| `codex-solpi` | `69022814bd336c783d666df515e93dc4889b0513c71cb33eb4d7539130a9083f` |
| `records.py` | `5e5bbb718674ef3ebcf0a6430bad75a99b2c64a62fb481c6c79263a7ad3e1943` |
| `savings.py` | `66464766f5803122c2928684663391e7571456c9d1d8ddb0f8fac96018a41284` |
| `test_proxy.py` | `277ceed4f4da4a419bec81495b75996816ed06d0c72c269b2a1d1d9d033850ed` |
| `test_launcher.py` | `47ba0135e46772d9f4001b3eb8d32648d73c62438ad94a448c8bc8c7df03e6d5` |
| `HISTORY.md` | `6554a73b84e11bc3dcb6332bd5114294959bd35df7ecec4752aecb7e44e4dde9` |
| `fixtures/v12.state` | `ec7a088c24336e91375c5b20986c1a254dc9ba04809d243ecb37dd0dd6bd9229` |
| `fixtures/replay_v12.py` | `2c293244e35bb026a83b5c0ca2420c84e46c2bc9794e76ded448972be33f5272` |
