---
name: sol-pi
description: >-
  Delegate a coding task to SoL-Pi, a token-efficient Pi extension, with all
  four mechanisms enabled (Action Fusion, ObservationPack, Evidence-Preserving
  Reducer, Online Context Compact), and get back its answer, session and cost.
  Use when the user asks to run something "with SoL-Pi" / "用 sol-pi 跑", wants a
  cheaper long-running worker, or wants to compare SoL-Pi against this agent.
---

# SoL-Pi

`sol-pi-run` (on PATH, from the repository's `examples/sol-pi-skill/bin/`) runs a
task with SoL-Pi from that checkout, loaded into the Pi release its `package.json`
pins, in its own Pi agent directory (`~/.sol-pi/agent`). Models and logins come
from the user's own Pi (`~/.pi/agent/models.json` and `auth.json`, linked, not
changed).

## Before the first task

```bash
sol-pi-run doctor          # all lines must be [ok]; no model call
```

If anything fails, run `sol-pi-run setup` (installs the pinned Pi, runs the
checkout's test suite, registers it, writes the all-enabled config), then
`doctor` again. Do not edit `~/.sol-pi/agent/sol-pi.json` by hand.

## Hand-off: the user's message starts with `$sol-pi` (or `/sol-pi`)

With `codex-hooks/hooks.json` installed, a prompt hook handles this before the
model runs. If you are reading this for such a message, that hook did not run;
do the hand-off yourself as below and mention that the hook path is not active.

The user wants SoL-Pi, not you, to execute the rest of that message, continuing
from this conversation. Do this and nothing else:

1. Leading `-m <model>` / `-t <effort>` are options; the remaining text is the task.
   If no task text remains, ask for one.
2. Write the task text exactly as the user wrote it to a temp file (for example
   `/tmp/sol-pi-task-$CODEX_THREAD_ID.md`); do not reword it or add background.
3. Start it with this session as prefix context, from the current directory:

   ```bash
   sol-pi-run start --with-session [-m MODEL] [-t EFFORT] --task-file /tmp/sol-pi-task-<id>.md
   sol-pi-run wait <run-id> --timeout 540     # repeat while it exits with code 3
   ```

   `--with-session` finds the calling session itself (Codex: `CODEX_THREAD_ID` +
   `CODEX_HOME`; Claude Code: `CLAUDE_CODE_SESSION_ID`). It exports the
   conversation since the latest compaction, drops the `$sol-pi` request itself,
   and puts it in front of the task. `sol-pi-context` prints the same export.
4. Do not work on the task yourself while SoL-Pi runs. When it finishes, check
   `git status` / `git diff` and report SoL-Pi's answer, changed files, the first
   `[sol-pi]` summary line and the run id.
5. If the result looks wrong, report that and what you saw; do not fix it
   yourself or start another run with a reworded task. If SoL-Pi seems to have
   had the wrong context, run `sol-pi-context | head -20` and report which
   session it exported.

## Run a task

For delegating a self-contained subtask of your own (no conversation context).
Run from the directory the task should operate in, or pass `--cwd`.

```bash
sol-pi-run run -- "fix the failing test in tests/test_io.py and run the suite"
sol-pi-run run -m provider/model -t medium --cwd /path/to/repo -- "task"
sol-pi-run run --task-file /tmp/task.md          # long or multi-line tasks
```

The first lines of output are a summary (status, model, seconds, turns, cost,
token counts, how often each SoL-Pi mechanism fired, run id, session file). The
model's final reply follows. Add `--json` for machine-readable output. Exit code
is 0 only when the run finished normally.

SoL-Pi edits files in place and runs shell commands with the user's
permissions. It has no sandbox. Only delegate tasks the user would let you do
yourself in that directory, and review `git diff` afterwards.

### Running from a sandboxed agent (Codex)

SoL-Pi calls the model provider over the network, so the command needs network
access. In Codex `workspace-write` the network is off by default: request
escalated permissions for `sol-pi-run run|start|doctor --live` (or the user can
start Codex with `-c sandbox_workspace_write.network_access=true`). If
`~/.sol-pi` is not writable, `sol-pi-run` copies its config into
`$TMPDIR/sol-pi-<uid>/` and keeps run records there; `doctor` prints which
directory it uses. A provider error such as `fetch failed` or `ENOTFOUND` in the
summary usually means the network was blocked, not that SoL-Pi is broken.

## Long tasks

Tasks that may take more than a few minutes should run in the background:

```bash
id=$(sol-pi-run start -- "task")   # prints a run id immediately
sol-pi-run status "$id"            # running / done / failed, turns, cost so far, last tool
sol-pi-run wait "$id" --timeout 1800
sol-pi-run result "$id"
sol-pi-run list                    # recent runs
```

Default timeout is 7200 s (`--timeout 0` disables it). Each run keeps
`~/.sol-pi/runs/<id>/` with `events.jsonl`, `stderr.log`, `result.json`, and the Pi
session (which also holds the SoL-Pi archives).

## Models

`-m` takes a `provider/model` as listed by `sol-pi-run models`. Without `-m`,
SoL-Pi uses `SOL_PI_MODEL`, else the default model in the user's Pi settings.
`-t` sets effort: off, minimal, low, medium, high (default), xhigh, max.
The Evidence-Preserving Reducer uses SoL-Pi's built-in route unless setup was
run with `--reducer provider/model`. `sol-pi-run models` prints both.

If a model has no credentials, the user sets it up in their own Pi (`pi`, then
`/login`, or `~/.pi/agent/models.json`); do not write credentials yourself.

## Reporting back

Tell the user what SoL-Pi changed (check `git diff`), whether it verified the
result, and the cost line from the summary. The cost covers the main model and
the reducer at the prices in the user's Pi model definitions; a model without
prices counts as $0.

If a run fails with 429/503 from the provider, rerun it.

`sol-pi-run tui` opens the SoL-Pi terminal UI for the user to drive directly.
Do not start it from inside an agent session.
