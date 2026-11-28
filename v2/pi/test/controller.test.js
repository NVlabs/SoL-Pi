/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

// offline tests: real-use scenarios on synthetic sessions (no network, no model calls).
import test from "node:test";
import { builtinTools } from './host.js';
import assert from "node:assert/strict";
import { createController, JUDGE_INSTRUCTIONS, RETURN_INSTRUCTIONS, CLAUDE_RETURN_INSTRUCTIONS, CHEAP_NOTE, HANDBACK_NOTE_SYSTEM, NOTE_HEAD, NO_NOTE } from "../extension.js";
import { resolveCheapModel, resolveHandoffModel, resolveJudgeModel, parseReply, callCheap } from "../lib/summarizer.js";
import { scanEvents, failureLedger, classifyCall, carryUsd, pricesOf, cacheCold, cutGate, rereadsPerCut } from "../lib/policy.js";

const OPUS = { provider: "anthropic", id: "claude-opus-5-5", api: "anthropic-messages", cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }, contextWindow: 1000000 };
const HAIKU = { provider: "anthropic", id: "claude-haiku-5-5", api: "anthropic-messages", cost: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }, contextWindow: 200000 };
const LUNA = { provider: "openai", id: "gpt-6-luna", api: "openai-responses", cost: { input: 0.2, output: 0.75 }, contextWindow: 272000 };
const SOL = { provider: "openai", id: "gpt-6.1-sol", api: "openai-responses", cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2 }, contextWindow: 272000 };
const OTHER = { provider: "elsewhere", id: "tiny", api: "anthropic-messages", cost: { input: 0.01, output: 0.01 }, contextWindow: 200000 };
const registry = (models) => ({ getAvailable: () => models, find: (p, id) => models.find((m) => m.provider === p && m.id === id) });
const REPLY = "DECISION: CUT\nREASON: closed work\nKEEP: none\n<summary>1. Requests and constraints: as asked.\n2. Work done: generated data files.</summary>";
const USER1 = "Optimize the data pipeline in this repo. Keep the public API unchanged.";
const USER2 = "Constraint: never touch payments/ and keep every change behind a flag.";

/** A session of tool turns, each adding ~10k tokens of tool output; user messages at the given turns. */
function session({ turns = 30, users = { 0: USER1, 12: USER2 }, t0 = 1_000_000, outChars = 40000, out = 120, anchorChars = outChars } = {}) {
  const entries = []; let n = 0; let prefix = 8000; let prev = 0; let t = t0;
  const add = (m) => { entries.push({ type: "message", id: `e${n++}`, message: { ...m, timestamp: (t += 1000) } }); };
  for (let i = 0; i < turns; i++) {
    if (users[i]) { add({ role: "user", content: [{ type: "text", text: users[i] }] }); prefix += 50; }
    const id = `call${i}`;
    add({ role: "assistant", content: [{ type: "thinking", thinking: i % 9 === 0 ? "plan ".repeat(400) : "ok" }, { type: "toolCall", id, name: "bash", arguments: { command: `cat data/part${i}.txt` } }],
      usage: { input: 10, cacheRead: prev, cacheWrite: prefix - prev - 10, output: out }, stopReason: "toolUse" });
    prev = prefix;
    const chars = i % 9 === 0 ? anchorChars : outChars; // the turns with long reasoning (plan anchors)
    add({ role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text: "x".repeat(chars) }], isError: false });
    prefix += out + chars / 4;
  }
  return entries;
}
const ctxOf = (entries, model = OPUS, models = [OPUS, HAIKU, LUNA, OTHER]) => ({ model, modelRegistry: registry(models), cwd: "/nonexistent", sessionManager: { getBranch: () => entries } });
const turnEnd = (entries) => ({ outcome: "completed", entries: [], context: { contextEntries: entries.map((e) => ({ sourceEntry: e, messages: e.type === "compaction" ? [{ role: "compactionSummary", summary: e.summary, timestamp: Date.parse(e.timestamp) || 0 }] : [e.message] })) } });
const fakePi = (entries = []) => { const logs = []; return { logs, appendEntry: (type, data) => { logs.push({ type, data }); entries.push({ type: 'custom', id: `log${logs.length}`, customType: type, data }); } }; };

async function compactOnce(entries, extra = {}, model = OPUS) {
  const calls = [];
  const pi = fakePi();
  const c = createController(pi, { readFile: () => null, callCheap: async (ctx, model, args) => { calls.push({ model, args }); return { ok: true, text: REPLY, usage: { input: 1000, output: 300 } }; }, ...extra });
  const ctx = ctxOf(entries, model, [OPUS, HAIKU, SOL, LUNA, OTHER]);
  assert.equal(await c.onTurnEnd(turnEnd(entries), ctx), undefined, "the summary is requested in the background, nothing appended yet");
  assert.ok(c.state.pending, "a cut that pays is requested");
  await c.state.pending.promise;
  const r = await c.onTurnEnd(turnEnd(entries), ctx);
  return { c, r, calls, pi };
}

const asst = (tools = 1) => ({ role: "assistant", content: tools ? [{ type: "toolCall", id: "x", name: "bash", arguments: { command: "ls" } }] : [{ type: "text", text: "done" }] });
const judged = (reply, calls) => async (cx, model, args) => { calls.push({ model: model.id, system: args.system, user: args.user }); return { ok: true, text: reply, usage: { input: 1000, output: 50 } }; };
const tick = () => new Promise((r) => setTimeout(r, 0));

test("the cheap model judges from the 10th call on, every 10 calls; on approval the session moves to it at the next turn end (GPT)", async () => {
  const entries = session(); const set = []; const calls = [];
  const ctx = ctxOf(entries, SOL, [OPUS, HAIKU, SOL, LUNA, OTHER]);
  const pi = { ...fakePi(), setModel: async (m) => { set.push(m.id); ctx.model = m; return true; } };
  const c = createController(pi, { readFile: () => null, callCheap: judged('{"handoff": false, "phase": "design", "reason": "open"}', calls) });
  const ev = { ...turnEnd(entries), message: asst() };
  for (let k = 0; k < 9; k++) c.maybeJudge(ctx, ev);
  await tick(); assert.equal(calls.length, 0, "no judgment before the 10th call");
  c.maybeJudge(ctx, ev); await tick(); await tick();
  assert.equal(calls.length, 1); assert.equal(calls[0].model, LUNA.id, "the judge is the cheap model of the provider and API");
  assert.match(calls[0].user, /^TASK GIVEN TO THE AGENT:\n/); assert.ok(calls[0].user.includes(USER1), "the task is the first user message");
  await c.switchAtTurnEnd(ctx, ev); assert.deepEqual(set, [], "a denial changes nothing");
  for (let k = 0; k < 9; k++) c.maybeJudge(ctx, ev);
  await tick(); assert.equal(calls.length, 1, "the next judgment waits for 10 more calls");
  const c2 = createController(pi, { readFile: () => null, callCheap: judged('Sure. {"handoff": true, "phase": "running tests", "reason": "routine"}', calls) });
  for (let k = 0; k < 10; k++) c2.maybeJudge(ctx, ev);
  await tick(); await tick();
  assert.equal(c2.state.want, "handoff");
  await c2.switchAtTurnEnd(ctx, ev); assert.deepEqual(set, [LUNA.id], "approval: the switch happens at the next turn end");
  c2.maybeJudge(ctx, ev); await tick(); assert.equal(calls.length, 2, "no hand-back judgment before the cheap model's 10th call");
  await c2.onAgentEnd(ctx); assert.deepEqual(set, [LUNA.id, SOL.id], "the cheap model ending its run gives the session back (GPT)");
  assert.deepEqual(pi.logs.filter((l) => l.data?.mechanism === "handoff-judge").map((l) => l.data.handoff), [false, true]);
});

