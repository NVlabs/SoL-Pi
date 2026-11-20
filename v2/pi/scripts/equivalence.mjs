// Replay the evaluated extensions and the merged package without network or credentials.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkpoint, checkpoints, hasCheckpoint } from './checkpoint.mjs';
import { isDeepStrictEqual } from 'node:util';
import { SUMMARY_ONLY_SYSTEM } from '../lib/policy.js';

for (const name of ['SOLPI_HANDOFF_MODEL', 'SOLPI_JUDGE_MODEL', 'SOLPI_SUMMARY_MODEL']) delete process.env[name];
if (!checkpoints.every(folder => hasCheckpoint(folder))) {
  console.log("skipped: the replay needs the tagged checkpoints of the team's internal repository");
  process.exit(0);
}

const temp = mkdtempSync(join(tmpdir(), 'solpi-equivalence-'));
const tick = () => new Promise(r => setTimeout(r, 5));
const clean = x => x === undefined ? null : JSON.parse(JSON.stringify(x));
const models = [
  { provider: 'openai', id: 'gpt-6.1-sol', api: 'openai-responses', cost: { input: 2, output: 10, cacheRead: .1, cacheWrite: 2 }, contextWindow: 272000 },
  { provider: 'openai', id: 'gpt-6-luna', api: 'openai-responses', cost: { input: .2, output: .75 }, contextWindow: 272000 },
  { provider: 'anthropic', id: 'claude-opus-5-5', api: 'anthropic-messages', cost: { input: 4, output: 20, cacheRead: .2, cacheWrite: 5 }, contextWindow: 1000000 },
  { provider: 'anthropic', id: 'claude-haiku-5-5', api: 'anthropic-messages', cost: { input: .5, output: 2.5, cacheRead: .05, cacheWrite: .625 }, contextWindow: 200000 },
];
const summary = 'DECISION: CUT\nREASON: closed work\nKEEP: none\n<summary>Work done: generated data files. Open: verify the remaining files.</summary>';
async function replay(mod, claude) {
  const main = models[claude ? 2 : 0];
  let time = 1000000, seq = 0, customSeq = 0, draftSeq = 0, processNo = 0, finishJob, scope = "startup";
  const trace = [], entries = [], switches = [];
  const record = (label, value) => trace.push({ label, value: clean(value) });
  const add = message => { const e = { type: 'message', id: `e${seq++}`, message: { ...message, timestamp: ++time } }; entries.push(e); return e.message; };
  const messages = () => entries.filter(e => e.type === 'message').map(e => e.message);
  const ctx = { model: main, cwd: '/nonexistent', mode: 'print', sessionManager: { getBranch: () => entries }, modelRegistry: {
    find: (p, id) => models.find(m => m.provider === p && m.id === id), getAvailable: () => models,
    complete: async (model, input, options) => {
      const { systemPrompt: system, ...context } = input;
      record(`${scope} nested request:${system.includes('You decide when') ? system.includes('\"handoff\"') ? 'handoff-judge' : 'handback-judge' : system.includes('You write a hand-off note') ? 'handback-note' : 'summary'}`, { model, system, ...context, options: { ...options, signal: options.signal instanceof AbortSignal ? { aborted: options.signal.aborted } : options.signal } });
      const text = system.includes('You decide when') ? (system.includes('"handoff"') ? '{"handoff":true,"phase":"checks","reason":"routine"}' : '{"handback":true,"phase":"debug","reason":"needs strong model"}') : system.includes('You write a hand-off note') ? 'Done: ran checks. State: tests pass. Open: inspect remaining files. Unverified: none.' : summary;
      return { stopReason: 'stop', content: [{ type: 'text', text }], usage: { input: 1000, output: 80 } };
    }
  } };
  let handlers, tools;
  const bash = () => ({ name: 'bash', label: 'bash', description: 'Execute a bash command.', parameters: { type: 'object' }, promptGuidelines: ['Use bash for shell commands.'], execute: async (id, params) => params.command === 'slow-check' ? new Promise(r => { finishJob = r; }) : { content: [{ type: 'text', text: 'ok' }], details: undefined } });
  async function boot() {
    scope = `boot ${processNo + 1}`;
    handlers = new Map(); tools = new Map([['bash', bash()], ['read', { name: 'read', description: 'Read a file.' }]]);
    const pi = {
      on: (n, f) => handlers.set(n, f),
      appendEntry: (customType, data) => { const e = { type: 'custom', id: `custom${customSeq++}`, customType, data: clean(data) }; entries.push(e); record(`${scope} appendEntry:${data.mechanism}`, { customType, data }); },
      setModel: async model => { ctx.model = model; switches.push(model.id); record(`${scope} setModel`, model); return true; },
      registerTool: def => tools.set(def.name, def),
      getAllTools: () => [{ ...bash(), sourceInfo: { source: 'builtin', path: 'builtin:bash' } }],
      setActiveTools: names => record('setActiveTools', names), getActiveTools: () => [...tools.keys()],
    };
    if (mod.installWith) mod.installWith(pi, bash, { yieldMs: 1, now: () => time, readFile: () => null });
    else await mod.default(pi);
    await handlers.get('session_start')?.({ type: 'session_start', reason: 'startup' }, ctx);
    await handlers.get('before_agent_start')?.({}, ctx);
    record(`tools process ${++processNo}`, [...tools.values()].map(({ execute, ...def }) => def));
  }
  async function emit(name, event, label = name) {
    scope = label;
    const r = await handlers.get(name)?.(event, ctx); await tick(); record(label, r);
    if (r?.entries) for (const e of r.entries) entries.push({ ...e, id: `draft${draftSeq++}` });
    return r;
  }
  const contextEntries = () => entries.filter(e => e.type === 'message').map(e => ({ sourceEntry: e, messages: [e.message] }));
  async function request(label) {
    await emit('context', { messages: messages() }, `${label} context`);
    await emit('before_provider_request', { payload: claude ? { system: 'system', messages: [{ role: 'user', content: 'go' }] } : { input: [{ role: 'developer', content: 'system' }, { role: 'user', content: 'go' }] } }, `${label} payload`);
  }
  async function turn(i, large = false) {
    await request(`turn ${i}`);
    const m = add({ role: 'assistant', provider: ctx.model.provider, model: ctx.model.id, content: [{ type: 'toolCall', id: `t${i}`, name: 'bash', arguments: { command: `cat data/part${i}.txt` } }], usage: { input: 10, output: 120, cacheRead: large ? 8000 + i * 10120 : 0, cacheWrite: large ? 10110 : 0 }, stopReason: 'toolUse' });
    let result = { toolCallId: `t${i}`, toolName: 'bash', content: [{ type: 'text', text: large ? 'x'.repeat(40000) : `ok ${i}` }], isError: false };
    const r = await emit('tool_result', result, `turn ${i} tool_result`); if (r) result = { ...result, ...r };
    add({ role: 'toolResult', ...result });
    await emit('turn_end', { outcome: 'completed', entries: [], message: m, context: { contextEntries: contextEntries() } }, `turn ${i} turn_end`);
  }
  await boot(); add({ role: 'user', content: [{ type: 'text', text: 'Optimize the data pipeline. Keep the public API unchanged.' }] });
  for (let i = 0; i < 12; i++) await turn(i);
  assert.notEqual(ctx.model.id, main.id, 'handoff happened');
  if (claude) {
    scope = 'background';
    record('bash short', await tools.get('bash').execute('short', { command: 'quick' }, undefined, undefined, ctx));
    record('bash yield', await tools.get('bash').execute('slow', { command: 'slow-check' }, undefined, undefined, ctx));
    finishJob({ content: [{ type: 'text', text: 'VERBATIM background result: 42 passed' }], structuredContent: { exit_code: 0 } }); await tick();
  }
  for (let i = 12; i < 23; i++) await turn(i);
  assert.equal(ctx.model.id, main.id, 'handback happened');
  await request('after handback');
  for (let i = 23; i < 26; i++) await turn(i);
  await boot(); await request('resume');
  for (let i = 26; i < 33; i++) await turn(i);
  await emit('agent_end', {}, 'settle');
  // Extend the same session with enough closed history to exercise priced compaction.
  add({ role: 'user', content: [{ type: 'text', text: 'Generate data files; preserve the API.' }] });
  let prev = 0, prefix = 8050;
  for (let i = 0; i < 30; i++) {
    add({ role: 'assistant', model: main.id, provider: main.provider, content: [{ type: 'thinking', thinking: i % 9 === 0 ? 'plan '.repeat(400) : 'ok' }, { type: 'toolCall', id: `big${i}`, name: 'bash', arguments: { command: `cat data/part${i}.txt` } }], usage: { input: 10, cacheRead: prev, cacheWrite: prefix - prev - 10, output: 120 } });
    prev = prefix; add({ role: 'toolResult', toolCallId: `big${i}`, toolName: 'bash', content: [{ type: 'text', text: 'x'.repeat(40000) }], isError: false }); prefix += 10120;
  }
  ctx.model = main; await boot();
  const ev = { outcome: 'completed', entries: [], context: { contextEntries: contextEntries() } };
  await emit('turn_end', ev, 'priced compaction request');
  const priced = await emit('turn_end', ev, 'priced compaction apply');
  assert.equal(!!priced?.entries?.some(e => e.type === 'compaction'), claude);
  const before = messages();
  const compact = await emit('session_before_compact', { reason: 'manual', preparation: { firstKeptEntryId: entries.filter(e => e.type === 'message').at(-2).id, messagesToSummarize: before.slice(0, -2), turnPrefixMessages: [], tokensBefore: 310000, settings: { keepRecentTokens: 1000 } } }, 'Pi compaction');
  assert.ok(compact?.compaction);
  assert.ok(switches.length >= 2);
  return trace;
}
// Only these reviewed differences are allowed; every unaffected field is still compared.
const jobHeader = '[Background job 1 ended after 0 min: slow-check]';
const jobText = jobHeader.replace('min:', 'min (exit 0):') + '\nVERBATIM background result: 42 passed';
const withStatus = value => JSON.parse(JSON.stringify(value).replaceAll(jobHeader, jobText.split('\n')[0]));
function noteWithResult(context) {
  const expected = structuredClone(context);
  const at = expected?.messages?.findIndex(m => m.role === 'user' && m.content[0]?.text?.startsWith('[Hand-off note.')) ?? -1;
  if (at < 0) return;
  expected.messages.splice(at + 1, 0, { role: 'user', content: [{ type: 'text', text: jobText }], timestamp: expected.messages[at].timestamp });
  return expected;
}
function intended(d, claude) {
  const equal = (a, b) => isDeepStrictEqual(a, b);
  const drop = (value, keys) => { const out = structuredClone(value); for (const k of keys) delete out.data[k]; return out; };
  const k = d.key;
  if (/appendEntry:hand(off|back)-judge/.test(k) && d.old) {
    const model = models[(claude ? 2 : 0) + (k.includes('handback-judge') ? 1 : 0)];
    if (equal(d.new.data.model, { provider: model.provider, id: model.id }) && d.new.data.epoch === 0 && d.new.data.stale === false &&
        equal(d.old, drop(d.new, ['model', 'epoch', 'stale']))) return 'A6: judge model and selection epoch, with unchanged decision/usage';
  }
  const main = models[claude ? 2 : 0], cheap = models[claude ? 3 : 1], ref = ({ provider, id }) => ({ provider, id });
  const switchData = { strong: ref(main), cheap: ref(cheap), forwardCalls: k.startsWith('turn 10 ') ? 10 : 20 };
  if (k.includes('appendEntry:momentum-switch') && d.old?.data.reason === 'handoff' && equal(d.new, { ...d.old, data: { ...d.old.data, ...switchData } })) return '#5 bug 2: persist hand-off ownership';
  const range = claude ? 'd47859161f37c1725796986ae45ca1dc825a3cf922f67fd67f318c735012fc71' : 'cb3bf67687996a7cc37db0c89c5a9c4b7afec5172c413d4572fbbd45a3f411d9';
  if (k === 'turn 21 context appendEntry:handback-note #0' && equal(d.new, { ...d.old, data: { ...d.old.data, range, attempt: 1, writer: `${cheap.provider}/${cheap.id}`, usage: { input: 1000, output: 80 } } })) return '#6 bug 3 / A5: note range, attempt and usage/writer accounting';
  if (k === 'turn 21 context appendEntry:handback-note-attempt #0' && !d.old && equal(d.new, { customType: 'legacy-ac-activation', data: { kind: 'decision', mechanism: 'handback-note-attempt', version: 'sol-pi-v2', stint: 'custom1', attempt: 1 } })) return 'A5: reserve note attempt before dispatch';
  if (k === 'Pi compaction nested request:summary #0' && equal(d.new, { ...withStatus(d.old), system: SUMMARY_ONLY_SYSTEM })) return '#6 bug 1: summary-only prompt with expected transcript';
  if (!claude) return null;
  if (k === 'background appendEntry:bash-yield #0' && d.new.data.command === 'slow-check' && equal(d.old, drop(d.new, ['command']))) return '#7 bug 1: durable job metadata';
  if (k === 'background appendEntry:bash-yield-result #0' && !d.old && equal(d.new.data, { version: 'sol-pi-v2', kind: 'applied', mechanism: 'bash-yield-result', launch: 'custom3', job: 1, command: 'slow-check', minutes: 0, text: 'VERBATIM background result: 42 passed', failed: false, exitCode: 0 })) return '#7 bug 1: durable finished result';
  if (k === 'turn 12 tool_result appendEntry:bash-yield-end #0' && equal(d.new, { ...d.old, data: { ...d.old.data, toolCallId: 't12', stint: 'custom1', jobs: d.old.data.jobs.map(j => ({ ...j, launch: 'custom3' })) } })) return 'A1 / #7 bug 1: delivery belongs to durable launch and handoff';
  if (k === 'turn 21 context appendEntry:bash-yield-handover #0' && !d.old && equal(d.new, { customType: 'legacy-ac-activation', data: { version: 'sol-pi-v2', kind: 'applied', mechanism: 'bash-yield-handover', jobs: ['custom3'], compaction: null } })) return 'A1: durable strong-model handover by launch id';
  if (k === 'bash yield #0' && equal(d.new, JSON.parse(JSON.stringify(d.old).replaceAll(' To stop it: pkill -f \\"slow-check\\"', '')))) return 'A10: no command-pattern stop hint (mock has no PID)';
  if ((k === 'turn 12 tool_result #0' || k.includes('nested request:handback-judge') || k.includes('nested request:handback-note') || k === 'priced compaction request nested request:summary #0') && d.old && equal(withStatus(d.old), d.new)) return '#7 bug 1: explicit background exit status';
  if (k === 'priced compaction apply #0') {
    const normalized = structuredClone(d.new);
    // The nine added status characters change this fixture's scaled cut by one token.
    for (const e of normalized.entries) {
      const info = e.type === 'compaction' ? e.details.solpi : e.data;
      for (const field of ['gate', 'gate_at_request']) { info[field].X -= 1; info[field].S += 1; }
      info.gate.saving_usd = Number((info.gate.saving_usd - .00001).toFixed(5));
    }
    if (equal(d.old, normalized)) return '#7 bug 1: priced-cut estimate reflects longer job status';
  }
  if (k.endsWith('context #0') && d.new && equal(noteWithResult(d.old), d.new)) return '#7 bug 1: result follows its note';
  return null;
}

