/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

// Regression tests for the Pi package, with no provider requests.
import test from 'node:test';
import { builtinTools } from './host.js';
import assert from 'node:assert/strict';
import { createController, installWith, NO_NOTE, HANDBACK_NOTE_SYSTEM, JUDGE_INSTRUCTIONS } from '../extension.js';
import { SUMMARY_SYSTEM } from '../lib/policy.js';
import { savingsOf } from '../lib/savings.js';

const SOL = { provider: 'openai', id: 'gpt-6.1-sol', api: 'openai-responses', cost: { input: 2, output: 10, cacheRead: .1, cacheWrite: 2 }, contextWindow: 272000 };
const LUNA = { ...SOL, id: 'gpt-6-luna', cost: { input: .2, output: .75, cacheRead: .02, cacheWrite: .2 } };
const OPUS = { ...SOL, provider: 'anthropic', id: 'claude-opus-5-5', api: 'anthropic-messages', cost: { input: 4, output: 20, cacheRead: .2, cacheWrite: 5 } };
const HAIKU = { ...OPUS, id: 'claude-haiku-5-5', cost: { input: .5, output: 2.5, cacheRead: .05, cacheWrite: .625 } };
const models = [SOL, LUNA, OPUS, HAIKU];
const tick = () => new Promise(r => setTimeout(r, 0));
const msg = (model, timestamp, tool = false) => ({ role: 'assistant', provider: model.provider, model: model.id, timestamp, content: [{ type: tool ? 'toolCall' : 'text', ...(tool ? { id: `t${timestamp}`, name: 'bash', arguments: { command: 'check' } } : { text: `step ${timestamp}` }) }] });
const result = t => ({ role: 'toolResult', timestamp: t + .1, toolCallId: `t${t}`, toolName: 'bash', content: [{ type: 'text', text: `result ${t}` }] });
function harness(model = SOL, opts = {}, entries = []) {
  let id = 0;
  const handlers = new Map(), switches = [], notices = [], statuses = [];
  const ctx = { model, mode: 'print', cwd: '/nonexistent', ui: { notify: (...a) => notices.push(a), setStatus: (...a) => statuses.push(a) }, sessionManager: { getBranch: () => entries }, modelRegistry: { find: (p, id) => models.find(m => m.provider === p && m.id === id), getAvailable: () => models } };
  const pi = { appendEntry: (customType, data) => entries.push({ type: 'custom', id: `custom${id++}`, customType, data }), on: (n, f) => handlers.set(n, f), setModel: async m => { switches.push(m.id); ctx.model = m; entries.push({ type: 'model_change', provider: m.provider, modelId: m.id }); return true; } };
  pi.getAllTools = builtinTools;
  pi.getActiveTools = () => ['bash'];
  const c = createController(pi, { readFile: () => null, ...opts });
  return { c, ctx, pi, entries, switches, handlers, notices, statuses };
}
const logEntries = (h, mechanism) => h.entries.filter(e => e.data?.mechanism === mechanism);
async function judge(h, back) {
  if (back) { h.c.state.main = h.ctx.model === HAIKU ? OPUS : SOL; }
  for (let i = 0; i < 10; i++) h.c.maybeJudge(h.ctx, { message: msg(h.ctx.model, i, true) });
  await tick(); await tick();
  await h.c.switchAtTurnEnd(h.ctx, { message: msg(h.ctx.model, 11, true) });
}

test('every failed return judge gives back at the next turn end; failed handoff stays strong', async () => {
  for (const [main, cheap] of [[SOL, LUNA], [OPUS, HAIKU]]) for (const reply of [undefined, { ok: false, error: 'timeout' }, { ok: true, text: 'unparsable' }, new Error('offline')]) {
    for (const back of [false, true]) {
      const h = harness(back ? cheap : main, { callCheap: async () => { if (reply instanceof Error) throw reply; return reply; } });
      await judge(h, back);
      assert.equal(h.ctx.model.id, main.id);
      assert.equal(h.switches.length, back ? 1 : 0);
      assert.equal(logEntries(h, back ? 'handback-judge' : 'handoff-judge').length, 1);
    }
  }
});