test("on Claude: the cheap model's last turn hands the session back in place, without a fold", async () => {
  const entries = session(); const set = []; const calls = [];
  const ctx = ctxOf(entries, OPUS, [OPUS, HAIKU, SOL, LUNA, OTHER]);
  const pi = { ...fakePi(), setModel: async (m) => { set.push(m.id); ctx.model = m; return true; } };
  const c = createController(pi, { readFile: () => null, callCheap: async (cx, model, args) => { calls.push(model.id); return { ok: true, text: args.system.startsWith("You decide when") ? '{"handoff": true, "phase": "p", "reason": "r"}' : REPLY, usage: { input: 1000, output: 300 } }; } });
  const ev = { ...turnEnd(entries), message: asst() };
  for (let k = 0; k < 10; k++) c.maybeJudge(ctx, ev);
  await tick(); await tick();
  assert.equal(await c.switchAtTurnEnd(ctx, ev), undefined);
  assert.deepEqual(set, [HAIKU.id], "Haiku's approval hands Opus to Haiku");
  assert.equal(await c.switchAtTurnEnd(ctx, ev), undefined, "a tool turn of the cheap model changes nothing");
  const out = await c.switchAtTurnEnd(ctx, { ...turnEnd(entries), message: asst(0) });
  assert.deepEqual(set, [HAIKU.id, OPUS.id], "the cheap model's last turn hands the session back");
  assert.equal(out, undefined, "no fold: Opus keeps its own context, and the stint goes out as a note");
  assert.deepEqual(calls, [HAIKU.id], "only Haiku's judgment so far; the note is written when the next request is built");
  await c.onAgentEnd(); assert.equal(set.length, 2, "agent end adds nothing on Claude");
});

test("the judge is the provider's cheapest model on any API; the model that takes over is the cheapest of the same API", () => {
  const all = registry([OPUS, HAIKU, SOL, LUNA, OTHER]);
  assert.equal(resolveJudgeModel({ model: OPUS, modelRegistry: all }, {})?.id, HAIKU.id, "Haiku judges for Opus on the official provider");
  assert.equal(resolveJudgeModel({ model: SOL, modelRegistry: all }, {})?.id, LUNA.id);
  assert.equal(resolveJudgeModel({ model: OPUS, modelRegistry: registry([OPUS, HAIKU, OTHER]) }, {})?.id, HAIKU.id, "no Luna: Haiku; never another provider");
  assert.equal(resolveJudgeModel({ model: OPUS, modelRegistry: all }, { SOLPI_JUDGE_MODEL: `anthropic/${HAIKU.id}` })?.id, HAIKU.id);
  assert.equal(resolveHandoffModel({ model: OPUS, modelRegistry: all }, {})?.id, HAIKU.id, "Haiku takes over from Opus");
  assert.equal(resolveHandoffModel({ model: SOL, modelRegistry: all }, {})?.id, LUNA.id, "Luna from Sol");
  assert.equal(resolveHandoffModel({ model: OPUS, modelRegistry: all }, { SOLPI_HANDOFF_MODEL: `openai/${LUNA.id}` }), null);
  assert.equal(resolveJudgeModel({ model: OPUS, modelRegistry: all }, { SOLPI_JUDGE_MODEL: `openai/${LUNA.id}` }), LUNA);
  assert.equal(resolveHandoffModel({ model: HAIKU, modelRegistry: registry([HAIKU, OTHER]) }, {}), null);
});

test("default return judges ignore ambient overrides and check every ten calls", async () => {
  for (const main of [SOL, OPUS]) {
    const cheap = main === OPUS ? HAIKU : LUNA;
    const entries = session(); const set = []; const calls = []; let back = false;
    const ctx = ctxOf(entries, main, [OPUS, HAIKU, SOL, LUNA, OTHER]);
    const pi = { ...fakePi(), setModel: async (m) => { set.push(m.id); ctx.model = m; return true; } };
    const c = createController(pi, { readFile: () => null, callCheap: async (cx, model, args) => {
      calls.push({ model: model.id, system: args.system });
      const text = [RETURN_INSTRUCTIONS, CLAUDE_RETURN_INSTRUCTIONS].includes(args.system) ? `{"handback": ${back}, "phase": "p", "reason": "r"}` : args.system === JUDGE_INSTRUCTIONS ? '{"handoff": true, "phase": "p", "reason": "r"}' : REPLY;
      return { ok: true, text, usage: { input: 1000, output: 50 } };
    } });
    const ev = { ...turnEnd(entries), message: asst() };
    for (let k = 0; k < 10; k++) c.maybeJudge(ctx, ev);
    await tick(); await tick(); await c.switchAtTurnEnd(ctx, ev);
    assert.deepEqual(set, [cheap.id], "Luna takes over from Sol, Haiku from Opus"); assert.equal(calls[0].model, cheap.id, "the paired model judges the hand-off");
    for (let k = 0; k < 9; k++) c.maybeJudge(ctx, ev);
    await tick(); assert.equal(calls.length, 1, "no hand-back judgment before the cheap model's 10th call");
    c.maybeJudge(ctx, ev); await tick(); await tick();
    assert.equal(calls.at(-1).system, main === OPUS ? CLAUDE_RETURN_INSTRUCTIONS : RETURN_INSTRUCTIONS, "Claude's way back by the hand-off's own rule");
    assert.equal(calls.at(-1).model, cheap.id, "the paired model judges the hand-back");
    assert.equal(await c.switchAtTurnEnd(ctx, ev), undefined); assert.deepEqual(set, [cheap.id], "keeping the cheap model changes nothing");
    back = true;
    for (let k = 0; k < 9; k++) c.maybeJudge(ctx, ev);
    await tick(); assert.equal(calls.length, 2, "the next judgment waits for 10 more calls");
    c.maybeJudge(ctx, ev); await tick(); await tick();
    const out = await c.switchAtTurnEnd(ctx, ev);
    assert.deepEqual(set, [cheap.id, main.id], "approval: back to the configured model at the next turn end");
    assert.equal(out, undefined, "back in place on both models; the stint goes out as a note");
    assert.deepEqual(pi.logs.filter((l) => l.data?.mechanism === "handback-judge").map((l) => l.data.handback), [false, true]);
  }
});

