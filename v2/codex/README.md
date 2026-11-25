# SoL-Pi v2 for Codex: model switching proxy (Responses proxy)

A local proxy between the Codex CLI and an OpenAI Responses API provider. Python 3.8+ standard library only. Codex runs GPT-6.1 Sol at
`xhigh` by default. A judge can hand execution of an existing plan to GPT-6 Luna and return it to Sol when the work needs a new decision. Codex still owns the underlying conversation; the proxy changes the view sent upstream. The results below were measured on an earlier revision, v12; this folder includes later fixes, which have not been re-measured.

## Measured

2-hour runs on the 39 held-out EdgeBench tasks, against plain Codex (the same Codex, model and reasoning level, without
the proxy) run the same day. 90% intervals over tasks. The savings reflect the gateway rates used in the evaluation;
end-to-end testing on the official OpenAI API is still outstanding.

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

- **Codex CLI:** 0.162.0 with GPT-6.1 Sol, `model_reasoning_effort = "xhigh"`,
  `codex exec ... --dangerously-bypass-approvals-and-sandbox`; the runner restarts Codex (and the
  proxy) when it stops before the 2 hours.
- **Proxy:** one proxy per Codex process, started before it, with `CCSAVE_LOG` beside Codex's sessions.

## What it does

| Area | Mechanism |
|---|---|
| Hand-off judge | At the default cadence of 10 counts, Luna reads the task and the recent work as a judge and decides whether the next steps only carry out what is already decided (running and checking experiments, variants of a change that works, an established fix). Design, unclear failures and proofs stay with Sol. After a return, the first eligible request carrying Sol’s work can trigger a new judgement, without waiting for another full cadence. |
| Stint | On approval the conversation's next request goes to Luna only if its user and developer instructions still match the judged state, with the judge's reason as its brief: carry those steps out and end the turn with a short report once they are done, or as soon as the next step needs a new decision. A subsequent user or developer message gives the work back. |
| Way back | The return judge sees the original brief and checks whether Luna is stuck or the next step needs Sol. An appended user/developer message or a compaction ends the stint. A failed return judge gives work back on the next request; a failed hand-off judge leaves Sol in charge. On Luna 401/403/429/5xx or a connection failure before relay, the proxy sends the same request to Sol. A 408 is relayed, but the proxy reserves Sol for the retry before Codex sees the headers. A failed stream also reserves its retry; a transport error after completion does not undo the work. |
| Hand-back note | Luna writes a note from its steps (done, state, open, unverified). The note replaces only a range whose content still matches. Instructions and calls needed by later tool results stay visible. Unnoted or revised evidence stays raw and can enter Sol’s cache. The proxy attempts a note at most three times per matching range across restarts. A shorter failed prefix can need its own note. Sol waits up to 60 seconds for note writing at hand-back and a quarter second on a failure retry; a late note is saved for later matching requests. |
| Keep-warm | While Luna works, the proxy periodically re-sends Sol’s last request for that key, asking for “ok”, to keep the prefix eligible for cache hits. The default interval is 270 seconds; pings stop after an hour away. Key adoption discards the old key’s keep-warm request. |
| Compaction cache | Codex can omit the leading `additional_tools` item when asking for a summary. The proxy restores a recognized prefix and sets `tool_choice` to `none`, so the provider can reuse its cached history. A compaction during a stint gives the work back to Sol, which receives the note if one is available. |
| Guidelines | One developer message after Codex's instructions: batch independent reads; keep reasoning short on routine steps. |
| State | Stints and counts are kept in `<CCSAVE_LOG>.state`. A new key normally needs an unambiguous match of the whole historical prefix and top-level instructions to adopt a state. Failed-request reservations are an exception (see Known limitations). State files written by older versions, including the measured one, start fresh, counters included. An edit under the same key can retain notes for unchanged ranges. |

Each eligible non-compaction request counts newly observed tool calls (including calls inside code-mode scripts), **at least one count per eligible request**, even when no tool ran. Reserved retries do not advance the judge. An outstanding judge is not duplicated.

A bare continue is a user message whose entire text, ignoring case, whitespace and final punctuation, is “continue”,
“continue working”, “keep going”, “go on” or “proceed”, with no image/file content. When appended, it may consume a pending
hand-off approval, and it ends an already running stint. Other new user/developer instructions invalidate an approval
or end a running stint with its note. The instruction guard also covers top-level `instructions` and nontext content.
Compaction alone preserves a pending approval; a compaction carrying new instructions drops it.

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
The default model is `gpt-6.1-sol` at `xhigh`; pass `-m MODEL` or a reasoning configuration override to change it.
Codex 0.162.1 drops root-level `-c` settings when a subcommand supplies its own. The launcher puts its defaults immediately
after `exec`/`e`, `exec resume`, `exec review`, `resume` or `review` (first for interactive use), before your overrides and
before `--`. For example, `exec -c 'model_reasoning_effort="high"' -- '-literal prompt'` keeps the proxy. An explicit
override of the provider or its URL can still bypass it.

