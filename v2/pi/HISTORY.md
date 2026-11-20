# SoL-Pi v2 history

The replay baseline is tag `solpi-v2-evaluated` (commit `f391b4b`). The GPT checkpoint is `experiments/sol-pi-v2-e160-gpt`; the Claude checkpoint is `experiments/sol-pi-v2-e154-opus`. GPT is the measured code. Opus was measured on `c75207d`; the tagged copy includes R1 to avoid rewriting notes across processes. Historical mechanisms below are not a description of the current package; see README.md.

## GPT-6.2 Sol — 2026-11-19

GPT-6.2 Sol pairs with Luna like GPT-6.1 Sol (`lib/summarizer.js`), and the gateway adapter lists it at Sol 6.1's prices and evaluated 272k window. Checked on five small coding tasks: all five passed their tests on the first try in both arms, and SoL-Pi cost 46% less than plain Pi ($0.40 against $0.74; one run per task, so a working check rather than a measurement).

## E160 — 2026-11-13

GPT uses E132 plus R1, with priced compaction disabled. Frequent cuts at 30–70k context tokens caused cache rewrites and file re-reads that consumed the read savings. Pi's own compaction still uses the cheap summary. R2 restores the configured model's call count and last judge decision from the session so restarting a process preserves the cadence.

## R1 — 2026-11-12

Persist hand-back note text in the session and restore it before the first request of a new process. Previously a resumed process regenerated earlier notes in different words, invalidating the cached prefix. Within-process behavior did not change.

## E154 — 2026-11-07

Claude's return judge uses the hand-off judge's list of hard steps: design and approach selection, new algorithms or components, non-trivial refactors, unclear failures, correctness or performance reasoning, and proofs. Progress alone is no longer a reason to retain the cheap model through those steps. GPT retains the narrower return rule: stuck, worse results, or proof work.

## E153 — 2026-11-07

Claude bash commands yield after two minutes, matching Claude Code's default Bash timeout. The previous five-minute interval followed the cache lifetime. This gives the agent control while a long command continues and helps it resume before the prompt cache expires. GPT retained the five-minute interval in that historical candidate.

## E152 — 2026-11-07

Fix package resolution when an extension is imported as native ESM outside Pi's aliases. Resolve Pi from the running executable if the bare import fails. Earlier command yielding and codemode had silently failed to install in that loading path. Enable codemode only for Responses API sessions; Claude keeps Pi's ordinary tools.

## E151 — 2026-11-07

Try Pi's codemode-only interface for GPT: JavaScript scripts call tools, run independent calls concurrently, and print relevant results. Enable the Responses grammar-tool compatibility flag. Background command completion notices attach to the outer result, not a nested call. This interface is not part of the merged package.

## E148 — 2026-11-06

Wrap Pi's bash so commands still running after the cache lifetime continue in the background; append their output and exit status to a later tool result. Short commands return the original Pi result. The experiment addressed runs stalled in a single long command.

## E133 — 2026-11-04

Use the cheap model's hand-back note on Claude as well as GPT. Previously Claude hand-back folded the whole context, including the strong model's own history, into a summary and invalidated its cached prefix. The note replaces only the cheap stint. If no note is available, Claude receives a short notice to check the files.

## E132 — 2026-11-04

Replace each finished cheap GPT stint with a short note written by that cheap model. The strong model receives what changed, observed results, unfinished work, and unverified claims, with an instruction to check the note against files and commands. Pi's session retains the complete steps. Claude initially retained the earlier whole-history fold.

## E127 — 2026-11-04

Add proofs and mathematical arguments to the hard steps retained by the hand-off judge and to the return judge's reasons for bringing the strong model back. Everything else remains E125. A broader GPT return rule trialed in E126 reduced savings and was not retained.

## E125 — 2026-11-03

Add the cheap-model continuation note after the system prompt: keep working toward the task, check each step, and stop only when done or unable to progress. The same judge checks the way back every ten cheap-model calls.

## E124 — 2026-11-02

Separate the judge from the model that takes over. The provider's cheapest model on any API judges both directions; the cheapest model on the session's own API takes over. The evaluated gateway therefore used Luna to judge Opus-to-Haiku hand-offs. Claude's original hand-back folded context; GPT switched in place.

## E123

Ask whether the next steps carry out an existing decision, rather than requiring the entire remaining task to be routine. Keep difficult design, debugging, correctness reasoning, algorithms, and proofs on the strong model. The hand-off is reversible.

## E122 / E121 / E120

E120 (2026-11-01) replaces the strong model's own hand-off tool decision with a cheap-model judge: from call ten, judge every ten calls, reading the task and recent trajectory. A successful judgment switches models in place at the next turn end. Ending the cheap run brings the strong model back; Claude initially folds its context on return.

E121 lets the cheapest model on any API of the provider judge, so Luna can judge for Opus. E122 gives Opus the same switching rule as GPT and introduces return judging every ten cheap-model calls. Its hand-off model is the judge itself. E124 later separates the judge from the same-API model that takes over.

## E073 and earlier

The standalone policy preserves user messages, recent check outputs, unresolved failures, and edited-file contents where their expected reuse pays. It measures carry costs and re-reads from the session, chooses priced tail options, and calls a cheaper same-provider model through Pi's registry. Earlier task-runner-specific timing, proxy, and fixed-family mechanisms were removed. Prompt guidelines and routine-step reasoning experiments remained unregistered in the evaluated packages and were removed in the merged package.

## Unified Pi package — 2026-11-18

First merge E160's Responses behavior and E154's Messages behavior without changes to observable outputs. Remove inactive code and duplicate modules, and port the active tests. Subsequent review fixes, with their behavior and measurement implications, are listed in README.md under “Changes since the measured code.”

The measured Opus baseline pooled plain Pi arms E107, E109, E133, E144 and E148. The reread prior came from E052 (36 applied cuts without a re-read rebound); the plan-anchor observation came from E015. New records use `sol-pi-v2`; old version labels remain readable.