test("session tools: GPT keeps Pi bash; Claude replaces only bash with YIELD_NOTE", async () => {
  const { installWith, YIELD_NOTE, parseDecision } = await import("../extension.js");
  for (const model of [SOL, OPUS]) {
    const handlers = new Map(), registered = [], active = [];
    const def = { name: "bash", description: "Execute a bash command.", parameters: { type: "object" }, promptGuidelines: ["g"], execute: async () => ({ content: [] }) };
    const tools = new Map([["bash", def], ["read", { name: "read" }]]);
    installWith({ on: (n, f) => handlers.set(n, f), getAllTools: builtinTools, getActiveTools: () => [...tools.keys()], registerTool: (t) => { registered.push(t); tools.set(t.name, t); }, setActiveTools: (ts) => active.push(ts), appendEntry() {} }, () => def);
    assert.equal(registered.length, 0, "no global bash override");
    await handlers.get("session_start")({}, ctxOf([], model));
    await handlers.get('before_agent_start')({}, ctxOf([], model));
    assert.deepEqual(active, [], "the active tool set stays Pi's own");
    assert.deepEqual([...tools.keys()], ["bash", "read"]);
    assert.equal(registered.length, model === SOL ? 0 : 1);
    assert.equal(tools.get("bash").description, def.description + (model === OPUS ? ` ${YIELD_NOTE}` : ""));
    if (model === SOL) assert.equal(tools.get("bash"), def);
    else assert.deepEqual(tools.get("bash").promptGuidelines, ["g"]);
    assert.deepEqual([...handlers.keys()], ["turn_end", "agent_end", "before_provider_request", "context", "session_before_compact", "model_select", "session_start", "session_tree", "before_agent_start", "tool_result"]);
  }
  assert.deepEqual(parseDecision('x {"handoff": true, "phase": "a", "reason": "b"} y'), { handoff: true, phase: "a", reason: "b" });
  assert.equal(parseDecision('{"handoff": "yes"}'), null); assert.equal(parseDecision("no json"), null);
});

test("a priced cut becomes a Pi compaction entry that keeps every user message word for word", async () => {
  const entries = session();
  const { r, calls } = await compactOnce(entries);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model.id, HAIKU.id, "the cheap model of the same provider and API");
  const comp = r.entries.find((e) => e.type === "compaction");
  assert.ok(comp, "compaction draft");
  assert.ok(comp.summary.includes(USER1) && comp.summary.includes(USER2), "both user messages verbatim");
  const kept = entries.find((e) => e.id === comp.firstKeptEntryId);
  assert.equal(kept.message.role, "assistant", "the kept part starts at an assistant turn");
  assert.equal(comp.details.solpi.version, "sol-pi-v2");
  assert.deepEqual(comp.usage, { input: 1000, output: 300 }, "the summary call's usage is reported to Pi");
  assert.ok(r.entries.some((e) => e.type === "custom" && e.data?.kind === "applied"), "one applied log entry");
  assert.ok(!calls[0].args.user.includes("plan plan"), "reasoning is never sent to the cheap model");
});

test("kept turns stay as the original messages: the rest of the stretch is omitted, user messages stay in place", async () => {
  const entries = session({ users: { 0: USER1, 12: USER2, 20: "Also log every change in CHANGES.md." } });
  const keepT3 = "DECISION: CUT\nREASON: ok\nKEEP: T3\n<summary>work so far</summary>";
  const { r } = await compactOnce(entries, { callCheap: async () => ({ ok: true, text: keepT3, usage: { input: 1, output: 1 } }) });
  const comp = r.entries.find((e) => e.type === "compaction");
  const edits = r.entries.filter((e) => e.type === "context_edit");
  const first = entries.findIndex((e) => e.id === comp.firstKeptEntryId);
  const tail = entries.findIndex((e, i) => i > first && e.type === "message" && e.message.role === "assistant" && !edits.some((x) => x.targetId === e.id) && i > entries.findIndex((y) => y.id === edits.at(-1)?.targetId));
  assert.equal(entries[first].message.role, "assistant", "the compaction starts at the first kept turn");
  assert.ok(edits.length > 0 && edits.every((e) => e.replacement === null));
  const omitted = new Set(edits.map((e) => e.targetId));
  assert.ok(entries.every((e) => !(omitted.has(e.id) && e.message.role === "user")), "a user message is never omitted");
  assert.ok(entries.slice(first, tail).some((e) => e.message.role === "user" && !omitted.has(e.id)) || comp.summary.includes("CHANGES.md"), "the third user message stays in place or is copied");
  assert.ok(comp.summary.includes(USER1), "user messages before the first kept turn are copied");
  for (const e of entries.slice(first)) if (e.message.role === "toolResult" && !omitted.has(e.id)) {
    const call = entries.find((x) => x.message.role === "assistant" && x.message.content.some((b) => b.id === e.message.toolCallId));
    assert.ok(!omitted.has(call.id), "no tool result without its call");
  }
});

test("a summary that arrives turns later is applied when it still pays (the carry rule is checked only when asking)", async () => {
  const full = session({ turns: 40 });
  const early = full.slice(0, 2 * 30 + 2);
  const c = createController(fakePi(), { readFile: () => null, callCheap: async () => ({ ok: true, text: REPLY, usage: { input: 1, output: 1 } }) });
  await c.onTurnEnd(turnEnd(early), ctxOf(early));
  await c.state.pending.promise;
  const r = await c.onTurnEnd(turnEnd(full), ctxOf(full)); // ten more turns while the summary was written
  const comp = r.entries.find((e) => e.type === "compaction");
  assert.ok(comp, "applied");
  assert.equal(comp.details.solpi.gate.carry_usd, null);
  const kept = full.findIndex((e) => e.id === comp.firstKeptEntryId);
  assert.ok(kept < early.length, "the turns made meanwhile are kept");
});

test("a long pasted user message is kept whole, and a failed summary call is billed on the next compaction", async () => {
  const paste = "SPEC " + "a".repeat(12000) + " MIDDLE: never round amounts. " + "b".repeat(12000);
  const full = session({ turns: 70, users: { 0: paste } });
  const early = full.slice(0, 2 * 30 + 1);
  let n = 0;
  const c = createController(fakePi(), { readFile: () => null, callCheap: async () => (++n === 1 ? { ok: false, error: "error", usage: { input: 50000, output: 0 } } : { ok: true, text: REPLY, usage: { input: 1000, output: 300 } }) });
  await c.onTurnEnd(turnEnd(early), ctxOf(early)); await c.state.pending.promise;
  const r1 = await c.onTurnEnd(turnEnd(early), ctxOf(early));
  assert.deepEqual(r1.entries.find((e) => e.customType === "solpi-retry").data.usage, { input: 50000, output: 0 });
  const ret = r1.entries.find((e) => e.customType === "solpi-retry");
  await c.onTurnEnd(turnEnd(full), ctxOf([...full, ret])); await c.state.pending.promise;
  const r2 = await c.onTurnEnd(turnEnd(full), ctxOf([...full, ret]));
  const comp = r2.entries.find((e) => e.type === "compaction");
  assert.ok(comp.summary.includes(paste), "the whole paste, middle included");
  assert.deepEqual(comp.usage, { input: 51000, output: 300 }, "the failed call's usage reaches Pi on the next compaction");
});

