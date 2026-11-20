import test from 'node:test';
import assert from 'node:assert/strict';
import { installWith } from '../extension.js';
import { backgroundJobs } from '../lib/jobs.js';
import { SOL, LUNA, OPUS, HAIKU, models, LOG, tick, textOf, messagesOf, records, harness, startStint, finishStint, compact } from './fixture.js';

const viewOf = (h, messages = messagesOf(h)) => h.c.handBackView({ messages }, h.ctx);
const receipt = (h, toolCallId, content) => h.add({ type: 'message', message: { role: 'toolResult', toolCallId, content } });
async function finishJob(h) {
  let finish;
  await h.c.yieldingBash({ execute: () => new Promise(r => { finish = r; }) }, 'job', { command: 'check' }, undefined, h.ctx);
  finish({ content: [{ type: 'text', text: 'display tail' }], structuredContent: { output: 'HEAD_MARK' + 'x'.repeat(9000) + 'TAIL_MARK', exit_code: 0 } });
  await tick();
}

test('steering and a compacted suffix use their own saved note on both APIs', async () => {
  for (const main of [SOL, OPUS]) {
    const opts = { callCheap: async (_, model, { user }) => ({ ok: true, text: [...user.matchAll(/result (\d+)/g)].map(m => m[1]).join('+') }) };
    const h = harness(main, opts); await startStint(h);
    const steering = h.add({ type: 'message', message: { role: 'user', content: 'Change direction' } }).message;
    h.turn(4); await finishStint(h);
    const view = await viewOf(h), at = view.messages.indexOf(steering);
    assert.match(view.messages[at - 1].content[0].text, /\n2\+3$/);
    assert.match(view.messages[at + 1].content[0].text, /\n4$/);
    const suffix = messagesOf(h).slice(messagesOf(h).findIndex(m => m.timestamp === 3));
    const resumed = harness(main, opts, h.entries);
    assert.match((await viewOf(resumed, suffix)).messages[0].content[0].text, /\n3$/);
    assert.equal(records(h, 'handback-note').length, 3);
  }
});
test('restarting during the writer cannot send a fourth attempt', async () => {
  for (const main of [SOL, OPUS]) {
    const pending = [], opts = { callCheap: () => new Promise(r => pending.push(r)) };
    const h = harness(main, opts); await startStint(h); await finishStint(h);
    const views = Array.from({ length: 4 }, () => viewOf(harness(main, opts, h.entries)));
    assert.equal(pending.length, 3);
    assert.deepEqual(records(h, 'handback-note-attempt').map(e => e.data.attempt), [1, 2, 3]);
    for (const resolve of pending) resolve({ ok: false }); await Promise.all(views);
  }
});
test('a legacy success counts toward the budget but cannot summarize a different range', async () => {
  let calls = 0; const h = harness(SOL, { callCheap: async () => { calls++; return { ok: true, text: 'fourth call' }; } });
  await startStint(h); await finishStint(h); const stint = records(h, 'momentum-switch')[0].id;
  for (const attempt of [1, 2]) h.pi.appendEntry(LOG, { mechanism: 'handback-note-attempt', stint, attempt });
  h.pi.appendEntry(LOG, { mechanism: 'handback-note', stint, steps: 4, written: true, note: 'all four steps' });
  assert.match(textOf(await viewOf(h)), /all four steps/);
  assert.equal(await viewOf(h, messagesOf(h).slice(-2)), undefined); assert.equal(calls, 0);
});
test('clip structured output rather than the bash display tail', async () => {
  const h = harness(OPUS, { yieldMs: 1 }); await finishJob(h);
  assert.match(records(h, 'bash-yield-result')[0].data.text, /^HEAD_MARK.{0,2000}\n\[.*omitted.*\]\n.{0,2000}TAIL_MARK$/);
});
test('only a persisted carrier counts as delivery, including without a restart', async () => {
  const h = harness(OPUS, { yieldMs: 1 }); await startStint(h); await finishJob(h);
  const offer = h.c.backgroundNotices({ toolCallId: 'lost' }, h.ctx);
  receipt(h, 'lost', [{ type: 'text', text: 'different result, same id' }]);
  assert.equal(h.c.backgroundNotices({ toolCallId: 'same-batch' }, h.ctx), undefined); h.c.jobs.endBatch();
  for (const c of [h.c, harness(HAIKU, {}, h.entries).c]) assert.deepEqual(c.backgroundNotices({ toolCallId: 'retry' }, h.ctx), offer);
  receipt(h, 'retry', offer.content);
  assert.equal(h.c.backgroundNotices({ toolCallId: 'next' }, h.ctx), undefined);
});
test('TUI pricing cannot acknowledge a result before outgoing strong context', async () => {
  const h = harness(OPUS, { yieldMs: 1, callCheap: async () => ({ ok: true, text: 'note' }) }); h.ctx.mode = 'tui';
  await startStint(h); await finishJob(h);
  receipt(h, 'delivery', h.c.backgroundNotices({ toolCallId: 'delivery' }, h.ctx).content);
  await finishStint(h);
  assert.equal(records(h, 'bash-yield-handover').length, 0);
  h.add({ type: 'compaction' });
  assert.match(textOf(await viewOf(h, [{ role: 'compactionSummary', summary: 'summary' }])), /Background job 1/);
  assert.equal(records(h, 'bash-yield-handover').length, 1);
});
test('TUI prices the projected range; a carried result follows only its own note', async () => {
  const h = harness(OPUS, { yieldMs: 1, callCheap: async (_, model, { user }) => ({ ok: true, text: user.includes('result 4') ? 'second note' : 'first note' }) });
  await startStint(h); const steering = h.add({ type: 'message', message: { role: 'user', content: 'other work' } }).message;
  h.turn(4); await finishJob(h); receipt(h, 'delivery', h.c.backgroundNotices({ toolCallId: 'delivery' }, h.ctx).content);
  h.ctx.mode = 'tui'; h.ctx.sessionManager.buildSessionProjection = () => ({ messages: messagesOf(h).slice(-3) });
  await finishStint(h); assert.deepEqual(records(h, 'handback-note').map(e => e.data.note), ['second note']);
  const out = (await viewOf(h)).messages, split = out.indexOf(steering);
  assert.match(out[split - 1].content[0].text, /first note$/); assert.match(out[split + 1].content[0].text, /second note$/);
  assert.match(out[split + 2].content[0].text, /^\[Background job 1/); assert.equal(out.length, split + 3);
});
test('measured bash-yield-end and its persisted tool result are a delivery', async () => {
  const h = harness(OPUS, { callCheap: async () => ({ ok: true, text: 'note' }) }); await startStint(h);
  h.pi.appendEntry(LOG, { mechanism: 'bash-yield', job: 1 });
  h.pi.appendEntry(LOG, { mechanism: 'bash-yield-end', jobs: [{ job: 1, minutes: 2, failed: false }] });
  const text = '[Background job 1 ended after 2 min: check]\nlegacy output';
  receipt(h, 'old', [{ type: 'text', text: '\n\n' + text }]); await finishStint(h);
  assert.equal(h.c.backgroundNotices({ toolCallId: 'new' }, h.ctx), undefined);
  assert.equal((await viewOf(h)).messages.at(-1).content[0].text, text);
});
test('restart after a refused return at 10 waits until call 20 on both APIs', async () => {
  for (const main of [SOL, OPUS]) {
    const h = harness(main, { callCheap: async () => ({ ok: true, text: '{"handback":false}' }) });
    h.c = installWith(h.pi, null, h.options); await h.handlers.get('session_start')({}, h.ctx);
    h.c.state.want = 'handoff';
    for (let i = 1; i <= 20; i++) {
      await h.handlers.get('turn_end')({ message: h.turn(i) }, h.ctx); await tick();
      if (i === 10) await h.handlers.get('session_start')({}, h.ctx);
      assert.deepEqual(records(h, 'handback-judge').map(e => e.data.calls), i < 10 ? [] : i < 20 ? [10] : [10, 20]);
    }
  }
});
test('a remote bash stays remote on both APIs and logs one skipped wrapper', async () => {
  const h = harness(); const remote = { name: 'bash', sourceInfo: { path: '/extensions/ssh.js', source: 'local' } };
  h.pi.getAllTools = () => [remote]; h.pi.registerTool = () => assert.fail('replaced remote bash');
  installWith(h.pi, () => ({ name: 'bash', description: 'local', parameters: {} }));
  await h.handlers.get('session_start')({}, h.ctx);
  await h.handlers.get('before_agent_start')({}, h.ctx);
  for (const m of [OPUS, SOL, OPUS]) await h.pi.setModel(m);
  assert.equal(records(h, 'bash-yield-skipped').length, 1);
});
test('session_tree discards pending jobs, judges and notes from a sibling', async () => {
  for (const pending of ['job', 'judge', 'note']) {
    let finish; const wait = () => new Promise(r => { finish = r; });
    const h = harness(OPUS, { yieldMs: 1, callCheap: wait }); h.c = installWith(h.pi, null, h.options);
    await h.handlers.get('session_start')({}, h.ctx); let view;
    if (pending === 'job') await h.c.yieldingBash({ execute: wait }, 'job', { command: 'old' }, undefined, h.ctx);
    if (pending === 'judge') for (let i = 0; i < 10; i++) h.c.maybeJudge(h.ctx, { message: h.turn(i) });
    if (pending === 'note') { await startStint(h); await finishStint(h); view = viewOf(h); }
    await tick(); const parent = records(h, 'momentum-switch')[0]; h.entries.splice(parent ? h.entries.indexOf(parent) + 1 : 0);
    await h.handlers.get('session_tree')?.({}, h.ctx); const count = h.entries.length;
    finish({ ok: true, text: pending === 'judge' ? '{"handoff":true}' : 'sibling note' });
    assert.equal(await view, undefined); await tick(); assert.equal(h.entries.length, count);
    if (parent) {
      h.turn(20, HAIKU); h.turn(21); const next = h.handlers.get('context')({ messages: messagesOf(h) }, h.ctx);
      finish({ ok: true, text: 'new branch' }); assert.match(textOf(await next), /new branch/);
    }
  }
});
test('manual selection during awaited setModel cancels switch ownership', async () => {
  for (const selection of [[OPUS], [OPUS, LUNA]]) {
    const h = harness(); let release; const set = h.pi.setModel;
    h.pi.setModel = async m => { await set(m); await new Promise(r => { release = r; }); return true; };
    h.c = installWith(h.pi, null, h.options); h.c.state.want = 'handoff';
    const moving = h.c.switchAtTurnEnd(h.ctx, {}); await tick();
    for (const model of selection) await set(model); release(); await moving;
    assert.equal(h.c.state.main, null); assert.equal(h.c.state.epoch, selection.length); assert.equal(records(h, 'momentum-switch').length, 0);
  }
});
test('a stale judge neither blocks nor clears the new selection’s judge', async () => {
  const pending = [], h = harness(SOL, { callCheap: () => new Promise(r => pending.push(r)) });
  const turns = async n => { for (let i = 0; i < n; i++) h.c.maybeJudge(h.ctx, { message: h.turn(i) }); await tick(); };
  await turns(10); h.ctx.model = OPUS; h.c.modelSelected({ model: OPUS, source: 'set' }); await turns(10);
  assert.equal(pending.length, 2); pending[0]({ ok: true, text: '{"handoff":true}' }); await tick(); await turns(10);
  assert.equal(pending.length, 2); assert.equal(h.c.state.want, null);
  pending[1]({ ok: true, text: '{"handoff":false}' }); await tick(); await turns(1); assert.equal(pending.length, 3);
});
test('a judge that returns after its session ended is dropped without an unhandled rejection', async () => {
  const pending = [], h = harness(SOL, { callCheap: () => new Promise(r => pending.push(r)) });
  for (let i = 0; i < 10; i++) { h.c.maybeJudge(h.ctx, { message: h.turn(i) }); await tick(); }
  assert.equal(pending.length, 1);
  Object.defineProperty(h.ctx, 'model', { get() { throw new Error('This extension ctx is stale after session replacement or reload.'); } });
  const rejections = [], onRejection = e => rejections.push(e); process.on('unhandledRejection', onRejection);
  try { pending[0]({ ok: true, text: '{"handoff":true}' }); for (let i = 0; i < 3; i++) await tick(); } finally { process.off('unhandledRejection', onRejection); }
  assert.deepEqual(rejections, []); assert.equal(h.c.state.want, null);
});
test('invalid, self, cross-API and absent targets incur no forward judge', async () => {
  for (const target of ['anthropic/' + HAIKU.id, 'openai/' + SOL.id, 'openai/missing', null]) {
    let calls = 0; const h = harness(SOL, { callCheap: async () => { calls++; return { ok: true, text: '{"handoff":true}' }; } });
    if (target) process.env.SOLPI_HANDOFF_MODEL = target;
    else { h.ctx.modelRegistry.getAvailable = () => [SOL]; process.env.SOLPI_JUDGE_MODEL = 'anthropic/' + HAIKU.id; }
    try {
      for (let i = 0; i < 21; i++) { h.c.maybeJudge(h.ctx, { message: h.turn(i) }); await tick(); }
      assert.equal(calls, 0); assert.equal(records(h, 'model-override').length, target ? 1 : 0);
    } finally { delete process.env.SOLPI_HANDOFF_MODEL; delete process.env.SOLPI_JUDGE_MODEL; }
  }
});
test('Pi compaction uses the owner’s known writer mid-stint, unless overridden', async () => {
  for (const [strong, cheap] of [[SOL, LUNA], [OPUS, HAIKU]]) {
    const calls = [], h = harness(strong, { callCheap: async (_, m) => { calls.push(m); return { ok: true, text: '<summary>done</summary>' }; } });
    h.ctx.modelRegistry.getAvailable = () => [...models, { ...cheap, id: 'tiny', cost: { input: .01 } }];
    await startStint(h); await compact(h, messagesOf(h).at(-1));
    process.env.SOLPI_SUMMARY_MODEL = SOL.provider + '/' + SOL.id;
    try { await compact(h, messagesOf(h).at(-1)); } finally { delete process.env.SOLPI_SUMMARY_MODEL; }
    assert.deepEqual(calls, [cheap, SOL]);
  }
});
test('warmed outstanding() does not touch the branch with no deliveries', () => {
  let reads = 0; const ctx = { sessionManager: { getBranch: () => { reads++; return []; } } };
  const jobs = backgroundJobs(); jobs.outstanding(SOL, ctx); reads = 0;
  assert.deepEqual(jobs.outstanding(SOL, ctx), []); assert.equal(reads, 0);
});