- `CCSAVE_UPSTREAM` is required, including for manual startup: the API origin without `/v1`. Missing or empty means
  startup fails. There is no default upstream.
- `CCSAVE_CHEAP_MODEL` wins over `cheap-model.txt` whenever it is set. `CCSAVE_CHEAP_MODEL=''` disables hand-offs,
  judges and new note calls. Matching notes still render; a running Luna interval closes before the first ordinary disabled Sol request. Unwritten notes can be attempted when hand-offs are enabled again. When unset, the file supplies `gpt-6-luna`. No official model catalog was checked;
  this keeps the fallback identifier, without claiming verified OpenAI availability.
- The launcher creates a unique log under `$XDG_STATE_HOME/sol-pi-v2/<project-hash>/` (default `~/.local/state/sol-pi-v2/<project-hash>/`). The hash is SHA-256 of the absolute working-directory path. Keep this state root outside the checkout. New records directories and files are created with modes 0700 and 0600 respectively, subject to the caller’s umask.
- Set `CCSAVE_LOG` to a stable, process-exclusive file to reuse its adjacent `.state` on restart. Use a trusted directory and regular, user-owned files; ancestor symlinks are resolved, but symlinked records directories, symlinked files and multiply linked files are refused. The directory that holds the records must be yours and not writable by others; above it, only other users' directories and world-writable ones without the sticky bit are refused, so a group-writable shared project tree works. Existing permissions are **not** changed: an explicitly supplied readable log stays readable. State is replaced atomically from an exclusively created random temporary file. Do not share a log between live proxies.
- `CCSAVE_PORT` selects a fixed port instead of a free one; leave it unset for multiple sessions.
  `CCSAVE_PORT_FILE` is for manual startup; the launcher always owns a unique temporary port file.
- `CCSAVE_JUDGE_EVERY` defaults to 10 counts; `CCSAVE_PING_S` defaults to 270 seconds, and `0` turns keep-warm off.
- `CCSAVE_PROVIDER` and `CCSAVE_ENV_KEY` can rename the launcher's provider and key environment variable.
  Defaults are `solpi` and `OPENAI_API_KEY`. The launcher reads no key value into its arguments.

### Log contents

The JSONL log stores request/ping/side-call model IDs, usage, status or error class, timing, request paths,
compaction flags, switches and fallback reasons. Request records keep the `main` field of older logs (always false for
Responses) and add `strong_model`, the originally requested model used by the estimate. The `lowered` field was removed with the
reasoning lever. Failed Luna attempts are logged separately from their Sol fallbacks. Responses records mark observed
success with `completed: true`. A pre-completion stream failure has an `error`; a disconnect after a terminal event
does not produce a second record or revise its timing or cost.
Side-call records store **judge answers and note text, truncated to 2,000 characters**, plus `error_body` (the first
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

These are standard list prices recorded on 2026-11-15 (`gpt-6.2-sol` on 2026-11-18). They are an offline snapshot, **not verified current
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

## Known limitations

- If several saved conversations match a new key but only one reserved the failed request, its reservation can win. Sol may receive that conversation’s note instead of the raw evidence.
- Only the exact failed request is reserved for Sol. If a newer Luna stint exists, the request after Sol’s retry can go to Luna and its note can include Sol’s work.
- Replacing the last message is not the same as appending one. Replaying `Continue.` as `continue` and adding a tool step can leave Luna working where the measured version would return the work to Sol.
- Inserting an instruction earlier in history can shift the saved positions. The proxy can discard the active stint without a note and send its raw work to Sol.
- The estimate’s label lists every observed strong model, even one used only on a strong-model request. That name can appear although its prices did not enter the dollar amount.
- Command-level provider placement targets the commands listed under Use. On another Codex subcommand, a local `-c` can discard the launcher’s provider settings; check the displayed provider before sending a task.
- Cleanup can track only descendants it observes. A helper that forks and reparents between scans can survive the launcher.

## Checks and limits

- From this directory: `python3 test_proxy.py` (76 tests), `python3 test_launcher.py` (28 tests), or `python3 -m unittest discover -v` (104 together). For inherited signals, also run in noninteractive Bash with `& pid=$!; wait "$pid"`. These checks use only loopback mocks and a stub Codex, without a key.
- The release changes were tested offline, not against a live API.
- Sol and Luna responses stream through as they arrive, including completion before HTTP EOF. A response that has
  already reached Codex cannot be replaced by a Sol response; failures before completion instead reserve Codex’s retry for Sol.
- Counts and notes survive in a process-exclusive state file; keep-warm request bodies and in-flight judges do not.
  The proxy handles Codex histories sent in `input`, not server-side continuation using only a response ID.
- The measured setup had one runner and one run per task. The all-39-task score reading still had Lean judging open.