test("Pi's own compaction leaves user messages too large for the window to Pi's own summary", async () => {
  const entries = session({ turns: 10, users: { 0: "x".repeat(2_400_000) } });
  const prep = { firstKeptEntryId: entries[entries.length - 4].id, tokensBefore: 900000, messagesToSummarize: entries.slice(0, -4).map((e) => e.message), turnPrefixMessages: [] };
  const c = createController(fakePi(), { readFile: () => null, callCheap: async () => ({ ok: true, text: REPLY, usage: { input: 5, output: 5 } }) });
  assert.equal(await c.onBeforeCompact({ preparation: prep, reason: "overflow" }, ctxOf(entries)), undefined);
  assert.deepEqual(c.state.unbilled, { input: 5, output: 5 });
});

async function largestKept(branch, keep) {
  const c = createController(fakePi(), { callCheap: async () => ({ ok: true, text: REPLY }) });
  branch[5].message.content = [{ type: 'toolCall', id: 'full-read', name: 'read', arguments: { path: 'src/a.py' } }];
  Object.assign(branch[6].message, { toolName: 'read', toolCallId: 'full-read' });
  let low = 0, high = 100000;
  while (high - low > 1) {
    const size = (high + low) >>> 1;
    branch[6].message.content[0].text = 'x'.repeat(size);
    const r = await c.onBeforeCompact({ preparation: { firstKeptEntryId: keep, tokensBefore: 1, messagesToSummarize: [], settings: { keepRecentTokens: 20000 } } }, ctxOf(branch));
    if (r.compaction.details.solpi.files.includes('src/a.py')) low = size; else high = size;
  }
  return low;
}

test("kept file content is priced over the requests one compaction lasts, not the whole remaining session", async () => {
  const entries = session({ turns: 40 });
  entries[3] = { ...entries[3], message: { ...entries[3].message, content: [{ type: "toolCall", id: "w1", name: "write", arguments: { path: "src/a.py", content: "x" } }] } };
  entries[4] = { ...entries[4], message: { ...entries[4].message, toolName: 'write', toolCallId: "w1" } };
  const budget = branch => largestKept(branch, entries[78].id);
  const whole = await budget(entries);
  const recent = [...entries.slice(0, 70), { type: "compaction", id: "c0", summary: "s", firstKeptEntryId: entries[60].id, timestamp: new Date(1_000_000).toISOString() }, ...entries.slice(70)];
  const life = await budget(recent);
  assert.ok(life > 2 * whole, `kept over one compaction's life (${life} chars) vs the whole session (${whole} chars)`);
});

test("kept file content is priced at the share of earlier kept files the agent touched before the next compaction", async () => {
  const entries = session({ turns: 40 });
  entries[3] = { ...entries[3], message: { ...entries[3].message, content: [{ type: "toolCall", id: "w1", name: "write", arguments: { path: "src/a.py", content: "x" } }] } };
  entries[4] = { ...entries[4], message: { ...entries[4].message, toolName: 'write', toolCallId: "w1" } };
  const files = ["src/f1.py", "src/f2.py", "src/f3.py", "src/f4.py"];
  const cut = { type: "compaction", id: "c0", summary: "s", firstKeptEntryId: entries[60].id, timestamp: new Date(1_000_000).toISOString(), details: { solpi: { files } } };
  const run = tail => largestKept([...entries.slice(0, 70), cut, ...tail], entries[78].id);
  const named = (e) => (e.message.role === "assistant" ? { ...e, message: { ...e.message, content: [{ ...e.message.content[1], arguments: { command: `wc -l ${files.join(" ")}` } }] } } : e);
  const unused = await run(entries.slice(70));
  const used = await run(entries.slice(70).map(named));
  assert.ok(used > 4 * unused, `kept files the agent used raise the budget (${used} vs ${unused} chars)`);
});

test("no clock and no run length: the same session hours later makes the same decision", async () => {
  const a = await compactOnce(session());
  const b = await compactOnce(session({ t0: 1_000_000 + 5 * 3600_000 }));
  assert.equal(a.r.entries[0].firstKeptEntryId, b.r.entries[0].firstKeptEntryId);
  assert.equal(a.r.entries[0].details.solpi.gate.remaining, b.r.entries[0].details.solpi.gate.remaining);
});

test("a filtered or failed summary is one failed attempt: no cut, a retry point, the harness stays on", async () => {
  const full = session({ turns: 70 });
  const early = full.slice(0, 2 * 30 + 2); // 30 tool turns plus the two user messages
  const pi = fakePi();
  let n = 0;
  const c = createController(pi, { readFile: () => null, callCheap: async () => { n++; return { ok: false, error: "error", detail: "content_filter" }; } });
  await c.onTurnEnd(turnEnd(early), ctxOf(early));
  await c.state.pending.promise;
  const r = await c.onTurnEnd(turnEnd(early), ctxOf(early));
  assert.ok(!r.entries.some((e) => e.type === "compaction"), "never a cut without a summary");
  const retry = r.entries.find((e) => e.type === "custom" && e.customType === "solpi-retry");
  assert.ok(retry && /summary_failed/.test(retry.data.reason));
  assert.equal(await c.onTurnEnd(turnEnd(early), ctxOf(early)), undefined);
  assert.equal(c.state.pending, null, "no new attempt until the history since the failure has cost a cut again");
  await c.onTurnEnd(turnEnd(full), ctxOf([...full, { type: "custom", customType: "solpi-retry", data: retry.data }]));
  assert.ok(c.state.pending, "after more work the harness tries again");
  await c.state.pending.promise;
  assert.equal(n, 2, "exactly one new attempt");
});

test("without a cheaper model of the same provider and API, nothing is requested", async () => {
  const entries = session();
  const c = createController(fakePi(), { readFile: () => null, callCheap: async () => assert.fail("no call expected") });
  assert.equal(await c.onTurnEnd(turnEnd(entries), ctxOf(entries, OPUS, [OPUS, OTHER])), undefined);
  assert.equal(c.state.pending, null);
});

test("a rate-limited summary call is retried with back-off; a refusal is not", async () => {
  const replies = [{ stopReason: "error", errorMessage: '429 {"type":"rate_limit_error","message":"Model capacity reached"}', content: [] },
    { stopReason: "stop", content: [{ type: "text", text: REPLY }], usage: { input: 9, output: 9 } }];
  const waits = [];
  const ctx = { modelRegistry: { complete: async () => replies.shift() } };
  const r = await callCheap(ctx, HAIKU, { system: "s", user: "u" }, async (ms) => waits.push(ms));
  assert.ok(r.ok); assert.deepEqual(waits, [5000]);
  let n = 0;
  const refused = { modelRegistry: { complete: async () => { n++; return { stopReason: "error", errorMessage: "400 content_filter", content: [] }; } } };
  assert.equal((await callCheap(refused, HAIKU, { system: "s", user: "u" }, async () => {})).ok, false);
  assert.equal(n, 1);
});

