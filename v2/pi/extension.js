// SoL-Pi v2: model hand-offs, hand-back notes and cheap compaction summaries.
import fs from "node:fs";
import { createHash } from 'node:crypto';
import { savingsOf } from "./lib/savings.js";
import { backgroundJobs } from "./lib/jobs.js";
import { handoffsOf, modelRef, sameModel, entryKey, assistantEntryLookup } from "./lib/session.js";
import nodePath from "node:path";
import { pathToFileURL } from "node:url";
import { resolveCheapModel, resolveHandoffModel, resolveJudgeModel, callCheap, parseReply } from "./lib/summarizer.js";
import {
  obj, tok, tsOf, textOf, pricesOf, prefixOf, carryUsd, runStats, requestUsd, fileKeepMaxChars, retouchShare, keptUse, rereadsPerCut, scanEvents,
  failureLedger, recentResults, tailOf, estTokens, editedFiles, turnSpan, labeledTranscript,
  tailOptions, loopTurns, tailPriceUsd, cutPriceFloor, cutGate, cacheCold, planAnchor, SUMMARY_SYSTEM, SUMMARY_ONLY_SYSTEM, compactionText, toolCallsOf, CACHE_TTL_MS,
} from "./lib/policy.js";


const LOG = "legacy-ac-activation"; // one entry per applied mechanism (the evaluation counts kind "applied")
const RETRY = "solpi-retry"; // a failed or unpaying summary: the next attempt waits for a new carry from here

