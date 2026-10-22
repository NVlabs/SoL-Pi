# SoL-Pi Skill for Claude Code and Codex

This example lets you hand the current prompt to SoL-Pi from inside a Claude Code
or Codex session. SoL-Pi runs this repository's extension with all four
mechanisms enabled, receives the host conversation as prefix context, and reports
back when it finishes.

```text
Claude Code   /sol-pi [-m provider/model] [-t effort] <task>
Codex         $sol-pi [-m provider/model] [-t effort] <task>
Shell         sol-pi-run run [-m provider/model] [-t effort] -- "<task>"
```

With the hooks installed, the host model never processes the hand-off prompt: a
prompt hook starts SoL-Pi in the background and blocks the prompt, and a
background hook reports the result. Without the hooks, the bundled skill does the
same through the host model, which costs a few extra host turns.

## Usage

Requirements: Node.js 22.19+, npm, Python 3.10+, and Pi set up with at least one
model you can use (`pi`, then `/login`, or providers in `~/.pi/agent/models.json`).

From the SoL-Pi repository root:

```bash
# Put the launcher on PATH (the hooks call it by name).
mkdir -p ~/.local/bin
ln -sf "$PWD/examples/sol-pi-skill/bin/sol-pi-run" ~/.local/bin/sol-pi-run
ln -sf "$PWD/examples/sol-pi-skill/bin/sol-pi-context" ~/.local/bin/sol-pi-context

# Install the Pi release pinned in package.json, run this checkout's checks,
# register it, and write the all-enabled sol-pi.json. Then check it.
sol-pi-run setup
sol-pi-run doctor --live      # every line [ok]; --live makes one short model call
```

`setup` follows [agents-install.md](../../agents-install.md): it runs `npm run
check`, `scripts/check-pi-compat.mjs` and `tests/all-mechanisms.test.ts`, and
validates the config with `check-sol-pi-config.mjs --require-all-enabled`.
Everything it creates lives under `~/.sol-pi` (`SOL_PI_HOME` changes it). Your
global `pi` and `~/.pi/agent` are not changed.

### Claude Code

```bash
claude plugin marketplace add "$PWD/examples/sol-pi-skill/claude-plugin"
claude plugin install sol-pi@sol-pi-local --scope user
```

The plugin provides the `/sol-pi` skill and both hooks. A personal skill named
`sol-pi` in `~/.claude/skills` takes precedence over the plugin's; remove it if
you have one.

### Codex

```bash
mkdir -p ~/.agents/skills
ln -sfn "$PWD/examples/sol-pi-skill/codex-skill/sol-pi" ~/.agents/skills/sol-pi
cp examples/sol-pi-skill/codex-hooks/hooks.json ~/.codex/hooks.json   # or merge into an existing one
```

Codex asks you to review new hooks on the next start; trust the two
`sol-pi-run hook` entries. SoL-Pi calls your model provider over the network, so
in the `workspace-write` sandbox start Codex with
`-c sandbox_workspace_write.network_access=true`.

## Models

SoL-Pi uses the models and logins of your own Pi. `sol-pi-run` links
`models.json` and `auth.json` from `~/.pi/agent` (`SOL_PI_USER_PI_DIR` changes
the directory) into its own agent directory, so a provider or `/login` you set up
in Pi works here too.

| Setting | Source |
| --- | --- |
| Main model | `-m provider/model`, else `SOL_PI_MODEL`, else `defaultProvider`/`defaultModel` in your Pi `settings.json`, else Pi's own choice |
| Effort | `-t off\|minimal\|low\|medium\|high\|xhigh\|max`, default `high` |
| Reducer model | SoL-Pi's built-in route; `sol-pi-run setup --reducer provider/model` changes it |

`sol-pi-run models [search]` prints the default model, the reducer, and the
models Pi can use. `doctor` checks that both the default model and the reducer
have credentials. It cannot tell an expired login from a valid one; `doctor
--live` makes a real call.

Costs in the run summary use the prices in your Pi model definitions, for the
main model and for the reducer's nested calls. A model without prices counts as
$0.

## How a hand-off works

1. `sol-pi-run hook submit` (synchronous) recognises `/sol-pi` (Claude Code
   `UserPromptExpansion`) or `$sol-pi` (Codex `UserPromptSubmit`), starts
   `sol-pi-run start --with-session` in the background, and blocks the prompt with
   a one-line notice and the run id. The host model makes no request.
2. `sol-pi-context` exports the conversation since the latest compaction: user and
   assistant text, one-line tool calls, and tool results trimmed to their head and
   tail. Thinking, system prompts and injected skill bodies are left out. The
   export is placed in front of the task; the task text is passed verbatim.
3. `sol-pi-run hook notify` (background) waits for the run and reports status,
   cost, the working-tree changes and SoL-Pi's answer:
   - Claude Code (`asyncRewake`): exits 2, which wakes the session immediately,
     even when idle. The host model then checks the changes and reports, usually
     in one or two turns.
   - Codex (`async`): the report is attached as context to your next prompt;
     Codex has no wake-up for an idle session. `sol-pi-run status <id>` shows
     progress meanwhile.

`sol-pi-run start|status|wait|result|list` work the same from a shell. Each run
keeps `~/.sol-pi/runs/<id>/` with `prompt.md` (exactly what SoL-Pi received),
`events.jsonl`, `stderr.log`, `result.json` and the Pi session.

| Path | Purpose |
| --- | --- |
| `bin/sol-pi-run` | Installs the pinned Pi, registers this checkout, writes the config, runs and summarises tasks, and implements the hooks |
| `bin/sol-pi-context` | Exports a Claude Code or Codex transcript as prefix context |
| `claude-plugin/` | Claude Code marketplace with the `sol-pi` plugin: `/sol-pi` skill and hooks |
| `codex-skill/sol-pi/` | Codex skill (`$sol-pi`, and for delegating subtasks) |
| `codex-hooks/hooks.json` | Codex prompt hooks |
| `probe/sol-pi-probe.ts` | Helper extension: load check for `doctor`, reducer prices for the cost summary (no model call) |
| `tests/` | `python3 -m unittest discover -s examples/sol-pi-skill/tests` |

## Notes

- SoL-Pi edits files and runs commands with your permissions and has no sandbox.
  Hand off only work you would let the host agent do in that directory, and read
  the diff afterwards.
- SoL-Pi never sees the `sol-pi` skill (its managed `settings.json` excludes it),
  and `sol-pi-run` refuses to start inside a SoL-Pi run, so a hand-off cannot
  delegate to itself.
- Inside a sandboxed host that cannot write `~/.sol-pi`, `sol-pi-run` copies the
  config into `$TMPDIR/sol-pi-<uid>/`; `doctor` prints which one it uses.
- Transcript formats are internal to Claude Code and Codex and may change. If an
  export looks wrong, run `sol-pi-context | head` from inside the session.
- Tested with Pi 0.85.1.
