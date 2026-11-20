# Claude Code proxy history

Measured version: v23, commit `f391b4b` (`solpi-v2-evaluated`).

Claude Code switching proxy, ccsave v23 (2026-11-12): Opus 5.5 hands routine stretches to Haiku 5.5 and implementation
stretches to Sonnet 5.5, judged by Haiku 5.5; nothing is compressed.

v23: v21 with waiting kept off the cheaper model while other parts of the task are open. The hand-off judge keeps the strong
model when the next step only waits for a running job (a submission, an evaluation, a long run) while other parts still need
design or new code, and the return judge gives the work back when the cheaper model is only waiting while such parts remain.
In v21 a session is one agent, so a stint that waits for a job holds the whole session: on two tasks (a
partitioning problem in v21a and v21b, a reimplementation in v21b) the cheaper model waited on submissions for 20-30 minutes at a time while
the subproblems or the optimization still to do went untouched, and those runs lost 25-51 points.

v21: v19 with the way back judged by the hand-off's own rule (SoL-Pi E154's change on Pi): the return judge, every 10 of the
cheap model's calls and at each of its turn ends, also gives the work back when the next step needs the hard reasoning the
hand-off keeps on Opus (designing or choosing an approach, a new algorithm or component, a non-trivial refactor, debugging
an unclear failure, careful correctness or performance reasoning), not only when the cheap model is stuck, got worse or
starts a proof. Against the same-time control v19 was 55% cheaper at -3.7 points (35 tasks); its largest loss,
on one algorithm task (-73; v14 -56, v17 -59), came from a cheap model that, after checking a solved subproblem, designed the
next ones itself while the return judge kept it for its progress.

v19: v18 with a second, stronger cheap model. The hand-off judge also approves implementation: code written or changed to a
design or plan already decided, a failure whose cause is already clear, tests for specified behaviour. It says which kind
the next steps are, and implementation goes to Sonnet 5.5 (mid-model.txt), routine steps to Haiku. In v17's first 80
judgements refused outside proof tasks, 12 were implementation and about half of the 26 debugging ones had a clear cause:
work Haiku does badly and Opus need not do. Opus keeps design, unclear failures, new algorithms and proofs.

v18: v17 with the hand-off judge asked every 5 of Opus's tool calls instead of 10; the return judge stays at 10. In v17's
first 45 minutes the judge approved 21 of 105 judgements and the cheap model made 11% of the main requests: its refusals
were real design, debugging and implementation work, so a routine stretch is short and a judge every 10 calls catches it
late or not at all.

v17: v14's judges with three changes, from v14's and v15's runs against one-agent Claude Code (non-proof tasks lost 0.6-1.8
points; proof tasks with stints lost 21-26; Haiku's work cost $0.04 a run):
1. A stint goes on past the cheap model's turn end when the return judge, asked at once, keeps it. In v14 and v15 a stint
   took 4-5 cheap requests (median 4) and ended at the cheap model's first report, so the cheap model made only 9-15% of the
   main requests.
2. A formal-proof task stays on Opus: the hand-off judge also says whether the task is formal proof work (Lean, Coq, Isabelle
   or another proof assistant); once it says so, no hand-off is asked again.
3. v15's rule that keeps Opus through waits is dropped (it cut the hand-offs to a third without a score gain), and a
   rate-limited Haiku request is sent again after 3, 10 and 30 seconds.
Haiku takes the stints again (v16 gave them to Sonnet, at half of Opus's price per token).

v16: v15 with Sonnet 5.5 as the model that takes the stints.

v15: v14 with Haiku's rate limits retried. In v14's 39 runs (first 80 minutes) the gateway rate-limited Haiku (HTTP
429) on 53 of 107 stints, which went back to Opus at once, and on 103 of 498
judge and note requests, which then gave no decision. A rate-limited request to Haiku is now sent again after RETRY_S
seconds (each wait longer), and only then does the stint go back to Opus; a judge or note request likewise.
And the judges keep Opus through a wait while work is open: v14's largest losses (three tasks at -47, -43
and -38 against one-agent Claude Code) came from late stints that only waited 20-60 minutes for builds and
evaluations while unproven goals or untried optimisations remained, work that one-agent Claude Code's Opus does during the
wait.

Design decision (2026-11-05, kept on 11-10): no compression in the harness (the vendors build it into their models); the
saving comes from switching between the big and the small model, and when the work comes back to the big model the small
model's low-quality thinking is dropped. Versions 1-13 of this proxy ran with Claude Code's compaction window cut to 200k
and sent single routine steps to the cheaper model. v14 leaves Claude Code's window as it is (auto, as in one-agent Claude
Code) and ports the hand-off of the Codex plugin v12 (SoL-Pi E132; in Pi, Opus with Haiku, E154, was 42.7% cheaper than
plain Pi at -2.1):

1. Every JUDGE_EVERY of Opus's tool calls, Haiku reads the task and the recent work as a judge and decides whether the next
   steps only carry out what is already decided (E132's rules: design, unclear failures and proofs stay with Opus). On
   approval Claude Code's next request goes to Haiku.
2. Haiku works from its own view: Claude Code's first message (the task), then one message with the judge's reason as its
   brief and the recent work as a transcript, then its own steps. Opus's context is left as it is: Haiku cannot take it
   whole.
3. Every RETURN_EVERY of Haiku's tool calls the return judge decides whether Opus takes the work back. Haiku's turn end (the
   stop hook's "Do not stop" comes back as a user message), any other new user text, a compaction, or a request the
   gateway rejects or rate-limits for Haiku (HTTP 429) also ends
   the stint, and that request goes to Opus.
4. The stint's steps never reach Opus: Haiku writes a hand-off note from them, and every later request to Opus carries the
   note in their place, so Opus keeps its own context and its own thinking (no note: the steps as a transcript). Opus's
   cache is kept warm while Haiku works, and its first request back marks where its previous request ended (v12's bridge).
5. Back from a stint, the hand-off judge looks again after Opus's first tool call (Codex v12).

Keep-warm as in v1: after PING_S without a request, Opus's newest request is sent again with an "ok" line, which keeps
Anthropic's 5-minute prompt cache alive. The JSON log includes model/usage and can include judge/note text and error
bodies. Both CCSAVE_LOG and its `.state` file can contain task content. New records in the revised proxy are private;
check existing files and backups. The state file keeps stints, notes and counts so a restarted proxy can continue.