// The judge decides on the next steps; the way back is checked every 10 steps.
export const JUDGE_INSTRUCTIONS = `You decide when a coding agent may hand its next steps to a cheaper model.

So far the agent has worked on a strong, expensive model. If you approve, a much cheaper and weaker model takes over the same
session: it sees the whole conversation, the same files and the same tools. The hand-off is not final: the cheaper model's work
is checked every 10 steps, and the strong model comes back as soon as it is stuck or its results get worse. So
judge the next steps, not the whole task. A step on the cheaper model costs a small fraction of a step on the strong model; a
hard step on the cheaper model loses quality, because it is worse at hard reasoning.

Approve when the next steps carry out something already decided, for example:
- running, repeating or checking experiments, tests or evaluations, and reading their results;
- trying parameter values or variants of a change that already works;
- applying an established fix to more cases, small edits, cleaning up, or writing the report.

Keep the strong model when the next step itself needs hard reasoning:
- designing or choosing an approach, or comparing approaches;
- debugging a failure whose cause is not clear, a regression or wrong results;
- a new algorithm, a non-trivial refactor, or careful reasoning about correctness or performance;
- writing or repairing a proof or a mathematical argument.

Reply with one JSON object and nothing else:
{"handoff": true or false, "phase": "<a short phrase naming the current phase>", "reason": "<one or two sentences>"}`;
// The same judge on the way back, while the cheaper model works.
export const RETURN_INSTRUCTIONS = `You decide when a coding agent should give its work back from a cheaper model to the strong model.

The agent started on a strong, expensive model, which handed the work to a much cheaper and weaker model. If you approve, the
strong model takes the work back and continues. Keeping the cheaper model saves cost; the strong model is needed when the
cheaper model cannot make progress on its own.

Give the work back when:
- the cheaper model is stuck: the same error or failing check keeps coming back, or its recent attempts made no progress;
- its results got worse, or something broke for a reason that is not obvious;
- it starts writing or repairing a proof or a mathematical argument, which needs the strong model.

Otherwise keep the cheaper model, also when the work left is open-ended: while it makes progress, it goes on.

Reply with one JSON object and nothing else:
{"handback": true or false, "phase": "<a short phrase naming the current phase>", "reason": "<one or two sentences>"}`;
// Claude's way back uses the hand-off's own list of hard steps.
export const CLAUDE_RETURN_INSTRUCTIONS = `You decide when a coding agent should give its work back from a cheaper model to the strong model.

The agent started on a strong, expensive model, which handed the work to a much cheaper and weaker model for routine steps. If
you approve, the strong model takes the work back and continues. Keeping the cheaper model saves cost; the strong model is
needed for hard steps and when the cheaper model cannot make progress on its own.

Give the work back when:
- the next step needs hard reasoning: designing or choosing an approach, a new algorithm or component, a non-trivial
  refactor, debugging a failure whose cause is not clear, careful reasoning about correctness or performance, or writing or
  repairing a proof or a mathematical argument;
- the cheaper model is stuck: the same error or failing check keeps coming back, or its recent attempts made no progress;
- its results got worse, or something broke for a reason that is not obvious.

Otherwise keep the cheaper model: while it carries out what is already decided (running and checking tests or evaluations,
applying an established fix, small edits), it goes on.

Reply with one JSON object and nothing else:
{"handback": true or false, "phase": "<a short phrase naming the current phase>", "reason": "<one or two sentences>"}`;
// The cheap model writes this hand-off note once its stint is over; requests carry it in place of the stint's steps.
export const HANDBACK_NOTE_SYSTEM = `You write a hand-off note for a coding agent. A cheaper model worked on the task for a while; the stronger model now
takes the work back. It will not see the cheaper model's steps below, only your note. Write:
1. Done: what was changed or run (files, commands) and the results actually observed (tests, errors, measurements), quoting
   numbers and error messages exactly.
2. State: where the work stands now.
3. Open: what is unfinished, failed or still unclear.
4. Unverified: anything the cheaper model claimed or assumed without checking.
Report only what the steps show; do not propose a new plan. Plain text, at most 300 words.`;
export const NO_NOTE = "No hand-off note could be written. Check the files and the output of your own commands to see what changed since your last turn.";
export const NOTE_HEAD = "[Hand-off note. A cheaper model worked on the task since your last turn; its steps are not shown. Before you build on this note, check it against the files and the output of your own commands, and redo what does not hold.]";
// While the cheap model works, its requests carry this note after the system prompt.
export const CHEAP_NOTE = "You have taken over this session from a stronger model, because the next steps were judged routine. Keep working toward the task's goal from where the work stands: carry out the next steps, check each result, and go on to the next useful step. Do not end your turn to report progress or to ask what to do next; end it only when the whole task is done or you cannot make further progress. The stronger model takes the work back when it is needed.";
// What the bash tool says about long commands, and what it returns when it hands one back.
/** Only stock bash on Claude gets the measured timeout and description. */
export const CLAUDE_CODE_BASH_TIMEOUT_MS = 120_000;
export const yieldMsFor = (model) => (model?.api === "anthropic-messages" ? CLAUDE_CODE_BASH_TIMEOUT_MS : CACHE_TTL_MS);
export const YIELD_NOTE = `A command still running after ${CLAUDE_CODE_BASH_TIMEOUT_MS / 60000} minutes on Claude models (${CACHE_TTL_MS / 60000} on other models) goes on in the background and you get control again; its output and exit code are added to a later tool result when it ends.`;
export const yieldText = (minutes, n, pid) => `The command is still running after ${minutes} minutes, so it goes on in the background as job ${n} and you have control again. Its output and exit code are added to a later tool result when it ends. Keep working on other steps; wait for it (for example with sleep) only if your next step needs its result.${Number.isSafeInteger(pid) && pid > 1 ? ` To stop its shell while it is running: kill -TERM ${pid}` : ''}`;
/** {handoff | handback, phase, reason} from the judge's reply, or null when it is not usable. */
export function parseDecision(text, key = "handoff") {
  const m = String(text || "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  let v; try { v = JSON.parse(m[0]); } catch { return null; }
  if (!obj(v) || typeof v[key] !== "boolean") return null;
  return { [key]: v[key], phase: String(v.phase ?? "").slice(0, 200), reason: String(v.reason ?? "").slice(0, 1000) };
}
const lastIndex = (a, f) => { for (let i = a.length - 1; i >= 0; i--) if (f(a[i])) return i; return -1; };
const fingerprint = messages => createHash('sha256').update(JSON.stringify(messages)).digest('hex');
// Pi records a summary call's usage only on the compaction entry: a failed or unused call is added to the next one.
const addUsage = (a, b) => { if (!obj(b)) return a; const o = { ...(a || {}) }; for (const [k, v] of Object.entries(b)) o[k] = typeof v === "number" ? (Number(o[k]) || 0) + v : obj(v) ? addUsage(o[k], v) : v; return o; };

export function createController(pi, opts = {}) {
  const now = opts.now ?? (() => Date.now());
  const call = opts.callCheap ?? callCheap;
  const s = { want: null, main: null, pending: null, retryAfter: -Infinity, restored: false, epoch: 0, cuts: 0, summaryOut: [], unbilled: null };
  const version = () => "sol-pi-v2";
  const warned = new Set();
  const owner = ctx => s.main ? { model: s.main, modelRegistry: ctx.modelRegistry } : ctx;
  function configure(ctx) {
    s.api ??= ctx?.model?.api;
    for (const [role, resolve] of [["HANDOFF", resolveHandoffModel], ["JUDGE", resolveJudgeModel], ["SUMMARY", resolveCheapModel]]) {
      const variable = `SOLPI_${role}_MODEL`, model = process.env[variable], key = `${variable}=${model}`;
      if (!model || !ctx?.modelRegistry || warned.has(key) || resolve(owner(ctx))) continue;
      warned.add(key);
      log({ kind: "decision", mechanism: "model-override", variable, model, error: "model_not_found" });
      if (ctx.mode === "tui") ctx.ui.notify(`SoL-Pi · ${variable}=${model} did not resolve; this role behaves as if no cheaper model is available.`, "warning");
    }
  }
  const entriesOf = (ctx) => ctx?.sessionManager?.getBranch?.() ?? [];
  const findModel = (ctx, ref) => ref && ctx.modelRegistry?.find(ref.provider, ref.id);
  function restoreHandoff(ctx) {
    if (s.handoffRestored) return;
    s.handoffRestored = true;
    const { active } = handoffsOf(entriesOf(ctx));
    if (active && sameModel(ctx.model, active.cheap)) {
      s.main = findModel(ctx, active.strong) ?? null;
      if (s.main) s.api = s.main.api;
    }
  }
  function modelSelected(e) {
    if (e.source === "restore") return false;
    if (e.source === "set" && sameModel(s.moving, e.model)) { s.moving = null; return false; }
    s.manual = e.model;
    if (s.main) log({ kind: "decision", mechanism: "momentum-switch", reason: "manual-model-change", to: `${e.model.provider}/${e.model.id}` });
    s.main = null; s.want = null; s.calls = 0; s.judgedAt = null;
    s.epoch = (s.epoch ?? 0) + 1; s.api = e.model?.api;
    log({ kind: "decision", mechanism: "model-selection", model: modelRef(e.model), epoch: s.epoch });
    return true;
  }
  const log = (data) => { if (!s.closed) try { pi.appendEntry(LOG, { version: version(), ...data }); return true; } catch {} return false; };
  function warnOnce(ctx, mechanism, message, reason) {
    if (!ctx || s.closed || warned.has(mechanism)) return;
    warned.add(mechanism);
    if ((ctx.sessionManager?.getEntries?.() ?? entriesOf(ctx)).some(e => e.customType === LOG && e.data?.mechanism === mechanism)) return;
    log({ kind: 'decision', mechanism, reason: reason ?? message });
    if (ctx.mode === 'tui') ctx.ui.notify(`SoL-Pi · ${message}`, 'warning');
  }

  const money = (value) => `~$${value.toFixed(2)}`;
  function status(ctx) {
    if (ctx?.mode !== "tui") return;
    const estimate = savingsOf(entriesOf(ctx), ctx.modelRegistry);
    ctx.ui.setStatus("sol-pi-savings", `⚡ SoL-Pi · ${ctx.model?.name ?? ctx.model?.id} · ${money(estimate.total)} saved`);
  }
  async function showSwitch(ctx, back) {
    if (ctx?.mode !== "tui") return;
    const epoch = s.epoch;
    // In the TUI, write the upcoming note before displaying its net cost, including at agent end.
    if (back) await handBackView({ messages: (ctx.sessionManager.buildSessionProjection?.().messages ?? branchOf(ctx).map(x => x.m)).filter(m => m.role !== 'system') }, ctx, false);
    if (s.closed || s.epoch !== epoch) return;
    const estimate = savingsOf(entriesOf(ctx), ctx.modelRegistry), name = ctx.model?.name ?? ctx.model?.id;
    ctx.ui.notify(back ? `⚡ SoL-Pi · back on ${name}\nMoney saved · ${money(estimate.stints.at(-1)?.saved ?? 0)} (this stint) · ${money(estimate.total)} (this session)` : `⚡ SoL-Pi · handed to ${name}`, "info");
    status(ctx);
  }

  function restore(ctx) {
    if (s.restored) return;
    s.restored = true;
    for (const e of ctx?.sessionManager?.getBranch?.() ?? []) {
      if (e?.type === "custom" && e.customType === RETRY && Number.isFinite(e.data?.after)) s.retryAfter = e.data.after;
      if (e?.type === "compaction" && e.details?.solpi) s.cuts += 1;
    }
  }
  /** R2: once per process, the hand-off judge's count of the configured model's calls and the count at its last decision, from
   *  this session, so a new process keeps the judge's cadence. */
  function restoreCadence(ctx) {
    if (s.cadenceRestored || !ctx?.model) return;
    s.cadenceRestored = true;
    const strong = s.main ?? ctx.model;
    const entries = entriesOf(ctx), { active } = handoffsOf(entries);
    const selected = lastIndex(entries, e => e.type === "custom" && e.customType === LOG && e.data?.mechanism === "model-selection");
    s.epoch = selected < 0 ? 0 : entries[selected].data.epoch;
    const current = entries.slice(Math.max(0, selected));
    s.calls = current.filter(e => e.type === "message" && e.message?.role === "assistant" && sameModel(e.message, strong)).length;
    if (s.main && active) s.calls = entries[active.start].data.forwardCalls ?? Math.max(0, s.calls - 1);
    else if (isClaude(strong) && selected < 0) s.calls = 0;
    const relevant = (e, model) => e.type === "custom" && e.customType === LOG && !e.data?.stale &&
      (e.data?.epoch == null || e.data.epoch === s.epoch) && (!e.data?.model || sameModel(e.data.model, model));
    let at = null;
    for (const e of current) if (relevant(e, strong) && e.data?.mechanism === "handoff-judge" && Number.isFinite(e.data.calls)) at = e.data.calls;
    if (at != null && at <= s.calls) s.judgedAt = at;
    if (s.main && active) {
      s.backCalls = 1 + active.keys.size;
      for (const e of entries.slice(active.start + 1)) if (relevant(e, active.cheap) && e.data?.mechanism === "handback-judge") {
        if (Number.isFinite(e.data.calls) && e.data.calls <= s.backCalls) s.backJudgedAt = e.data.calls;
        s.want = e.data.handback !== false ? HANDBACK : null;
      }
    }
  }
  // Every message on the branch, compacted ones included, with its entry id (user messages and tool calls since the start).
  const branchOf = (ctx) => (ctx?.sessionManager?.getBranch?.() ?? []).filter((e) => e?.type === "message" && obj(e.message)).map((e) => ({ id: e.id, m: e.message }));
  // Gott: a session is expected to make as many more requests as it has made so far (no clock, no run length).
  const requestsSoFar = (branch) => Math.max(1, branch.filter((x) => x.m.role === "assistant").length);

  /** What a compaction keeps word for word besides the summary: user messages, check outputs, failures and edited files. */
  function keptState(ctx, firstKeptId, maxChars, stats) {
    const branch = branchOf(ctx);
    const cut = branch.findIndex((x) => x.id === firstKeptId);
    const before = (cut >= 0 ? branch.slice(0, cut) : branch).map((x) => x.m);
    const cwd = ctx?.cwd || process.cwd();
    const events = scanEvents(before);
    let budget = maxChars;
    const fit = (items, size) => { const out = []; for (const it of items) { const n = size(it); if (out.length && n > budget) break; budget -= n; out.push(it); } return out; };
    const failures = fit([...failureLedger(events).values()].sort((a, b) => b.seq - a.seq).map((e) => ({ command: e.command, tail: tailOf(e.result_text, stats.resultChars) })), (f) => f.tail.length);
    const results = fit(recentResults(events, { tailChars: stats.resultChars }).reverse(), (r) => r.tail.length).reverse();
    let fbudget = maxChars;
    const files = editedFiles(before, 0, before.length - 1, cwd).map((f) => {
      if (typeof f.text === 'string' && Buffer.byteLength(f.text) <= fbudget) { fbudget -= f.text.length; return { path: f.path, text: f.text }; }
      if (f.text == null) warnOnce(ctx, 'file-content-skipped', 'No confirmed file contents; compaction keeps the path only.');
      return { path: f.path, text: null };
    });
    const users = branch.slice(0, cut >= 0 ? cut : branch.length).flatMap((x, at) => (x.m.role === "user" && textOf(x.m) ? [{ at, text: textOf(x.m) }] : []));
    return { users, failures, results, files };
  }
  // Kept content lives until the next compaction: it is priced over the requests one compaction lasts in this session (the
  // requests since the previous one), at most the expected remaining requests.
  const lifeOf = (ctx, branch) => {
    const entries = ctx?.sessionManager?.getBranch?.() ?? []; const c = entries.map((e) => e?.type).lastIndexOf("compaction");
    const life = c < 0 ? Infinity : entries.slice(c + 1).filter((e) => e?.type === "message" && e.message?.role === "assistant").length;
    return Math.min(requestsSoFar(branch), Math.max(1, life));
  };
  // Kept files at the share of the files earlier compactions kept that the agent touched before the next one.
  const keepChars = (ctx, stats, P, S, branch) => {
    const cwd = ctx?.cwd || "/";
    return fileKeepMaxChars({ p: keptUse(ctx?.sessionManager?.getBranch?.() ?? [], cwd) ?? retouchShare(branch.map((x) => x.m), cwd), remaining: lifeOf(ctx, branch), S, stats, P });
  };
  const verbatimPaths = (kept) => kept.files.filter((f) => f.text != null).map((f) => f.path);
  // The session's typical sizes, and the re-reads its own earlier compactions caused (the prior before the first).
  const statsOf = (ctx, msgs) => ({ ...runStats(msgs), rereads: rereadsPerCut(ctx?.sessionManager?.getBranch?.() ?? [], ctx?.cwd || "/") });

  /** Sizes of the projected context, measured on the requests made since the newest compaction (older usage is stale). */
  function measure(flat) {
    const msgs = flat.map((x) => x.m);
    const cIdx = lastIndex(msgs, (m) => m.role === "compactionSummary");
    const tCut = cIdx >= 0 ? tsOf(msgs[cIdx]) : -Infinity;
    const fresh = msgs.map((m, i) => i).filter((i) => msgs[i].role === "assistant" && tsOf(msgs[i]) > tCut && prefixOf(msgs[i]) !== null);
    if (!fresh.length) return null;
    const f0 = fresh[0]; const fN = fresh[fresh.length - 1];
    const H = Math.max(0, prefixOf(msgs[f0]) - estTokens(msgs.slice(0, f0))); // system prompt + tools
    const C = prefixOf(msgs[fN]) + (Number(msgs[fN].usage.output) || 0) + estTokens(msgs.slice(fN + 1)); // the next request
    const scale = Math.max(0, C - H) / Math.max(1, estTokens(msgs)); // estimates scaled to the measured context
    return { msgs, cIdx, tCut, H, C, size: (a, b) => scale * estTokens(msgs.slice(a, b + 1)), scale };
  }

  function detect(ctx, flat, P, cheap, cold = false) {
    const z = measure(flat); if (!z) return;
    const { msgs, cIdx, tCut, H, C, size, scale } = z;
    const lastA = lastIndex(msgs, (m) => m.role === "assistant");
    if (lastA < 2 || msgs[msgs.length - 1]?.role !== "toolResult") return; // only after a closed tool turn
    const events = scanEvents(msgs);
    if (events.some((e) => e.index === lastA && e.failed) || msgs.slice(lastA + 1).some((m) => m.isError)) return; // debugging
    const stats = statsOf(ctx, msgs);
    const carry = carryUsd(msgs, P, Math.max(tCut, s.retryAfter));
    if (carry < cutPriceFloor(stats, P)) return; // below the size-independent part of a cut's price: nothing is computed
    const kb = lastA - 1;
    const lower = Math.max(cIdx, 0);
    if (msgs[kb]?.role !== "toolResult" || kb <= lower + 1) return;
    const trigger = events.some((e) => e.index === lastA && e.kind && !e.failed) ? "check" : "priced";
    const options = tailOptions(msgs, lower, kb, loopTurns(msgs, events, lower, kb));
    const branch = branchOf(ctx);
    const remaining = requestsSoFar(branch);
    const firstKeptOf = (o) => flat[o.k + 1]?.id;
    // Kept state priced at the largest option (an upper bound), the summary at this session's earlier summary replies.
    const longest = options[options.length - 1];
    const kept = keptState(ctx, firstKeptOf(options[0]), keepChars(ctx, stats, P, size(longest.k + 1, msgs.length - 1), branch), stats);
    const sumOut = s.summaryOut.length ? s.summaryOut.reduce((a, b) => a + b, 0) / s.summaryOut.length : stats.out;
    const sumTok = sumOut + tok(compactionText({ ...kept, summary: "" }).length);
    const maxChars = 4 * Math.floor((Number(cheap.contextWindow) || 128000) / 2);
    const SP = pricesOf(cheap.cost);
    let pick = null; let g = null;
    for (const o of [...options].reverse()) { // longest tail first
      const gross = size(0, o.k); // everything before the tail goes, the previous compaction included
      const S = sumTok + (C - H - gross);
      const inTok = Math.min(tok(SUMMARY_SYSTEM.length) + estTokens(msgs.slice(0, o.k + 1)), maxChars / 4);
      g = cutGate({ X: gross - sumTok, S, remaining, cold, summaryInTokens: inTok, summaryOutTokens: sumOut, stats, P, SP,
        carryUsd: carry + tailPriceUsd(o.tokens * scale, trigger === "priced", P, stats.rereads), replanUsd: trigger === "priced" ? requestUsd(S, stats, P) : 0 });
      if (g.pays) { pick = o; break; }
    }
    if (!pick || !firstKeptOf(pick)) return;
    const idxs = []; for (let i = 0; i <= pick.k; i++) idxs.push(i);
    const priorMsgs = msgs.map((m, i) => (i === cIdx && flat[i].entry?.details?.solpi?.summary ? { ...m, summary: flat[i].entry.details.solpi.summary } : m));
    const sin = labeledTranscript(priorMsgs, idxs, maxChars);
    const p = { firstKeptId: firstKeptOf(pick), compactionId: cIdx >= 0 ? flat[cIdx].id : null, trigger, gate: g, tailTurns: pick.turns,
      turns: sin.turns.map((t) => ({ n: t.n, id: toolCallsOf(msgs[t.index])[0]?.id })), result: null };
    p.promise = Promise.resolve().then(() => call(ctx, cheap, { system: SUMMARY_SYSTEM, user: sin.text }))
      .then((r) => { p.result = r || { ok: false, error: "no_result" }; }, (e) => { p.result = { ok: false, error: "exception", detail: String(e?.message ?? e).slice(0, 200) }; });
    s.pending = p;
  }

  function fail(flat, reason, usage, extra = {}) {
    s.retryAfter = tsOf(flat[lastIndex(flat, (x) => x.m.role === "assistant")]?.m) || now();
    s.unbilled = addUsage(s.unbilled, usage);
    return [{ type: "custom", customType: RETRY, data: { after: s.retryAfter, reason, version: version(), usage: usage ?? null, ...extra } }];
  }

  const billed = (usage) => { const u = addUsage(s.unbilled, usage); s.unbilled = null; return u ? { usage: u } : {}; };

  function apply(ctx, flat, P, cheap, cold = false) {
    const p = s.pending; s.pending = null;
    const r = p.result;
    const parsed = r.ok ? parseReply(r.text) : null;
    if (!parsed || parsed.decision !== "cut" || !/\w/.test(parsed.summary)) {
      return fail(flat, r.ok ? (parsed?.decision === "decline" ? "declined" : "unparsable") : `summary_failed:${r.error}`, r.usage, { detail: r.detail ?? parsed?.reason ?? null });
    }
    const z = measure(flat);
    const cIdx = lastIndex(flat, (x) => x.m.role === "compactionSummary");
    const kp = flat.findIndex((x) => x.id === p.firstKeptId);
    if (!z || (cIdx >= 0 ? flat[cIdx].id : null) !== p.compactionId || kp < 2) { s.unbilled = addUsage(s.unbilled, r.usage); return []; } // compacted or moved since: stale
    const { msgs, H, C, size } = z;
    const k = kp - 1;
    const stats = statsOf(ctx, msgs);
    const branch = branchOf(ctx);
    const remaining = requestsSoFar(branch);
    const kept = keptState(ctx, p.firstKeptId, keepChars(ctx, stats, P, size(kp, msgs.length - 1), branch), stats);
    // Kept turns stay as they are (signed reasoning included, never restated as text): the compaction starts at the first
    // kept turn and omits every other assistant step and tool result up to the tail. Everything else in that stretch (user
    // messages, shell commands the user ran, extension messages) stays where it is.
    const plan = (turns) => {
      const first = turns.length ? Math.min(...turns.map((t) => t.a)) : kp;
      const omit = [];
      for (let i = first; i <= k; i++) if (["assistant", "toolResult"].includes(msgs[i].role) && !turns.some((t) => i >= t.a && i <= t.end)) omit.push(i);
      const text = compactionText({ ...kept, users: kept.users.filter((u) => u.at < flat[first].at), summary: parsed.summary, keptTurns: turns.length });
      const X = size(0, first - 1) + omit.reduce((a, i) => a + size(i, i), 0) - tok(text.length);
      const S = C - H - X;
      // The summary is paid and the carry rule already chose this cut: applying it only has to pay over the remaining requests
      // (the turns made while the summary was written are kept and rewritten, so S is priced as it is now).
      return { first, omit, text, g: cutGate({ X, S, remaining, cold, summaryInTokens: 0, stats, P, SP: pricesOf(cheap.cost),
        replanUsd: p.trigger === "priced" ? requestUsd(S, stats, P) : 0 }) };
    };
    // The plan anchor first, then the cheap model's keeps in its order; each only while the cut still pays. The anchor (its
    // reasoning is re-read at full size on every request) stays only while carrying it over one compaction's life costs
    // less than the one re-planning request it spares: reasoning written after the cut stays in context, so re-planning
    // happens at most once per compaction.
    const byN = new Map(p.turns.map((t) => [t.n, t.id]));
    const anchor = planAnchor(msgs, Math.max(cIdx, 0), k);
    const replanUsd = requestUsd(plan([]).g.S ?? 0, stats, P);
    const life = lifeOf(ctx, branch);
    const turns = [];
    for (const id of [anchor?.id, ...parsed.keep.map((n) => byN.get(n))]) {
      if (!id || turns.some((t) => t.id === id)) continue;
      const a = msgs.findIndex((m) => toolCallsOf(m).some((b) => b.id === id));
      if (a <= Math.max(cIdx, 0) || a > k) continue;
      const end = turnSpan(msgs, a, k);
      if (end - a !== toolCallsOf(msgs[a]).length) continue;
      if (id === anchor?.id && size(a, end) * (P.write - P.read + P.read * life) > replanUsd) continue;
      if (plan([...turns, { id, a, end }]).g.pays) turns.push({ id, a, end });
    }
    const fin = plan(turns);
    if (!fin.g.pays) return fail(flat, "summary_ready_cut_not_paying", r.usage, { gate: fin.g });
    s.cuts += 1;
    if (Number.isFinite(r.usage?.output)) s.summaryOut.push(r.usage.output);
    const info = { cut_no: s.cuts, trigger: p.trigger, tail_turns: p.tailTurns, kept_turns: turns.length, omitted: fin.omit.length,
      users_kept: kept.users.filter((u) => u.at < flat[fin.first].at).length, files_verbatim: verbatimPaths(kept).length,
      files_pointer: kept.files.filter((f) => f.text == null).length, failures_kept: kept.failures.length, results_kept: kept.results.length,
      cheap_model: `${cheap.provider}/${cheap.id}`, gate: fin.g, gate_at_request: p.gate };
    return [
      { type: "compaction", summary: fin.text, firstKeptEntryId: flat[fin.first].id, details: { solpi: { version: version(), summary: parsed.summary, files: verbatimPaths(kept), ...info } }, ...billed(r.usage) },
      ...fin.omit.map((i) => ({ type: "context_edit", targetId: flat[i].id, replacement: null })),
      { type: "custom", customType: LOG, data: { kind: "applied", mechanism: "priced-compaction", version: version(), ...info } },
    ];
  }

  async function onTurnEnd(event, ctx) {
    configure(ctx);
    if (s.api === "openai-responses") return undefined;
    try {
      const ents = event?.context?.contextEntries;
      if (!Array.isArray(ents) || event.outcome !== "completed") return undefined;
      restore(ctx);
      const P = pricesOf(ctx?.model?.cost);
      const cheap = P.read > 0 ? resolveCheapModel(owner(ctx)) : null;
      if (!cheap || (!process.env.SOLPI_SUMMARY_MODEL && sameModel(cheap, ctx.model))) return undefined;
      const at = new Map((ctx?.sessionManager?.getBranch?.() ?? []).filter((e) => e?.type === "message").map((e, i) => [e.id, i]));
      const flat = [];
      for (const pe of ents) for (const m of pe?.messages ?? []) if (obj(m)) flat.push({ id: pe.sourceEntry?.id, entry: pe.sourceEntry, m, at: at.get(pe.sourceEntry?.id) ?? Infinity });
      let out = [];
      const cold = cacheCold(branchOf(ctx).map((x) => x.m));
      if (cold && !s.pending) detect(ctx, flat, P, cheap, true);
      if (cold && s.pending) await s.pending.promise; // the cut lands before the request that writes the context again
      if (s.closed) return undefined;
      if (s.pending?.result) out = apply(ctx, flat, P, cheap, cold);
      else if (!s.pending && !cold) detect(ctx, flat, P, cheap);
      return out.length ? { entries: [...(Array.isArray(event.entries) ? event.entries : []), ...out] } : undefined;
    } catch (e) {
      log({ kind: "decision", mechanism: "priced-compaction", outcome: "internal_error_no_change", error: String(e?.message ?? e).slice(0, 200) });
      return undefined;
    }
  }

  /** Pi compacts by itself (context window, overflow, /compact): the same cheap summary and verbatim items, Pi's cut point. */
  async function onBeforeCompact(event, ctx) {
    configure(ctx);
    try {
      const prep = event?.preparation;
      // On the cheapest model of its API (after a hand-off) that model writes the summary itself.
      const cheap = prep?.firstKeptEntryId ? (resolveCheapModel(owner(ctx)) ?? ctx?.model) : null;
      if (!cheap) return undefined;
      const branch = branchOf(ctx);
      const prevOwn = [...(ctx?.sessionManager?.getBranch?.() ?? [])].reverse().find((e) => e?.type === "compaction")?.details?.solpi?.summary;
      const prior = prevOwn ?? prep.previousSummary;
      const msgs = [...(prior ? [{ role: "compactionSummary", summary: prior }] : []), ...(prep.messagesToSummarize ?? []), ...(prep.turnPrefixMessages ?? [])];
      const sin = labeledTranscript(msgs, msgs.map((_, i) => i), 4 * Math.floor((Number(cheap.contextWindow) || 128000) / 2));
      const user = (event.customInstructions ? `[The user's instructions for this compaction]\n${event.customInstructions}\n\n` : "") + sin.text;
      const r = await call(ctx, cheap, { system: SUMMARY_ONLY_SYSTEM, user, signal: event.signal });
      if (s.closed) return undefined;
      const parsed = r.ok ? parseReply(r.text) : null;
      const P = pricesOf(ctx?.model?.cost); const stats = runStats(msgs);
      const kept = parsed && /\w/.test(parsed.summary) ? keptState(ctx, prep.firstKeptEntryId, keepChars(ctx, stats, P, Number(prep.settings?.keepRecentTokens) || 0, branch), stats) : null;
      // No summary, or user messages too large to keep word for word inside the window: Pi writes its own summary.
      if (!kept || tok(kept.users.reduce((a, u) => a + u.text.length, 0)) > (Number(ctx?.model?.contextWindow) || Infinity) / 2) {
        s.unbilled = addUsage(s.unbilled, r.usage);
        log({ kind: "decision", mechanism: "priced-compaction", outcome: "pi_compaction_left_to_pi", reason: event.reason ?? null, error: r.error ?? null, usage: r.usage ?? null });
        return undefined;
      }
      const info = { reason: event.reason ?? null, users_kept: kept.users.length, cheap_model: `${cheap.provider}/${cheap.id}` };
      log({ kind: "applied", mechanism: "pi-compaction-cheap-summary", ...info });
      return { compaction: { summary: compactionText({ ...kept, summary: parsed.summary }), firstKeptEntryId: prep.firstKeptEntryId, tokensBefore: prep.tokensBefore,
        details: { solpi: { version: version(), summary: parsed.summary, files: verbatimPaths(kept), ...info } }, ...billed(r.usage) } };
    } catch (e) {
      log({ kind: "decision", mechanism: "priced-compaction", outcome: "internal_error_no_change", error: String(e?.message ?? e).slice(0, 200) });
      return undefined;
    }
  }

  // Momentum hand-off decided by a judge: from the configured model's 10th call on, every 10 calls,
  // the selected judge reads the task and recent work; when it approves, the session moves to the
  // cheap model of its own API at the next turn end. From the cheap model's 10th call on, every 10 calls, the same judge
  // decides whether the configured model comes back. GPT also returns at agent end; Claude returns at a completed cheap turn.
  const HANDOFF = "handoff", HANDBACK = "handback", JUDGE_FIRST = 10, JUDGE_EVERY = 10, TASK_CHARS = 6000, TRAJ_STEPS = 80, TRAJ_CHARS = 40000;
  const clipText = (t, h, tail) => (t.length <= h + tail + 40 ? t : `${t.slice(0, h)}\n[... ${t.length - h - tail} chars omitted ...]\n${t.slice(-tail)}`);
  /** At a turn end: count the call of the model the session is on, and every JUDGE_EVERY calls ask the judge in the
   *  background whether to hand off (on the configured model) or back (on the cheap model). */
  function maybeJudge(ctx, event) {
    configure(ctx);
    if (event?.message?.role !== "assistant") return;
    const back = !!s.main, key = back ? HANDBACK : HANDOFF;
    const n = back ? (s.backCalls = (s.backCalls ?? 0) + 1) : (s.calls = (s.calls ?? 0) + 1), last = back ? s.backJudgedAt : s.judgedAt;
    if (s.judging === s.epoch || s.want || n < JUDGE_FIRST || (last != null && n - last < JUDGE_EVERY)) return;
    if (!back && !resolveHandoffModel(ctx)) return;
    const judge = resolveJudgeModel(owner(ctx));
    if (!judge) return;
    const task = branchOf(ctx).find((x) => x.m.role === "user" && textOf(x.m))?.m;
    const msgs = [];
    for (const pe of event?.context?.contextEntries ?? []) for (const m of pe?.messages ?? []) if (obj(m)) msgs.push(m);
    const idx = msgs.map((_, i) => i).slice(-TRAJ_STEPS);
    const user = `TASK GIVEN TO THE AGENT:\n${task ? clipText(textOf(task), TASK_CHARS - 1500, 1500) : "(task prompt not found)"}\n\n` +
      `RECENT TRAJECTORY (oldest first):\n${labeledTranscript(msgs, idx, TRAJ_CHARS).text || "(no steps yet)"}\n\nDecide now.`;
    s.judging = s.epoch; if (back) s.backJudgedAt = n; else s.judgedAt = n;
    const epoch = s.epoch, model = modelRef(ctx.model);
    const stale = () => s.epoch !== epoch || !sameModel(ctx.model, model) || !!s.main !== back;
    const system = back ? (isClaude(s.main) ? CLAUDE_RETURN_INSTRUCTIONS : RETURN_INSTRUCTIONS) : JUDGE_INSTRUCTIONS;
    Promise.resolve().then(() => call(ctx, judge, { system, user, maxTokens: 4000 })).then((r) => {
      s.unbilled = addUsage(s.unbilled, r?.usage);
      const d = r?.ok ? parseDecision(r.text, key) : null;
      log({ kind: "decision", mechanism: `${key}-judge`, calls: n, model, epoch, stale: stale(), [key]: d?.[key] ?? null, phase: d?.phase ?? null, reason: d?.reason ?? null,
        error: r?.ok ? (d ? null : "unparsable") : (r?.error ?? "no_result"), judge: `${judge.provider}/${judge.id}`, usage: r?.usage ?? null });
      if (!stale() && (d?.[key] || (back && !d))) s.want = key;
    }, (e) => {
      log({ kind: "decision", mechanism: `${key}-judge`, calls: n, model, epoch, stale: stale(), [key]: null, error: String(e?.message ?? e).slice(0, 200), judge: `${judge.provider}/${judge.id}`, usage: null });
      if (!stale() && back) s.want = HANDBACK;
    // The session ended or was replaced while the judge ran (Pi then throws on the captured ctx): its decision is dropped.
    }).catch(() => {}).finally(() => { if (s.judging === epoch) s.judging = null; });
  }
  async function moveTo(ctx, model, reason, from) {
    const epoch = s.epoch;
    s.moving = model;
    try { if ((await Promise.resolve(pi.setModel?.(model))) === false) return false; } catch { return false; }
    finally {
      s.moving = null;
      while (!s.closed && epoch !== s.epoch && s.manual && sameModel(ctx.model, model) && !sameModel(model, s.manual)) {
        model = s.moving = s.manual;
        try { if (await pi.setModel(model)) continue; } catch {} finally { s.moving = null; }
        warnOnce(ctx, 'model-restore-failed', 'Pi could not restore your selected model after a delayed switch.'); break;
      }
    }
    if (s.closed || epoch !== s.epoch || !sameModel(ctx.model, model)) return false;
    s.main = from ?? null; s.want = null;
    if (from) { s.backCalls = 0; s.backJudgedAt = null; s.noted = false; }
    log({ kind: "applied", mechanism: "momentum-switch", reason, to: `${model.provider}/${model.id}`,
      ...(from ? { strong: modelRef(from), cheap: modelRef(model), forwardCalls: s.calls ?? 0 } : {}) });
    await showSwitch(ctx, !from);
  }
  const isClaude = (m) => m?.api === "anthropic-messages";
  /** At a turn end: the switch the judge asked for; on Claude also the cheap model's last turn. Returns entries to append. */
  async function switchAtTurnEnd(ctx, event) {
    const want = s.want;
    if (!ctx?.model) return undefined;
    if (want === HANDOFF && !s.main) {
      s.want = null;
      const cheap = resolveHandoffModel(ctx), main = ctx.model;
      if (cheap) await moveTo(ctx, cheap, HANDOFF, main);
      return undefined;
    }
    const last = isClaude(s.main) && event?.message?.role === "assistant" && !toolCallsOf(event.message).length;
    const reason = want === HANDBACK ? HANDBACK : last ? "cheap_model_ended_turn" : null;
    if (s.main && reason) await moveTo(ctx, s.main, reason);
  }
  /** while on the cheap model, CHEAP_NOTE goes after the system prompt of each request (Anthropic `system`, Responses
   *  `input`). Only the agent's own requests pass here, not the judge's or the summaries'. */
  function cheapNote(event) {
    const p = event?.payload;
    if (!s.main || !obj(p)) return undefined;
    let out;
    if (Array.isArray(p.messages)) out = { ...p, system: [...(Array.isArray(p.system) ? p.system : p.system ? [{ type: "text", text: String(p.system) }] : []), { type: "text", text: CHEAP_NOTE }] };
    else if (Array.isArray(p.input)) {
      const lead = ["developer", "system"].includes(p.input[0]?.role) ? 1 : 0;
      out = { ...p, input: [...p.input.slice(0, lead), { role: lead ? p.input[0].role : "developer", content: CHEAP_NOTE }, ...p.input.slice(lead)] };
    } else return undefined;
    if (!s.noted) { s.noted = true; log({ kind: "applied", mechanism: "cheap-note" }); }
    return out;
  }
  /** finished cheap-model stints in `messages` (runs of the other model's turns and their tool results), each with
   *  its durable hand-off id. The run at the end is still going while the session is on the cheap model. */
  function stintsOf(messages, strong, ctx) {
    const entries = entriesOf(ctx), { owned, active } = handoffsOf(entries);
    if (!owned.size) return [];
    const sourceOf = assistantEntryLookup(entries, ctx.sessionManager.buildSessionProjection?.().entries);
    const out = []; let cur = null;
    messages.forEach((m, i) => {
      const entryId = m?.role === "assistant" ? entryKey(sourceOf(m)) : null, turn = owned.get(entryId);
      const span = turn && sameModel(turn.span.strong, strong) && sameModel(turn.span.cheap, m) ? turn.span : null;
      if (cur && !(span === cur.span || m?.role === "toolResult")) { out.push({ ...cur, end: i }); cur = null; }
      if (span && !cur) cur = { start: i, key: turn.key, entryId, span };
    });
    if (cur && !(s.main && cur.span === active)) out.push({ ...cur, end: messages.length });
    return out;
  }
  /** The `context` handler: each finished cheap-model stint goes out as the cheap model's hand-off note, written once. */
  async function handBackView(event, ctx, outgoing = true) {
    restoreHandoff(ctx);
    configure(ctx);
    restoreCadence(ctx);
    const msgs = event?.messages, strong = s.main ?? ctx?.model;
    if (!Array.isArray(msgs) || !strong) return undefined;
    const stints = stintsOf(msgs, strong, ctx);
    for (const st of stints) {
      const part = msgs.slice(st.start, st.end), range = fingerprint(part);
      let attempt = 1, compacted = false;
      const branch = entriesOf(ctx).slice(st.span.start + 1);
      for (const [index, e] of branch.entries()) {
        if (e.type === 'compaction') compacted = true;
        const d = e.customType === LOG && e.data;
        if (!d || !(d.stint === st.span.id || st.span.keys.has(d.stint))) continue;
        if (d.mechanism === 'handback-note' && d.note && d.steps === part.length && (d.stint === st.key ||
            (!compacted && d.stint === st.span.id && st.key === st.span.keys.values().next().value))) {
          let saved = d.range;
          if (!saved) {
            const original = branch.slice(0, index).filter(e => e.type === 'message' && e.message.role !== 'system');
            const start = original.findIndex(e => entryKey(e) === st.entryId);
            if (start >= 0) saved = fingerprint(original.slice(start, start + d.steps).map(e => e.message));
          }
          if (saved === range) st.note = d.note;
        }
        if (d.mechanism === 'handback-note-attempt' || d.mechanism === 'handback-note') attempt = Math.max(attempt, (d.attempt ?? attempt) + 1);
      }
      const writer = findModel(ctx, st.span.cheap);
      if (st.note || !writer || attempt > 3) continue;
      if (!log({ kind: 'decision', mechanism: 'handback-note-attempt', stint: st.span.id, attempt })) continue;
      let r = null;
      try { r = await call(ctx, writer, { system: HANDBACK_NOTE_SYSTEM, user: labeledTranscript(part, part.map((_, i) => i), 4 * Math.floor((Number(writer.contextWindow) || 128000) / 2)).text, maxTokens: 4000 }); } catch (e) { r = { ok: false, error: String(e?.message ?? e).slice(0, 200) }; }
      if (s.closed) return undefined;
      s.unbilled = addUsage(s.unbilled, r?.usage);
      const note = r?.ok && /\w/.test(r.text ?? "") ? String(r.text).trim() : null;
      if (note) {
        st.note = note;
        log({ kind: "applied", mechanism: "handback-note", stint: st.key, steps: part.length, range, attempt, written: true, note, error: null, writer: `${writer.provider}/${writer.id}`, usage: r?.usage ?? null });
      } else log({ kind: "decision", mechanism: "handback-note-failure", stint: st.key, attempt, writer: `${writer.provider}/${writer.id}`, error: r?.error ?? "empty", usage: r?.usage ?? null });
    }
    const out = [], carried = [], deliveries = s.bashDisabled ? [] : jobs.deliveries(ctx); let at = 0;
    for (const st of stints) {
      const note = st.note || (isClaude(strong) ? NO_NOTE : null); // Claude never gets another model's turns
      if (!note) continue;
      out.push(...msgs.slice(at, st.start), { role: "user", content: [{ type: "text", text: `${NOTE_HEAD}\n\n${note}` }], timestamp: msgs[st.start].timestamp });
      for (const result of deliveries.filter(j => j.stint === st.span.id)) {
        const receipt = msgs.findIndex(m => m.role === 'toolResult' && m.toolCallId === result.toolCallId);
        if (carried.some(j => j.launch === result.launch) || (receipt >= 0 && !(st.start <= receipt && receipt < st.end))) continue;
        carried.push(result);
        out.push({ role: "user", content: [{ type: "text", text: result.text }], timestamp: msgs[st.start].timestamp });
      }
      at = st.end;
    }
    out.push(...msgs.slice(at));
    if (!s.main && sameModel(ctx.model, strong)) {
      for (const result of jobs.outstanding(strong, ctx, deliveries)) {
        if (carried.some(j => j.launch === result.launch)) continue;
        carried.push(result);
        if (!out.some(m => m.role === "toolResult" && m.toolCallId === result.toolCallId))
          out.push({ role: "user", content: [{ type: "text", text: result.text }], timestamp: msgs.at(-1)?.timestamp });
      }
      if (outgoing) jobs.handOver(carried, ctx);
    }
    return at || out.length !== msgs.length ? { messages: out } : undefined;
  }
  async function onAgentEnd(ctx) {
    if (s.main && !isClaude(s.main)) await moveTo(ctx, s.main, "cheap_model_ended_turn");
  }
  const jobs = backgroundJobs(log, now, (model) => opts.yieldMs ?? yieldMsFor(model), yieldText, opts.liveJobs, warnOnce);
  const yieldingBash = jobs.execute, backgroundNotices = jobs.notices;
  return { state: s, maybeJudge, switchAtTurnEnd, cheapNote, handBackView, onAgentEnd, yieldingBash, backgroundNotices, jobs, onTurnEnd, onBeforeCompact, configure, restoreHandoff, restoreCadence, modelSelected, status, warnOnce, close: () => { s.closed = true; s.epoch++; } };
}

/** Register Pi's bash wrapper only for Claude; GPT keeps Pi's built-in definition. */
export function installWith(pi, bashDefinition, opts = {}) {
  let liveJobs = { results: new Map() }, c = createController(pi, { ...opts, liveJobs }), started = false, ready = false;
  pi.on("turn_end", async (e, ctx) => {
    c.jobs.endBatch();
    const branch = c, epoch = c.state.epoch;
    await branch.switchAtTurnEnd(ctx, e);
    if (branch !== c || c.state.epoch !== epoch) return;
    c.maybeJudge(ctx, e);
    const out = await c.onTurnEnd(e, ctx);
    if (branch !== c) return;
    c.status(ctx);
    return out;
  });
  pi.on("agent_end", (e, ctx) => c.onAgentEnd(ctx));
  pi.on("before_provider_request", (e) => c.cheapNote(e));
  pi.on("context", (e, ctx) => c.handBackView(e, ctx));
  pi.on("session_before_compact", (e, ctx) => c.onBeforeCompact(e, ctx));
  let wrapped = false, ownPath;
  const bashTool = () => pi.getAllTools?.().find(t => t.name === 'bash');
  function syncBash(ctx, fresh = false) {
    if (!ready) return;
    const tool = bashTool(), source = tool?.sourceInfo;
    const stock = source?.source === 'builtin' && source.path === 'builtin:bash' && tool.promptGuidelines?.length > 0;
    c.state.bashDisabled = !bashDefinition || !pi.getActiveTools?.().includes('bash') || !(stock || (ownPath && source?.path === ownPath));
    if (!bashDefinition) return c.warnOnce(ctx, 'bash-yield-skipped', 'Stock bash factory unavailable; leaving bash unchanged.', 'missing-factory');
    if (c.state.bashDisabled) return c.warnOnce(ctx, 'bash-yield-skipped', 'Active bash is not verifiably stock; leaving it unchanged and not forwarding background output.', 'external-bash');
    const claude = ctx.model?.api === "anthropic-messages";
    if ((!fresh && claude === wrapped) || (!claude && !wrapped)) return;
    const settings = pi.getSettings?.() ?? {};
    const def = bashDefinition(ctx.cwd, { shellPath: settings.shellPath, commandPrefix: settings.shellCommandPrefix });
    if (claude) {
      pi.registerTool({ ...def, description: `${def.description} ${YIELD_NOTE}`, execute: (id, params, signal, onUpdate, ctx) => c.yieldingBash(def, id, params, signal, ctx) });
      wrapped = true;
    } else if (wrapped) { pi.registerTool(def); wrapped = false; }
    const after = bashTool()?.sourceInfo;
    ownPath = after?.source !== 'builtin' ? after?.path : undefined;
  }
  pi.on("model_select", (e, ctx) => { if (c.modelSelected(e)) syncBash(ctx); c.status(ctx); });
  function startBranch(ctx, tree) {
    if (started) { c.close(); if (!tree) liveJobs = { results: new Map() }; c = createController(pi, { ...opts, liveJobs }); }
    started = true;
    c.restoreHandoff(ctx); c.restoreCadence(ctx); c.configure(ctx); c.status(ctx);
    c.jobs.restore(ctx);
    if (!tree) { ready = false; c.state.bashDisabled = true; } else syncBash(ctx, true);
    if (!bashDefinition) c.warnOnce(ctx, 'bash-yield-skipped', 'Stock bash factory unavailable; leaving bash unchanged.', 'missing-factory');
  }
  pi.on("session_start", (_, ctx) => startBranch(ctx, false));
  pi.on("session_tree", (_, ctx) => startBranch(ctx, true));
  pi.on('before_agent_start', (_, ctx) => { const fresh = !ready; ready = true; syncBash(ctx, fresh); });
  if (bashDefinition) pi.on("tool_result", (e, ctx) => c.state.bashDisabled ? undefined : c.backgroundNotices(e, ctx));
  return c;
}

/** Pi's own package: by name where Pi's extension aliases reach this module, else from the running pi command (the
 * backend's .mjs entry is imported natively, outside the aliases). {} outside Pi. */
export async function piPackage(argv1 = process.argv[1], lookup = () => typeof require === 'function' ? require('@earendil-works/pi-coding-agent') : import('@earendil-works/pi-coding-agent')) {
  try { return await lookup(); } catch {}
  try {
    for (let d = nodePath.dirname(fs.realpathSync(argv1)); d !== nodePath.dirname(d); d = nodePath.dirname(d)) {
      const f = nodePath.join(d, "package.json");
      if (!fs.existsSync(f)) continue;
      const pkg = JSON.parse(fs.readFileSync(f, "utf8"));
      if (pkg.name === "@earendil-works/pi-coding-agent") {
        const bundle = nodePath.join(d, 'dist/bundle/index.js');
        return await import(pathToFileURL(fs.existsSync(bundle) ? bundle : nodePath.join(d, pkg.exports?.["."]?.import ?? pkg.main ?? "dist/index.js")).href);
      }
    }
  } catch {}
  return {};
}

export default async function install(pi, lookup = piPackage) {
  const mod = await lookup();
  const bash = mod.createBashToolDefinition && ((cwd, options) => {
    // SettingsManager normalizes shell paths exactly as Pi's own runtime does, without file I/O.
    const settings = mod.SettingsManager?.inMemory({ shellPath: options.shellPath });
    return mod.createBashToolDefinition(cwd, { ...options, shellPath: settings ? settings.getShellPath() : options.shellPath });
  });
  return installWith(pi, bash ?? null);
}