test("cheap model resolution stays on the session's provider and API", () => {
  assert.equal(resolveCheapModel(ctxOf([], OPUS), {}).id, HAIKU.id);
  assert.equal(resolveCheapModel(ctxOf([], { ...LUNA, id: "route/test/gpt-6.1-sol", cost: { input: 2, output: 10 } }), {}).id, LUNA.id);
  assert.equal(resolveCheapModel(ctxOf([], HAIKU, [OPUS, HAIKU]), {}), null, "the main model is already the cheapest");
  assert.equal(resolveCheapModel(ctxOf([], OPUS), { SOLPI_SUMMARY_MODEL: "openai/gpt-6-luna" }).id, LUNA.id);
});

test("a summary made before Pi compacted by itself is dropped", async () => {
  const entries = session();
  const c = createController(fakePi(), { readFile: () => null, callCheap: async () => ({ ok: true, text: REPLY }) });
  await c.onTurnEnd(turnEnd(entries), ctxOf(entries));
  await c.state.pending.promise;
  const pi = { type: "compaction", id: "pi1", summary: "Pi's own summary", firstKeptEntryId: entries[entries.length - 6].id, timestamp: new Date(2_000_000).toISOString() };
  const after = [pi, ...entries.slice(-6)];
  assert.equal(await c.onTurnEnd(turnEnd(after), ctxOf([...entries, pi])), undefined);
  assert.equal(c.state.pending, null);
});

test("Pi's own compaction gets the cheap summary and the user messages; a failed summary leaves it to Pi", async () => {
  const entries = session();
  const prep = { firstKeptEntryId: entries[entries.length - 4].id, tokensBefore: 250000, messagesToSummarize: entries.slice(0, -4).map((e) => e.message), turnPrefixMessages: [], settings: { keepRecentTokens: 20000 } };
  const ok = createController(fakePi(), { readFile: () => null, callCheap: async () => ({ ok: true, text: REPLY, usage: { input: 5, output: 5 } }) });
  const r = await ok.onBeforeCompact({ preparation: prep, reason: "threshold" }, ctxOf(entries));
  assert.ok(r.compaction.summary.includes(USER1) && r.compaction.summary.includes(USER2));
  assert.equal(r.compaction.firstKeptEntryId, prep.firstKeptEntryId);
  const bad = createController(fakePi(), { readFile: () => null, callCheap: async () => ({ ok: false, error: "error" }) });
  assert.equal(await bad.onBeforeCompact({ preparation: prep, reason: "threshold" }, ctxOf(entries)), undefined);
});

test("checks are command words: mkdir tests and grep submit are not checks; a piped pass clears its failure", () => {
  const ev = (cmd, out, isError = false) => classifyCall({ name: "bash", arguments: { command: cmd } }, { content: [{ type: "text", text: out }], isError });
  assert.equal(ev("mkdir tests", "").kind, null);
  assert.equal(ev("grep -rn submit src/", "").kind, null);
  assert.equal(ev("timeout 600 pytest -x 2>&1 | tail -30", "1 passed").kind, "check");
  const call = (id, out) => [{ role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: { command: "pytest -x 2>&1 | tail -30" } }] }, { role: "toolResult", toolCallId: id, content: [{ type: "text", text: out }] }];
  const msgs = [...call("a", "FAILED test_x - AssertionError"), ...call("b", "3 passed in 0.2s")];
  assert.equal(failureLedger(scanEvents(msgs)).size, 0);
});

test("carry: re-reads at the read price, a re-write after an expired cache at the write price", () => {
  const P = pricesOf({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });
  const a = (p, read) => ({ role: "assistant", timestamp: 2, usage: { input: 0, cacheRead: read, cacheWrite: p - read, output: 0 } });
  const warm = carryUsd([a(100000, 0), a(150000, 100000)], P);
  const cold = carryUsd([a(100000, 0), a(150000, 0)], P);
  assert.ok(Math.abs(warm - 50000 * 0.2e-6) < 1e-9 && Math.abs(cold - 50000 * 5e-6) < 1e-9);
});

test("reply parsing keeps a format slip with a usable summary", () => {
  assert.equal(parseReply("<summary>did things</summary>").decision, "cut");
  assert.deepEqual(parseReply("DECISION: CUT\nKEEP: T3, T7\n<summary>x</summary>").keep, [3, 7]);
});

/** The session with its newest tool result `pauseMs` after the request that ran it (a long build, a sleep, a training run). */
const paused = (entries, pauseMs) => entries.map((e, i) => (i === entries.length - 1 ? { ...e, message: { ...e.message, timestamp: e.message.timestamp + pauseMs } } : e));

test("cold cache: the newest tools ran past the cache lifetime, unless this session's cache outlived such a pause before", () => {
  const msgs = (entries) => entries.map((e) => e.message);
  assert.equal(cacheCold(msgs(paused(session({ turns: 6 }), 6 * 60_000))), true);
  assert.equal(cacheCold(msgs(paused(session({ turns: 6 }), 3 * 60_000))), false);
  assert.equal(cacheCold(msgs(session({ turns: 6 }))), false);
  // An earlier request that came after a 6-minute pause and still read its whole prefix: this provider keeps the cache longer.
  const s = session({ turns: 6 });
  const firstResult = s.findIndex((e) => e.message.role === "toolResult");
  const longer = s.map((e, i) => (i >= firstResult ? { ...e, message: { ...e.message, timestamp: e.message.timestamp + 6 * 60_000 } } : e));
  assert.equal(cacheCold(msgs(paused(longer, 6 * 60_000))), false);
});

test("cut gate on a cold cache: no rewrite, and the closed history is not written again", () => {
  const P = pricesOf(OPUS.cost); const SP = pricesOf(HAIKU.cost);
  const args = { X: 40000, S: 30000, remaining: 20, summaryInTokens: 40000, summaryOutTokens: 3000, stats: { resultTok: 2000, out: 500 }, P, SP };
  const warm = cutGate(args); const cold = cutGate({ ...args, cold: true });
  assert.ok(warm.rewrite_usd > 0 && cold.rewrite_usd === 0);
  assert.ok(Math.abs(cold.saving_usd - 40000 * (P.write + 19 * P.read)) < 1e-4, "the next request would have written the closed history");
  assert.equal(cold.cold, true);
});

test("re-reads are measured on the session's own compactions: files read in the removed history, read again before the next one", () => {
  const call = (name, args) => ({ type: "toolCall", id: `c${Math.random()}`, name, arguments: args });
  const step = (...calls) => ({ type: "message", message: { role: "assistant", content: calls } });
  const cut = { type: "compaction" };
  assert.deepEqual(rereadsPerCut([step(call("read", { path: "a.lean" }))], "/w"), { calls: 3, steps: 3 }, "no compaction yet: the prior");
  const entries = [
    step(call("read", { path: "a.lean" }), call("bash", { command: "sed -n '1,50p' b.lean | head -5" })),
    step(call("bash", { command: "cat > notes.md <<'EOF'\nb.lean\nEOF" })), // a write, not a read
    cut,
    step(call("read", { path: "/w/a.lean", offset: 200 }), call("bash", { command: "timeout 60 cat b.lean && grep -n foo c.lean" })),
    step(call("bash", { command: "cat notes.md" })),
  ];
  // After the cut: a.lean and b.lean again (2 calls, 1 request); c.lean and notes.md were not read before it.
  assert.deepEqual(rereadsPerCut(entries, "/w"), { calls: (2 + 3) / 2, steps: (1 + 3) / 2 });
  // A cut priced at more re-reads costs more, so the same history pays later.
  const P = pricesOf(SOL.cost); const SP = pricesOf(LUNA.cost);
  const args = { X: 30000, S: 8000, remaining: 20, summaryInTokens: 30000, summaryOutTokens: 1000, P, SP };
  const few = cutGate({ ...args, stats: { resultTok: 1500, out: 500, rereads: { calls: 3, steps: 3 } } });
  const many = cutGate({ ...args, stats: { resultTok: 1500, out: 500, rereads: { calls: 13, steps: 6 } } });
  assert.ok(many.reread_usd > 2 * few.reread_usd && few.pays && !many.pays);
  assert.equal(cutGate({ ...args, stats: { resultTok: 1500, out: 500 } }).reread_usd, few.reread_usd, "no measurement: the prior");
});

