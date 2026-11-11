---
name: sol-pi
description: Run the given prompt with SoL-Pi instead of Claude, passing this Claude Code session as prefix context
argument-hint: "[-m provider/model] [-t low|medium|high|xhigh] <task>"
disable-model-invocation: true
allowed-tools: Bash(sol-pi-run:*) Bash(sol-pi-context:*) Bash(git diff:*) Bash(git status:*) Write
---

# Hand this prompt to SoL-Pi

Normally the plugin's hook handles `/sol-pi` before you see it. You are reading
this because that hook did not run (hooks disabled, or `sol-pi-run` not on PATH);
do the hand-off yourself as below, and at the end mention that the hook path is
not active.

The user wants SoL-Pi to execute the request below, not you. SoL-Pi is a separate
coding agent (Pi with SoL-Pi's four token-efficiency mechanisms). It will receive
this conversation as prefix context, so do not restate the background for it.

Request: $ARGUMENTS

Session: ${CLAUDE_SESSION_ID}

SoL-Pi status: !`sol-pi-run doctor --json | python3 -c "import json,sys; d=json.load(sys.stdin); print('ready' if d['ok'] else 'NOT READY: ' + '; '.join(c['check'] + ' - ' + c['detail'] for c in d['checks'] if not c['ok']))"`

## Steps

1. If the status above is not `ready`, run `sol-pi-run setup`, then stop and report if it still fails.
2. Split the request into options and task. Leading `-m <model>` and `-t <effort>` are options for
   SoL-Pi; everything else is the task. If no task text remains, ask the user for one and stop.
3. Write the task text exactly as the user wrote it (no rewording, no added context) to
   `/tmp/sol-pi-task-${CLAUDE_SESSION_ID}.md` with the Write tool.
4. Start SoL-Pi in the current working directory, with this session as prefix context:

   ```bash
   sol-pi-run start --with-session --session-from ${CLAUDE_SESSION_ID} [-m MODEL] [-t EFFORT] --task-file /tmp/sol-pi-task-${CLAUDE_SESSION_ID}.md
   ```

   It prints a run id. Then wait for it (the Bash tool's limit is 10 minutes per call, so wait in
   rounds and repeat the same command until it exits with a code other than 3):

   ```bash
   sol-pi-run wait <run-id> --timeout 540
   ```

5. Do not do the task yourself while SoL-Pi runs, and do not edit the files it is working on.
6. When it finishes, check `git status` / `git diff` for what SoL-Pi changed (skip if not a git repo).
7. Report to the user in their language, briefly:
   - SoL-Pi's final answer (summarised if long),
   - what files it changed,
   - the first `[sol-pi]` summary line (status, model, time, cost; cost uses the prices in the
     user's Pi model definitions and is $0 for a model without prices) and the run id.
   If the run failed, show the error line and suggest rerunning; provider 429/503 errors are
   transient. Do not silently redo the task yourself unless the user asks.