test('Pi compaction asks for the entire range in a summary only, priced compaction still has KEEP/DECLINE', async () => {
  const calls = [];
  const h = harness(SOL, { callCheap: async (ctx, model, args) => { calls.push(args); return { ok: true, text: '<summary>Full range.</summary>', usage: {} }; } });
  const out = await h.c.onBeforeCompact({ preparation: { firstKeptEntryId: 'tail', messagesToSummarize: [msg(SOL, 1)], turnPrefixMessages: [msg(SOL, 2)], previousSummary: 'Earlier work.', tokensBefore: 1000 } }, h.ctx);
  assert.ok(out.compaction.summary.includes('Full range.'));
  assert.doesNotMatch(calls[0].system, /KEEP|CUT|DECLINE/);
  assert.match(calls[0].system, /whole range/i);
  assert.match(calls[0].user, /Earlier work/); assert.match(calls[0].user, /step 1/); assert.match(calls[0].user, /step 2/);
  assert.match(SUMMARY_SYSTEM, /KEEP/); assert.match(SUMMARY_SYSTEM, /DECLINE/);
});

test('handback-note records the nested call usage', async () => {
  const usage = { input: 500, output: 80, cost: { input: .01, output: .02, total: .03 } };
  const h = harness(SOL, { callCheap: async () => ({ ok: true, text: 'Checked files.', usage }) });
  h.c.state.want = 'handoff'; await h.c.switchAtTurnEnd(h.ctx, {});
  h.entries.push({ type: 'message', id: 'cheap', message: msg(LUNA, 1) });
  h.c.state.want = 'handback'; await h.c.switchAtTurnEnd(h.ctx, {});
  await h.c.handBackView({ messages: [msg(LUNA, 1), msg(SOL, 2)] }, h.ctx);
  assert.deepEqual(logEntries(h, 'handback-note')[0].data.usage, usage);
});

function recordedStint(main = SOL, cheap = LUNA, { active = false, turns = 2, legacy = false } = {}) {
  const entries = [{ type: 'message', id: 'strong', message: msg(main, 1) },
    { type: 'model_change', provider: cheap.provider, modelId: cheap.id },
    { type: 'custom', id: 'handoff', customType: 'sol-pi-v2', data: { mechanism: 'momentum-switch', reason: 'handoff', to: `${cheap.provider}/${cheap.id}`, ...(legacy ? {} : { strong: { provider: main.provider, id: main.id }, cheap: { provider: cheap.provider, id: cheap.id } }) } }];
  for (let i = 0; i < turns; i++) entries.push({ type: 'message', id: `cheap${i}`, message: msg(cheap, i + 2, true) }, { type: 'message', id: `result${i}`, message: result(i + 2) });
  if (!active) entries.push({ type: 'model_change', provider: main.provider, modelId: main.id }, { type: 'custom', customType: 'sol-pi-v2', data: { mechanism: 'momentum-switch', reason: 'handback', to: `${main.provider}/${main.id}` } });
  return entries;
}
const messagesOf = entries => entries.filter(e => e.type === 'message').map(e => e.message);

test('a hand-off note replaces only the recorded turn when providers share a model id and timestamp', async () => {
  const cheap = { ...LUNA, provider: 'cheap', id: SOL.id };
  const entries = recordedStint(SOL, cheap, { turns: 1 });
  const recorded = entries.find(e => e.id === 'cheap0').message;
  recorded.usage = { input: 100000, cost: { total: .05 } };
  const manual = [{ ...recorded, provider: 'manual' }, { ...msg(cheap, 2), usage: recorded.usage }];
  for (const [i, message] of manual.entries()) entries.push({ type: 'message', id: `manual${i}`, message });
  const calls = [];
  const h = harness(SOL, { callCheap: async (_, model, { user }) => { calls.push(user); return { ok: true, text: 'Checked.' }; } }, entries);
  h.ctx.modelRegistry.find = (p, id) => [SOL, cheap].find(m => m.provider === p && m.id === id);
  const { messages } = await h.c.handBackView({ messages: structuredClone(messagesOf(entries)) }, h.ctx);
  assert.deepEqual(messages.slice(2), manual);
  assert.match(messages[1].content[0].text, /Checked\.$/);
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0], /step 2/);
  assert.equal(logEntries(h, 'handback-note')[0].data.stint, 'cheap0');
  assert.ok(Math.abs(savingsOf(entries, h.ctx.modelRegistry).total - .15) < 1e-9);

  // A retained manual entry can project the same content as the compacted cheap turn.
  const sourceEntry = entries.find(e => e.id === 'manual1');
  h.ctx.sessionManager.buildSessionProjection = () => ({ entries: [{ sourceEntry, messages: [recorded] }] });
  assert.equal(await h.c.handBackView({ messages: [structuredClone(recorded)] }, h.ctx), undefined);
});