test("a turn whose tools ran past the cache lifetime: the summary is awaited and the cut lands before the next request", async () => {
  const mk = () => createController(fakePi(), { readFile: () => null, callCheap: async () => ({ ok: true, text: REPLY, usage: { input: 1, output: 1 } }) });
  const base = session({ turns: 16 });
  const warm = mk();
  assert.equal(await warm.onTurnEnd(turnEnd(base), ctxOf(base)), undefined);
  assert.equal(warm.state.pending, null, "a warm cache: this short history does not pay a rewrite yet");
  const long = paused(base, 6 * 60_000);
  const cold = mk();
  const r = await cold.onTurnEnd(turnEnd(long), ctxOf(long));
  const comp = r?.entries?.find((e) => e.type === "compaction");
  assert.ok(comp, "applied at this turn end, without waiting for a later one");
  assert.equal(comp.details.solpi.gate.cold, true);
  assert.equal(cold.state.pending, null);
});

test("the plan anchor stays only while carrying it costs less than the one re-planning request it spares", async () => {
  const keptTurns = async (opts) => (await compactOnce(session(opts))).r.entries.find((e) => e.type === "compaction").details.solpi.kept_turns;
  assert.equal(await keptTurns({}), 0, "a planning turn with 10k tokens of output costs more to carry than to re-plan once");
  assert.equal(await keptTurns({ out: 3000, anchorChars: 400 }), 1, "a small planning turn in a session of long replies is kept");
});

test("on the cheap model, the agent's requests carry CHEAP_NOTE after the system prompt; stuck or worse is the way back", async () => {
  for (const main of [SOL, OPUS]) {
    const entries = session(); const set = [];
    const ctx = ctxOf(entries, main, [OPUS, HAIKU, SOL, LUNA, OTHER]);
    const pi = { ...fakePi(), setModel: async (m) => { set.push(m.id); ctx.model = m; return true; } };
    const c = createController(pi, { readFile: () => null, callCheap: async (cx, model, args) => ({ ok: true, usage: { input: 1000, output: 50 },
      text: [RETURN_INSTRUCTIONS, CLAUDE_RETURN_INSTRUCTIONS].includes(args.system) ? '{"handback": true, "phase": "p", "reason": "stuck"}' : args.system === JUDGE_INSTRUCTIONS ? '{"handoff": true, "phase": "p", "reason": "r"}' : REPLY }) });
    const anth = { model: "m", system: [{ type: "text", text: "SYS", cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: "hi" }] };
    const resp = { model: "m", input: [{ role: "developer", content: "SYS" }, { role: "user", content: [{ type: "input_text", text: "hi" }] }] };
    const payload = main === OPUS ? anth : resp;
    assert.equal(c.cheapNote({ payload }), undefined, "the configured model's requests are unchanged");
    const ev = { ...turnEnd(entries), message: asst() };
    for (let k = 0; k < 10; k++) c.maybeJudge(ctx, ev);
    await tick(); await tick(); await c.switchAtTurnEnd(ctx, ev);
    assert.equal(set.length, 1, "handed off");
    const out = c.cheapNote({ payload });
    if (main === OPUS) {
      assert.deepEqual(out.system[0], anth.system[0], "the system prompt and its cache mark stay first");
      assert.deepEqual(out.system.at(-1), { type: "text", text: CHEAP_NOTE }); assert.equal(out.messages, anth.messages);
    } else {
      assert.deepEqual(out.input[0], resp.input[0]); assert.deepEqual(out.input[1], { role: "developer", content: CHEAP_NOTE });
      assert.deepEqual(out.input.slice(2), resp.input.slice(1));
    }
    assert.deepEqual(c.cheapNote({ payload }), out, "the same note on every request of the stint, so the prompt cache holds");
    assert.equal(pi.logs.filter((l) => l.data?.mechanism === "cheap-note").length, 1, "logged once per stint");
    for (let k = 0; k < 10; k++) c.maybeJudge(ctx, ev);
    await tick(); await tick(); await c.switchAtTurnEnd(ctx, ev);
    assert.equal(set.at(-1), main.id, "stuck: back to the configured model");
    assert.equal(c.cheapNote({ payload }), undefined, "no note after the hand-back");
  }
  assert.match(RETURN_INSTRUCTIONS, /stuck/); assert.match(RETURN_INSTRUCTIONS, /got worse/);
  assert.doesNotMatch(RETURN_INSTRUCTIONS, /plan it was given is done/, "open-ended work left is no reason to give the work back");
  assert.match(RETURN_INSTRUCTIONS, /starts writing or repairing a proof/, "proofs go back to the strong model"); assert.match(JUDGE_INSTRUCTIONS, /writing or repairing a proof/);
});

const stintMsgs = (strong = SOL, cheap = LUNA) => {
  const a = ({ provider, id }, t, tools = true) => ({ role: "assistant", provider, model: id, timestamp: t, content: tools ? [{ type: "toolCall", id: `c${t}`, name: "bash", arguments: { command: `step ${t}` } }] : [{ type: "text", text: `text ${t}` }] });
  const r = (t) => ({ role: "toolResult", toolCallId: `c${t}`, toolName: "bash", timestamp: t + 0.5, content: [{ type: "text", text: `out ${t}` }] });
  return [{ role: "user", timestamp: 0, content: [{ type: "text", text: "task" }] }, a(strong, 1), r(1), a(strong, 2), r(2),
    a(cheap, 3), r(3), a(cheap, 4), r(4), a(strong, 5), r(5), a(cheap, 6), r(6)];
};

function stintEntries(main = SOL, cheap = LUNA, active = false) {
  const entries = []; let onCheap = false;
  const change = (reason, to) => entries.push({ type: "custom", id: `switch${entries.length}`, customType: "sol-pi-v2", data: { mechanism: "momentum-switch", reason, to: `${to.provider}/${to.id}`, strong: main, cheap } });
  for (const m of stintMsgs(main, cheap)) {
    if (m.role === "assistant" && (m.model === cheap.id) !== onCheap) {
      onCheap = m.model === cheap.id; change(onCheap ? "handoff" : "handback", onCheap ? cheap : main);
    }
    entries.push({ type: "message", id: `m${entries.length}`, message: m });
  }
  if (onCheap && !active) change("handback", main);
  return entries;
}