const dateNow = Date.now;
Date.now = () => 1234567; // request timestamps and nested-call latency are deterministic
try {
  const merged = await import(process.env.SOLPI_EQ_EXTENSION ? pathToFileURL(resolve(process.env.SOLPI_EQ_EXTENSION)).href : new URL('../extension.js', import.meta.url));
  let differences = 0, unexpected = 0;
  for (const [label, folder, claude] of [['GPT', checkpoints[0], false], ['Claude', checkpoints[1], true]]) {
    const measured = await checkpoint(temp, folder), old = await replay(measured, claude), fresh = await replay(merged, claude);
    const indexed = observations => {
      const counts = new Map();
      return new Map(observations.map(o => { const n = counts.get(o.label) ?? 0; counts.set(o.label, n + 1); return [`${o.label} #${n}`, o.value]; }));
    };
    const before = indexed(old), after = indexed(fresh), diff = [];
    let reservations = 0;
    for (const event of fresh) {
      if (event.label.endsWith(' appendEntry:handback-note-attempt')) reservations++;
      if (event.label.endsWith(' nested request:handback-note') && --reservations !== 0) diff.push({ key: 'durable reservation before writer request', missing: true });
    }
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      const a = before.get(key), b = after.get(key);
      if (!isDeepStrictEqual(a, b)) diff.push({ key, old: a, new: b });
      else if (process.argv.includes('--allow-intended') && claude && key.endsWith('context #0') && noteWithResult(a))
        diff.push({ key, old: a, new: b, missing: true });
    }
    console.log(`${label}: ${old.length} evaluated / ${fresh.length} merged observations; ${diff.length} differences`);
    const counts = new Map();
    const legacyVersion = folder.match(/-([a-z]\d{3})-/)[1].toUpperCase();
    const neutral = value => value === undefined ? value : JSON.parse(JSON.stringify(value), (key, v) => key === 'version' && v === legacyVersion ? 'sol-pi-v2' : v);
    for (const d of diff) {
      const normalized = { ...d, old: neutral(d.old) };
      const labels = !isDeepStrictEqual(normalized.old, d.old);
      let reason = !d.missing && (isDeepStrictEqual(normalized.old, d.new) ? 'B4: neutral session version labels' : intended(normalized, claude));
      if (reason && labels && !reason.startsWith('B4:')) reason += '; B4: neutral labels';
      if (!reason) { unexpected++; console.log(`UNEXPECTED: ${d.key}`); }
      else {
        counts.set(reason, (counts.get(reason) ?? 0) + 1);
        if (!process.argv.includes('--allow-intended')) console.log(`  ${d.key}: ${reason}`);
      }
    }
    for (const [reason, count] of counts) console.log(`  ${count} × ${reason}`);
    if (process.env.SOLPI_EQ_TRACE_DIR) { mkdirSync(process.env.SOLPI_EQ_TRACE_DIR, { recursive: true }); writeFileSync(join(process.env.SOLPI_EQ_TRACE_DIR, `${label}.json`), JSON.stringify({ old, fresh, diff }, null, 2)); }
    differences += diff.length;
  }
  console.log(differences ? `Equivalence: ${differences} differing observations (inspect against intended fixes).` : 'Equivalence: PASS — no differences.');
  if (differences) console.log(`Reviewed differences: ${differences - unexpected}; unexpected differences: ${unexpected}.`);
  if (unexpected || (differences && !process.argv.includes('--allow-intended'))) process.exitCode = 1;
} finally { Date.now = dateNow; rmSync(temp, { recursive: true, force: true }); }
