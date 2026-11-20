# Codex proxy history

The evaluated v12 is commit `f391b4b` (tag `solpi-v2-evaluated`). It included the
routine-step reasoning lever; the current version removes it and the Claude Code path.
The historical cache claim below applied only when a note succeeded.
## GPT-6.2 Sol — 2026-11-19

`savings.py` prices `gpt-6.2-sol` like `gpt-6.1-sol` (list price recorded 2026-11-18). Checked on five small coding tasks: all five passed their tests on the first try in both arms, and the proxy cost 22% less than plain Codex ($0.82 against $1.05; one run per task, so a working check rather than a measurement).


Keep-warm proxy for Claude Code (a SoL-Pi cost lever moved out of Pi; 2026-11-07).

A local HTTP proxy between Claude Code and its gateway: every request passes through unchanged and streams back as it
arrives. Anthropic's prompt cache lives 5 minutes from its last use, so when Claude Code waits longer than that between
two turns (a long foreground command, a sleep) its next request writes the whole context again: in the one-agent Claude
Code runs of 11-06 that was 3.0 rewrites per run and 16% of the bill, after gaps of 5-10 minutes. After 270 s without a
request the proxy sends the newest main-thread request again, unstreamed, with one line appended that asks for "ok": it
reads the cached prefix, which keeps the cache alive, for the price of that read and a few output tokens (gateway probe
11-07: 22,222 tokens read, 128 output). Pings stop with the next request, after an hour without one, or when the process
that started the proxy (the agent's shell) is gone. One JSON line per request and ping (no headers, no content) goes to
CCSAVE_LOG; a ping's line carries its usage, so the run's bill can include it.

Codex (2026-11-08): the same proxy sits between Codex and its gateway (OpenAI Responses API). Codex's compaction request
leaves out the additional_tools item that its other requests start with, so it misses the whole prompt cache and writes
the history again: in the Codex runs of 11-07, 2.2 compactions per run, $1.06 of $7.78. When a request is the
conversation's (prompt_cache_key's) latest request with tools minus that item, the item goes back first and tool_choice
becomes none: the history is read from the cache and the answer is still the summary (gateway probe 11-08: 13,520 of
16,314 tokens read instead of none; real Codex through the proxy finished its task).

Codex hand-off, v2-v7 (2026-11-08): the models decided it through two MCP tools (SoL-Pi E116). In those runs Sol handed off
within minutes and the cheap model then held most of each run until a compaction (Luna 2,700 requests against Sol's
734 over 13 runs), and every return wrote the stint into Sol's cache; v5 (Luna) trailed Codex by 15.7 points, v7 (a mid-size model)
saved nothing at mid-run.

v8 (2026-11-09): SoL-Pi E132's switching (in Pi 55% below plain Pi at -3.0 on 38 held-out tasks), with CCSAVE_CHEAP_MODEL
or cheap-model.txt set. (1) From the configured model's 10th request on, every 10 of its requests, the cheap model reads
the task and the recent work as a judge and decides whether the next steps are routine enough to hand over (E127's rules:
proofs, design and unclear failures stay); on approval the conversation's next request goes to the cheap model, carrying
E125's note to keep working. (2) From the cheap model's 10th request on, every 10, the same judge decides whether the
configured model takes the work back (stuck, results got worse, a proof begins); a user or developer message (the cheap
model's turn end and the stop hook's prompt, a resume, a compaction prompt) also ends the stint. (3) Once a stint is over
the cheap model writes a hand-off note from its steps (done, state, open, unverified), and every later request carries the
note in place of the stint's items, so the configured model keeps its own context and never writes the stint into its
cache (E132); a stint without a note goes as it is. (4) While the cheap model works, the configured model's latest request
is pinged after PING_S without one (v3), so its cache is warm when the work comes back. Compactions run on the configured
model with the notes in place of the stints. The stints and counts are kept beside the log (CCSAVE_LOG + ".state"): the
runner restarts Codex, and the proxy with it, in half of the runs. No tool is added. Judge and note requests are logged as
kind "side" with their model and usage, pings as kind "ping".

v9 (2026-11-09): the rest of E132's GPT levers. v8 kept the score on its first 4 tasks (-1.7 against the mean of both plain
samples) but saved 33%: Sol carried 80-99% of each bill. (1) A routine step goes one reasoning level below the configured
level, never below high (E132's lib/effort.js: xhigh -> high), through a trailing configuration_update item, which keeps the
prompt cache: the newest turn called tools, none failed (nor in the turn before), none ran a program (a build, a test, a
script on standard input, or reading a running program's output) and nothing new came to answer. (2) E132's two system
guidelines, as one developer message after Codex's instructions: batch independent reads; keep reasoning short on routine
steps (its third, stop when more work no longer pays, is left out: Codex's stop hook keeps the agent working).

v10 (2026-11-09): the judges' cadence is counted in tool calls, E132's unit. In Pi each of the model's calls is one tool
call; a Codex code-mode script makes several (Sol 1.95 on average over v8's 4,287 scripts, Luna 1.65), so E132's "every 10
calls" became every 10 scripts, about 20 tool calls. In v8 Sol's stretch between two stints was 10 requests in nearly every
cycle (the judge approved at its first check), and Sol carried 80-99% of each bill while the score held (14 tasks: 34%
cheaper, +0.8 against the mean of both plain samples). Each request now adds the tool calls of the scripts that came back
since the previous one (at least 1).

v11 (2026-11-09): the strong model decides, the cheap one carries out. In v10's runs (10 tasks, 48% cheaper than the mean
of both plain samples, -12.2 provisional) Sol's stretches between stints were short (non-Lean median 7 requests, 3 minutes;
v8 10 and 5) and went to checking the hand-off note, as NOTE_HEAD asked, while Luna, told to keep going, went on past the
steps it was given into choices of its own: in one task Sol found the weak points the grader had
reported at its 249th request, Luna took the fixes and the score stayed at 31.2 (plain Codex 38.8-48.8);
in another Luna held the last 45 minutes without a submission. (1) The hand-off judge's reason (the steps already decided) goes
to the cheap model as its brief, in a developer message where its stint begins (its cache prefix holds through the stint),
and its note tells it to carry those steps out and end its turn with a short report once they are done, or as soon as the
next step needs a new decision; its turn end gives the work back (a developer or user message ends a stint). The return
judge also gives the work back once the given steps are done. (2) NOTE_HEAD asks the strong model to look again only at what
its next decision depends on, not to check the whole note first.

v12 (2026-11-09): after the work comes back, the hand-off judge looks again as soon as the strong model has acted on the
report (its first tool call), not after another 10. In v11 Luna ends its turn once its brief is done and the strong model
decides every next step, but the cadence kept it for 10 more tool calls before the judge could look, so Luna held a median
32% of the clock (v10: 54%): the strong model's returns were long even when its decision was only "next, run these". The
judge's rules are unchanged (design, unclear failures and proofs stay with the strong model).