test("once a cheap-model stint is over, requests carry the cheap model's hand-off note in its place", async () => {
  const calls = [], entries = stintEntries(), pi = fakePi(entries);
  const c = createController(pi, { readFile: () => null, callCheap: async (cx, model, args) => { calls.push({ model: model.id, args }); return { ok: true, text: "Done: ran step 3 and 4. State: half done.", usage: { input: 500, output: 80 } }; } });
  const ctx = ctxOf(entries, SOL, [OPUS, HAIKU, SOL, LUNA, OTHER]);
  const msgs = stintMsgs();
  const r = await c.handBackView({ messages: msgs }, ctx);
  assert.equal(calls.length, 2, "one note per finished stint (both are over: the session is on the strong model)");
  assert.equal(calls[0].model, LUNA.id, "written by the cheap model");
  assert.equal(calls[0].args.system, HANDBACK_NOTE_SYSTEM);
  assert.match(calls[0].args.user, /step 3/); assert.match(calls[0].args.user, /out 4/); assert.doesNotMatch(calls[0].args.user, /step 2|step 5/);
  const out = r.messages;
  assert.deepEqual(out.slice(0, 5), msgs.slice(0, 5), "the strong model's own earlier context is sent unchanged");
  assert.equal(out[5].role, "user"); assert.ok(out[5].content[0].text.startsWith(NOTE_HEAD)); assert.match(out[5].content[0].text, /half done/);
  assert.deepEqual(out.slice(6, 8), msgs.slice(9, 11), "the strong model's later turns follow the note");
  assert.equal(out[8].role, "user", "the second stint is a note too"); assert.equal(out.length, 9);
  assert.ok(!out.some((m) => m.role === "toolResult" && /out [346]/.test(m.content[0].text)), "no tool result of a replaced stint is left");
  const again = await c.handBackView({ messages: stintMsgs() }, ctx);
  assert.equal(calls.length, 2, "each note is written once"); assert.deepEqual(again.messages, out, "and the same note goes out every time, so the prompt cache holds");
  assert.equal(pi.logs.filter((l) => l.data?.mechanism === "handback-note").length, 2);
});

test("the stint still running is sent in full; a failed note leaves a GPT stint as it was and gives Claude a notice", async () => {
  let ok = true; const pi = fakePi();
  const c = createController(pi, { readFile: () => null, callCheap: async () => (ok ? { ok: true, text: "note", usage: {} } : { ok: false, error: "timeout" }) });
  const ctx = ctxOf(stintEntries(SOL, LUNA, true), LUNA, [OPUS, HAIKU, SOL, LUNA, OTHER]);
  c.state.main = SOL; // on the cheap model
  const msgs = stintMsgs();
  const r = await c.handBackView({ messages: msgs }, ctx);
  assert.equal(r.messages.at(-2).role, "assistant", "the running stint is not replaced"); assert.equal(r.messages.length, msgs.length - 4 + 1, "only the finished stint (4 messages) became one note");
  assert.deepEqual(r.messages.slice(-2), msgs.slice(-2));
  ok = false; c.state.main = null;
  const c2 = createController(fakePi(), { readFile: () => null, callCheap: async () => ({ ok: false, error: "timeout" }) });
  assert.equal(await c2.handBackView({ messages: stintMsgs() }, ctxOf(stintEntries(), SOL, [OPUS, HAIKU, SOL, LUNA, OTHER])), undefined, "no note: the stints go out as before");
  const c3 = createController(fakePi(), { readFile: () => null, callCheap: async () => { throw new Error("gateway down"); } });
  const claude = (await c3.handBackView({ messages: stintMsgs(OPUS, HAIKU) }, ctxOf(stintEntries(OPUS, HAIKU), OPUS, [OPUS, HAIKU, SOL, LUNA, OTHER]))).messages;
  assert.ok(!claude.some((m) => m.role === "assistant" && m.model === HAIKU.id), "Opus never gets Haiku's turns, even without a note");
  assert.equal(claude.filter((m) => m.role === "user" && m.content[0].text.endsWith(NO_NOTE)).length, 2, "each stint becomes the notice");
  const c4 = createController(fakePi(), { readFile: () => null, callCheap: async (cx, model) => ({ ok: true, text: `note by ${model.id}`, usage: {} }) });
  const opus = (await c4.handBackView({ messages: stintMsgs(OPUS, HAIKU) }, ctxOf(stintEntries(OPUS, HAIKU), OPUS, [OPUS, HAIKU, SOL, LUNA, OTHER]))).messages;
  assert.match(opus[5].content[0].text, new RegExp(`note by ${HAIKU.id}`), "Haiku writes Opus's notes"); assert.deepEqual(opus.slice(0, 5), stintMsgs(OPUS, HAIKU).slice(0, 5));
  assert.equal(await c3.handBackView({ messages: stintMsgs().slice(0, 5) }, ctxOf(stintEntries(), SOL, [OPUS, HAIKU, SOL, LUNA, OTHER])), undefined, "no stint, nothing to do");
});

test("a short command returns Pi's own result; a long one is handed back and its result comes on a later tool result", async () => {
  const entries = [], pi = fakePi(entries), ctx = ctxOf(entries); let t = 0;
  const c = createController(pi, { readFile: () => null, yieldMs: 40, now: () => t });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const def = { execute: async (id, params) => {
    if (params.command === "quick") return { content: [{ type: "text", text: "ok" }], details: { a: 1 } };
    if (params.command === "boom") throw new Error("Command timed out after 1 seconds");
    await sleep(120);
    if (params.command === "slow-fail") return { content: [{ type: "text", text: "partial\n\nCommand exited with code 2" }], isError: true };
    return { content: [{ type: "text", text: "evaluation: 0.42" }] };
  } };
  assert.deepEqual(await c.yieldingBash(def, "1", { command: "quick" }, undefined, ctx), { content: [{ type: "text", text: "ok" }], details: { a: 1 } }, "short: exactly Pi's result");
  await assert.rejects(c.yieldingBash(def, "2", { command: "boom" }, undefined, {}), /timed out after 1 seconds/, "Pi's errors pass through");
  const r = await c.yieldingBash(def, "3", { command: "run-evaluation" }, undefined, ctx);
  assert.match(r.content[0].text, /^The command is still running after 0 minutes, so it goes on in the background as job 1 and you have control again\./);
  assert.equal(c.backgroundNotices({ content: [{ type: "text", text: "x" }] }), undefined, "not ended yet: the result is left alone");
  const r2 = await c.yieldingBash(def, "4", { command: "slow-fail" }, undefined, ctx);
  assert.match(r2.content[0].text, /as job 2 /);
  t = 3 * 60000; await sleep(200);
  const out = c.backgroundNotices({ toolCallId: 'ls', content: [{ type: "text", text: "ls output" }], structuredContent: { exit_code: 0 } }, ctx);
  assert.equal(out.content[0].text, "ls output");
  assert.match(out.content[1].text, /\[Background job 1 ended after 3 min \(exit 0\): run-evaluation\]\nevaluation: 0.42/);
  assert.match(out.content[1].text, /\[Background job 2 ended after 3 min \(failed; exit 2\): slow-fail\]\npartial\n\nCommand exited with code 2/);
  assert.deepEqual(out.structuredContent, { exit_code: 0 });
  entries.push({ type: 'message', message: { role: 'toolResult', toolCallId: 'ls', content: out.content } });
  assert.equal(c.backgroundNotices({ content: [] }, ctx), undefined, "each result once");
  assert.deepEqual(pi.logs.filter((l) => l.data?.mechanism === "bash-yield").map((l) => l.data.job), [1, 2]);
  assert.deepEqual(pi.logs.find((l) => l.data?.mechanism === "bash-yield-end").data.jobs.map((j) => [j.job, j.failed]), [[1, false], [2, true]]);
});