test('manual model changes never turn another model’s history into an owned stint, including on restart', async () => {
  const entries = [{ type: 'message', id: 's', message: msg(OPUS, 1) }, { type: 'model_change', provider: SOL.provider, modelId: SOL.id }, { type: 'message', id: 'l', message: msg(SOL, 2) }];
  for (let process = 0; process < 2; process++) {
    let calls = 0;
    const h = harness(SOL, { callCheap: async () => { calls++; return { ok: true, text: 'wrong note' }; } }, entries);
    assert.equal(await h.c.handBackView({ messages: messagesOf(entries) }, h.ctx), undefined);
    assert.equal(calls, 0);
  }
});

test('a fresh strong Claude process uses its measured ten-call cadence', async () => {
  let calls = 0;
  const entries = Array.from({ length: 15 }, (_, i) => ({ type: 'message', id: `m${i}`, message: msg(OPUS, i) }));
  entries.push({ type: 'custom', customType: 'sol-pi-v2', data: { mechanism: 'handoff-judge', calls: 10, handoff: false } });
  const h = harness(OPUS, { callCheap: async () => { calls++; return { ok: true, text: '{"handoff":false}' }; } }, entries);
  await h.c.handBackView({ messages: messagesOf(entries) }, h.ctx);
  for (let i = 0; i < 9; i++) h.c.maybeJudge(h.ctx, { message: msg(OPUS, 20 + i, true) });
  await tick(); assert.equal(calls, 0);
  h.c.maybeJudge(h.ctx, { message: msg(OPUS, 24, true) }); await tick();
  assert.equal(calls, 1);
});

test('a process resumed on cheap restores ownership, return cadence and strong history, including from hand-off records that name only their target', async () => {
  for (const [main, cheap] of [[SOL, LUNA], [OPUS, HAIKU]]) for (const legacy of [false, true]) {
    const entries = recordedStint(main, cheap, { active: true, turns: 15, legacy });
    entries.splice(23, 0, { type: 'custom', customType: 'sol-pi-v2', data: { mechanism: 'handback-judge', calls: 10, handback: false } });
    const calls = [];
    const h = harness(cheap, { callCheap: async (ctx, model, args) => { calls.push(args.system); return { ok: true, text: args.system === HANDBACK_NOTE_SYSTEM ? 'Done: checks.' : '{"handback":true}' }; } }, entries);
    assert.equal(await h.c.handBackView({ messages: messagesOf(entries) }, h.ctx), undefined, 'active stint remains intact');
    assert.equal(h.c.state.main?.id, main.id);
    assert.equal(h.c.state.backCalls, 16); assert.equal(h.c.state.backJudgedAt, 10);
    assert.equal(calls.length, 0);
    for (let i = 0; i < 5; i++) h.c.maybeJudge(h.ctx, { message: msg(cheap, 30 + i, true) });
    await tick(); await h.c.switchAtTurnEnd(h.ctx, { message: msg(cheap, 40, true) });
    assert.equal(h.ctx.model.id, main.id);
    const view = await h.c.handBackView({ messages: messagesOf(entries) }, h.ctx);
    assert.deepEqual(view.messages[0], entries[0].message);
    assert.match(view.messages[1].content[0].text, /Done: checks/);
  }
});

test('failed notes retry up to three total attempts across restarts and never become final notes', async () => {
  for (const [main, cheap] of [[SOL, LUNA], [OPUS, HAIKU]]) for (const succeed of [2, Infinity]) {
    const entries = recordedStint(main, cheap); let attempts = 0;
    const opts = { callCheap: async () => { attempts++; return attempts === succeed ? { ok: true, text: 'Checked files.', usage: { output: 80 } } : { ok: false, error: 'timeout', usage: { output: 1 } }; } };
    for (let n = 0; n < 5; n++) {
      const h = harness(main, opts, entries);
      const view = await h.c.handBackView({ messages: messagesOf(entries) }, h.ctx);
      if (n === 0) {
        assert.equal(logEntries(h, 'handback-note').length, 0, 'failure is not a final note');
        if (main === OPUS) assert.ok(view.messages.at(-1).content[0].text.endsWith(NO_NOTE));
        else assert.equal(view, undefined);
      }
      if (n >= 1 && succeed === 2) assert.match(view.messages.at(-1).content[0].text, /Checked files/);
    }
    assert.equal(attempts, Math.min(3, succeed));
  }
});