test("a handed-back command resolves to bash's structured result in a script; end notices skip nested calls", async () => {
  const entries = [], pi = fakePi(entries), ctx = ctxOf(entries); let t = 0;
  const c = createController(pi, { readFile: () => null, yieldMs: 40, now: () => t });
  const def = { execute: async () => { await new Promise((r) => setTimeout(r, 120)); return { content: [{ type: "text", text: "evaluation: 0.42" }] }; } };
  const r = await c.yieldingBash(def, "s/1", { command: "run-evaluation" }, undefined, ctx);
  assert.equal(r.structuredContent.output, r.content[0].text); assert.equal(r.structuredContent.exit_code, -1);
  assert.match(r.structuredContent.output, /still running after 0 minutes, so it goes on in the background as job 1/);
  t = 60000; await new Promise((res) => setTimeout(res, 200));
  assert.equal(c.backgroundNotices({ content: [{ type: "text", text: "nested" }], parentToolCallId: "s" }), undefined, "a nested call's result is left alone");
  const out = c.backgroundNotices({ toolCallId: 'script', content: [{ type: "text", text: "Script completed" }] }, ctx);
  assert.match(out.content[1].text, /\[Background job 1 ended after 1 min \(exit 0\): run-evaluation\]\nevaluation: 0.42/, "the script's own result carries it");
});

test("Pi's package is found from the running pi command when the bare import cannot see Pi's aliases", async () => {
  const { piPackage } = await import("../extension.js");
  const os = await import("node:os"); const fs = await import("node:fs"); const nodePath = await import("node:path");
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "pi-lookup-")), pkg = nodePath.join(root, "lib", "node_modules", "@earendil-works", "pi-coding-agent");
  fs.mkdirSync(nodePath.join(pkg, "dist", "bundle"), { recursive: true });
  fs.writeFileSync(nodePath.join(pkg, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", type: "module", exports: { ".": { import: "./dist/index.js" } } }));
  fs.writeFileSync(nodePath.join(pkg, "dist", "index.js"), "export const createBashToolDefinition = () => 'bash'; export const createCodemodeExtension = () => 'codemode';");
  fs.writeFileSync(nodePath.join(pkg, "dist", "bundle", "cli.js"), "");
  fs.mkdirSync(nodePath.join(root, "bin")); fs.symlinkSync(nodePath.join(pkg, "dist", "bundle", "cli.js"), nodePath.join(root, "bin", "pi"));
  const m = await piPackage(nodePath.join(root, "bin", "pi"), async () => { throw new Error("missing"); });
  assert.equal(m.createBashToolDefinition(), "bash", "found through the bin symlink"); assert.equal(m.createCodemodeExtension(), "codemode");
  assert.deepEqual(await piPackage(nodePath.join(root, "nowhere.js"), async () => { throw new Error("missing"); }), {}, "outside Pi: nothing");
});

test("Claude sessions get control back after Claude Code's 2-minute Bash timeout, other models after the 5-minute cache lifetime", async () => {
  const { yieldMsFor, CLAUDE_CODE_BASH_TIMEOUT_MS } = await import("../extension.js");
  assert.equal(CLAUDE_CODE_BASH_TIMEOUT_MS, 120000);
  assert.equal(yieldMsFor(OPUS), 120000); assert.equal(yieldMsFor(HAIKU), 120000);
  assert.equal(yieldMsFor(SOL), 300000); assert.equal(yieldMsFor(LUNA), 300000); assert.equal(yieldMsFor(undefined), 300000);
});

test("on Claude the way back also covers the hard steps the hand-off keeps on the strong model; GPT's way back is unchanged", () => {
  for (const step of ["designing or choosing an approach", "a new algorithm or component", "debugging a failure whose cause is not clear", "proof"])
    assert.ok(CLAUDE_RETURN_INSTRUCTIONS.includes(step), step);
  assert.match(CLAUDE_RETURN_INSTRUCTIONS, /stuck/); assert.match(CLAUDE_RETURN_INSTRUCTIONS, /got worse/); assert.match(CLAUDE_RETURN_INSTRUCTIONS, /"handback": true or false/);
  assert.ok(!RETURN_INSTRUCTIONS.includes("designing or choosing an approach"), "GPT keeps its narrower return rule");
  assert.match(JUDGE_INSTRUCTIONS, /designing or choosing an approach/);
});

test("no priced compaction on GPT; the same session on Claude still gets one", async () => {
  const entries = session();
  const c = createController(fakePi(), { readFile: () => null, callCheap: async () => ({ ok: true, text: REPLY, usage: { input: 1, output: 1 } }) });
  assert.equal(await c.onTurnEnd(turnEnd(entries), ctxOf(entries, SOL, [OPUS, HAIKU, SOL, LUNA, OTHER])), undefined);
  assert.equal(c.state.pending, null, "nothing requested on GPT");
  const r = await compactOnce(entries);
  assert.ok(r.c.state.cuts >= 0 && r.calls.length === 1, "Claude: the cut is still requested");
});

test("a new process (pi --continue) keeps the hand-off judge's cadence from the session", async () => {
  const base = session({ turns: 15 });
  const entries = base.map((e) => (e.type === "message" && e.message.role === "assistant" ? { ...e, message: { ...e.message, provider: SOL.provider, model: SOL.id } } : e));
  entries.push({ type: "custom", customType: "sol-pi-v2", data: { kind: "decision", mechanism: "handoff-judge", calls: 10, handoff: false } });
  const calls = []; const ctx = ctxOf(entries, SOL, [OPUS, HAIKU, SOL, LUNA, OTHER]);
  const c = createController({ ...fakePi(), setModel: async () => true }, { readFile: () => null, callCheap: judged('{"handoff": false, "phase": "x", "reason": "y"}', calls) });
  await c.handBackView({ messages: entries.filter((e) => e.type === "message").map((e) => e.message) }, ctx);
  assert.equal(c.state.calls, 15, "the configured model's calls so far");
  assert.equal(c.state.judgedAt, 10, "the count at the last decision");
  const ev = { ...turnEnd(entries), message: asst() };
  for (let k = 0; k < 4; k++) c.maybeJudge(ctx, ev);
  await tick(); assert.equal(calls.length, 0, "calls 16-19: no judgment yet");
  c.maybeJudge(ctx, ev); await tick(); await tick();
  assert.equal(calls.length, 1, "call 20: ten calls after the last decision, across the restart");
});