test('finished background results survive the cheap stint note verbatim, with bounded head and tail', async () => {
  const entries = recordedStint(OPUS, HAIKU, { active: true }); let finish;
  const h = harness(HAIKU, { yieldMs: 1, callCheap: async () => ({ ok: true, text: 'A short note without the result.' }) }, entries);
  await h.c.handBackView({ messages: messagesOf(entries) }, h.ctx);
  const raw = 'HEAD exact 42\n' + 'x'.repeat(5000) + '\nTAIL exact error: 17';
  await h.c.yieldingBash({ execute: () => new Promise(r => { finish = r; }) }, 'job', { command: 'run-checks' }, undefined, h.ctx);
  finish({ content: [{ type: 'text', text: raw }], structuredContent: { exit_code: 17 }, isError: true }); await tick();
  const [carrier] = entries.splice(entries.findIndex(e => e.id === 'result1'), 1);
  const event = { toolCallId: 't3', content: [{ type: 'text', text: 'ordinary result' }] };
  const delivered = h.c.backgroundNotices(event, h.ctx);
  carrier.message.content = delivered.content; entries.push(carrier);
  h.c.state.want = 'handback'; await h.c.switchAtTurnEnd(h.ctx, {});
  const view = await h.c.handBackView({ messages: messagesOf(entries) }, h.ctx);
  assert.match(view.messages[1].content[0].text, /short note/);
  const carried = view.messages[2].content[0].text;
  assert.match(carried, /Background job 1.*min.*failed.*17.*run-checks/);
  assert.ok(carried.includes('HEAD exact 42\n')); assert.ok(carried.endsWith('\nTAIL exact error: 17'));
  assert.ok(carried.length < 4200);
  const resumed = harness(OPUS, { callCheap: async () => { throw new Error('must reuse note'); } }, entries);
  assert.deepEqual((await resumed.c.handBackView({ messages: messagesOf(entries) }, resumed.ctx)).messages, view.messages);
});

test('undelivered finished and interrupted background jobs survive process exit and deliver once', async () => {
  const h = harness(OPUS, { yieldMs: 1 }); let finish;
  await h.c.yieldingBash({ execute: () => new Promise(r => { finish = r; }) }, 'job1', { command: 'finished-check' }, undefined, h.ctx);
  finish({ content: [{ type: 'text', text: 'EXACT finished output' }], structuredContent: { exit_code: 0 } }); await tick();
  await h.c.yieldingBash({ execute: () => new Promise(() => {}) }, 'job2', { command: 'interrupted-check' }, undefined, h.ctx);
  assert.equal(logEntries(h, 'bash-yield-result').length, 1, 'completion is durable before delivery');
  const resumed = harness(OPUS, {}, h.entries);
  assert.equal(resumed.c.backgroundNotices({ parentToolCallId: 'nested', content: [] }, resumed.ctx), undefined);
  const delivered = resumed.c.backgroundNotices({ toolCallId: 'next', content: [] }, resumed.ctx);
  const text = delivered.content[0].text;
  assert.match(text, /job 1.*exit 0.*finished-check/); assert.match(text, /EXACT finished output/);
  assert.match(text, /job 2.*not captured.*interrupted-check/);
  h.entries.push({ type: 'message', message: { role: 'toolResult', toolCallId: 'next', content: delivered.content } });
  assert.equal(resumed.c.backgroundNotices({ toolCallId: 'later', content: [] }, resumed.ctx), undefined);
  const again = harness(OPUS, {}, h.entries);
  assert.equal(again.c.backgroundNotices({ toolCallId: 'another', content: [] }, again.ctx), undefined);
});

test('stop hint names only a verified shell PID, never command text', async () => {
  const { yieldText } = await import('../extension.js');
  assert.match(yieldText(2, 1, 12345), /kill -TERM 12345$/);
  assert.doesNotMatch(yieldText(2, 1, 'npm test | tee build.log'), /kill|npm/);
});

test('Pi package lookup can inject resolution independently of the installed host', async () => {
  const { piPackage } = await import('../extension.js');
  const fake = { createBashToolDefinition: () => 'injected' };
  assert.equal(await piPackage('/nonexistent/pi', async () => fake), fake);
  assert.deepEqual(await piPackage('/nonexistent/pi', async () => { throw new Error('missing'); }), {});
});

test('known pairs beat unrelated cheaper models; explicit overrides and unknown-model fallback still work', async () => {
  const { resolveCheapModel, resolveHandoffModel, resolveJudgeModel } = await import('../lib/summarizer.js');
  for (const [main, cheap] of [[SOL, LUNA], [OPUS, HAIKU]]) for (const prefix of ['', 'route/family/']) {
    const strong = { ...main, id: prefix + main.id }, target = { ...cheap, id: prefix + cheap.id }, tiny = { ...cheap, id: 'unrelated-tiny', cost: { input: .001, output: .001 } };
    const available = [strong, target, tiny, ...models];
    const ctx = { model: strong, modelRegistry: { getAvailable: () => available, hasConfiguredAuth: () => true, find: (p, id) => available.find(m => m.provider === p && m.id === id) } };
    for (const [resolve, env] of [[resolveHandoffModel, 'SOLPI_HANDOFF_MODEL'], [resolveJudgeModel, 'SOLPI_JUDGE_MODEL'], [resolveCheapModel, 'SOLPI_SUMMARY_MODEL']]) {
      assert.equal(resolve(ctx, {}).id.split('/').at(-1), cheap.id);
      assert.equal(resolve(ctx, { [env]: `${tiny.provider}/${tiny.id}` }), tiny);
      assert.equal(resolve({ ...ctx, model: { ...strong, id: 'unknown-large' } }, {}), tiny);
    }
    assert.equal(resolveJudgeModel(ctx, { SOLPI_JUDGE_MODEL: 'openai/gpt-6-luna' }).id, LUNA.id);
  }
});

test('the Pi package manifest exposes exactly the standalone extension', async () => {
  const { readFile } = await import('node:fs/promises');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.name, 'sol-pi-v2'); assert.deepEqual(pkg.pi, { extensions: ['./pi-entry.ts'] });
  assert.equal(pkg.peerDependencies['@earendil-works/pi-coding-agent'], '*');
  assert.equal(pkg.dependencies, undefined);
});

test('TUI switches notify once with net token savings including judges and notes; print and RPC stay silent', async () => {
  for (const mode of ['tui', 'print', 'rpc']) {
    const h = harness(SOL, { callCheap: async () => ({ ok: true, text: 'Done: checked files.', usage: { cost: { total: .03 } } }) });
    h.ctx.mode = mode;
    h.pi.appendEntry('sol-pi-v2', { mechanism: 'handoff-judge', handoff: true, judge: 'openai/gpt-6-luna', usage: { cost: { total: .01 } } });
    h.c.state.want = 'handoff'; await h.c.switchAtTurnEnd(h.ctx, {});
    h.entries.push({ type: 'message', message: { ...msg(LUNA, 3), usage: { input: 100000, cacheRead: 200000, cacheWrite: 10000, output: 1000, cost: { total: .05 } } } });
    h.pi.appendEntry('sol-pi-v2', { mechanism: 'handback-judge', handback: true, judge: 'openai/gpt-6-luna', usage: { cost: { total: .02 } } });
    h.c.state.want = 'handback'; await h.c.switchAtTurnEnd(h.ctx, {});
    if (mode === 'tui') {
      assert.equal(h.notices.length, 2);
      assert.match(h.notices[0][0], /⚡ SoL-Pi · handed to gpt-6-luna/);
      assert.match(h.notices[1][0], /⚡ SoL-Pi · back on gpt-6.1-sol/);
      assert.match(h.notices[1][0], /Money saved · ~\$0.14 \(this stint\) · ~\$0.14 \(this session\)/);
      assert.match(h.statuses.at(-1)[1], /⚡.*gpt-6.1-sol.*~\$0.14/);
      const view = await h.c.handBackView({ messages: messagesOf(h.entries) }, h.ctx);
      assert.ok(view); assert.equal(h.notices.length, 2, 'later contexts do not repeat the notice');
    } else {
      assert.deepEqual(h.notices, []); assert.deepEqual(h.statuses, []);
      assert.equal(logEntries(h, 'handback-note').length, 0, 'non-interactive note timing is unchanged');
    }
  }
});

test('errored and aborted cheap turns cost money without saving strong-model tokens', async () => {
  for (const stopReason of ['error', 'aborted']) {
    const h = harness(SOL, { callCheap: async () => ({ ok: true, text: 'Done.' }) });
    h.ctx.mode = 'tui';
    h.c.state.want = 'handoff'; await h.c.switchAtTurnEnd(h.ctx, {});
    h.entries.push({ type: 'message', message: { ...msg(LUNA, 3), stopReason, usage: { input: 100000, cost: { total: .05 } } } });
    h.c.state.want = 'handback'; await h.c.switchAtTurnEnd(h.ctx, {});
    assert.match(h.notices.at(-1)[0], /Money saved · ~\$-0\.05 \(this stint\) · ~\$-0\.05 \(this session\)/);
    assert.match(h.statuses.at(-1)[1], /~\$-0\.05 saved/);
  }
});

test('session totals are rebuilt after restart and include failed note attempts and every judge call', async () => {
  const h = harness(SOL, { callCheap: async () => ({ ok: true, text: 'Done.', usage: { cost: { total: .02 } } }) }, recordedStint());
  for (const e of h.entries) if (e.message?.model === LUNA.id) e.message.usage = { input: 100000, output: 1000, cost: { total: .03 } };
  h.pi.appendEntry('sol-pi-v2', { mechanism: 'handback-note-attempt', stint: `${LUNA.id}@2`, attempt: 1, usage: { cost: { total: .01 } } });
  h.pi.appendEntry('sol-pi-v2', { mechanism: 'handoff-judge', handoff: false, usage: { cost: { total: .03 } } });
  await h.c.handBackView({ messages: messagesOf(h.entries) }, h.ctx);
  // 2 * ($0.20 input + $0.01 output - $0.03 actual), minus $0.06 nested costs.
  assert.ok(Math.abs(savingsOf(h.entries, h.ctx.modelRegistry).total - .30) < 1e-9);
  const resumed = harness(SOL, {}, h.entries); resumed.ctx.mode = 'tui';
  resumed.c.status(resumed.ctx);
  assert.match(resumed.statuses.at(-1)[1], /~\$0.30/);
});

test('manual selections cancel pending handoffs, and session_start restores independent session state and tools', async () => {
  const h = harness(SOL, { callCheap: async () => ({ ok: true, text: '{"handoff":true}' }) });
  const registered = [];
  h.pi.registerTool = t => registered.push(t);
  const c = installWith(h.pi, () => ({ name: 'bash', description: 'Pi bash.', parameters: {}, execute() {} }));
  await h.handlers.get('session_start')({ reason: 'startup' }, h.ctx);
  await h.handlers.get('before_agent_start')({}, h.ctx);
  c.state.want = 'handoff';
  h.ctx.model = OPUS;
  await h.handlers.get('model_select')({ model: OPUS, source: 'set' }, h.ctx);
  await h.handlers.get('turn_end')({ message: msg(OPUS, 1, true) }, h.ctx);
  assert.deepEqual(h.switches, []);
  assert.match(registered.at(-1).description, /still running/);
  h.ctx.model = SOL; h.entries.length = 0;
  await h.handlers.get('session_start')({ reason: 'new' }, h.ctx);
  await h.handlers.get('before_agent_start')({}, h.ctx);
  assert.equal(registered.at(-1).description, 'Pi bash.');
  assert.equal(await h.handlers.get('before_provider_request')({ payload: { input: [] } }, h.ctx), undefined);
});

test('default install wires both lookup outcomes without depending on host resolution', async () => {
  const { default: install } = await import('../extension.js');
  for (const available of [false, true]) {
    const h = harness(OPUS), tools = [];
    h.pi.registerTool = t => tools.push(t);
    await install(h.pi, async () => available ? { createBashToolDefinition: () => ({ name: 'bash', description: 'Pi bash.', parameters: {}, execute() {} }) } : {});
    for (const name of ['session_start', 'turn_end', 'context', 'before_provider_request', 'session_before_compact', 'agent_end']) assert.equal(typeof h.handlers.get(name), 'function');
    await h.handlers.get('session_start')({ reason: 'startup' }, h.ctx);
    await h.handlers.get('before_agent_start')({}, h.ctx);
    assert.equal(tools.length, available ? 1 : 0);
    assert.equal(h.handlers.has('tool_result'), available);
  }
});
