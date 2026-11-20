// Round-two review regressions; all calls and sessions are offline fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installWith, HANDBACK_NOTE_SYSTEM, NO_NOTE } from '../extension.js';
import { handoffsOf, modelRef } from '../lib/session.js';
import { savingsOf } from '../lib/savings.js';
import { SOL, LUNA, OPUS, HAIKU, LOG, tick, textOf, messagesOf, records, harness, startStint, finishStint, compact } from './fixture.js';

test('#7 bug 1: background delivery belongs to its handoff across compaction and restart', async () => {
  for (const keepCheap of [true, false]) {
    const opts = { yieldMs: 1, callCheap: async (ctx, model, args) => ({ ok: true, text: args.system === HANDBACK_NOTE_SYSTEM ? 'Checked files.' : '<summary>Compacted work.</summary>' }) };
    const h = harness(OPUS, opts); await startStint(h);
    let finish;
    await h.c.yieldingBash({ execute: () => new Promise(r => { finish = r; }) }, 'background', { command: 'run-checks' }, undefined, h.ctx);
    finish({ content: [{ type: 'text', text: 'UNIQUE_RAW_RESULT_314159' }], structuredContent: { exit_code: 17 }, isError: true }); await tick();
    const delivery = h.c.backgroundNotices({ toolCallId: 'carrier', content: [] }, h.ctx);
    h.add({ type: 'message', message: { role: 'toolResult', toolCallId: 'carrier', ...delivery } });
    const tail = h.turn(4);
    const projected = await compact(h, keepCheap ? tail : h.add({ type: 'message', message: { role: 'user', content: 'Continue.', timestamp: 5 } }).message);
    await finishStint(h);
    const restarted = harness(OPUS, opts, h.entries);
    const view = await restarted.c.handBackView({ messages: projected }, restarted.ctx);
    assert.match(textOf(view), /UNIQUE_RAW_RESULT_314159/);
    assert.match(textOf(view), /job 1.*failed; exit 17.*run-checks/);
    assert.equal(records(h, 'bash-yield-end')[0].data.stint, records(h, 'momentum-switch')[0].id);
    if (keepCheap) assert.ok(textOf(view).indexOf('Checked files.') < textOf(view).indexOf('UNIQUE_RAW_RESULT'));
    assert.deepEqual(await restarted.c.handBackView({ messages: projected }, restarted.ctx), view, 'same visible stint keeps a stable request');
    h.add({ type: 'compaction', summary: 'Later summary.', firstKeptEntryId: 'later' });
    const later = [{ role: 'compactionSummary', summary: 'Later summary.', timestamp: 200 }];
    const again = harness(OPUS, opts, h.entries);
    assert.equal(await again.c.handBackView({ messages: later }, again.ctx), undefined, 'already handed results need no replay after another compaction');
  }
});

test('#5 bug 1: unconsumed return judgments survive restart before the cadence on both APIs', async () => {
  for (const main of [SOL, OPUS]) for (const reply of [{ ok: true, text: '{"handback":true}' }, { ok: false, error: 'offline' }, undefined, { ok: true, text: 'invalid' }, new Error('offline')]) {
    const h = harness(main, { callCheap: async () => { if (reply instanceof Error) throw reply; return reply; } });
    await startStint(h);
    for (let i = 0; i < 10; i++) h.c.maybeJudge(h.ctx, { message: h.turn(10 + i) });
    await tick(); assert.equal(h.c.state.want, 'handback');
    const resumed = harness(h.ctx.model, { callCheap: async () => assert.fail('pending return must precede the next judge') }, h.entries);
    resumed.c = installWith(resumed.pi, null, resumed.options);
    await resumed.handlers.get('session_start')({}, resumed.ctx);
    assert.equal(resumed.c.state.want, 'handback');
    await resumed.handlers.get('turn_end')({ message: resumed.turn(30) }, resumed.ctx);
    assert.equal(resumed.ctx.model.id, main.id);
    const again = harness(main, {}, h.entries);
    again.c.restoreHandoff(again.ctx); again.c.restoreCadence(again.ctx);
    assert.equal(again.c.state.want, null, 'consumed return is not replayed');
  }
  const ended = harness(); await startStint(ended);
  ended.c.state.want = 'handback'; await ended.c.onAgentEnd(ended.ctx);
  assert.equal(ended.c.state.want, null, 'agent end also consumes a pending return');
  for (const main of [SOL, OPUS]) {
    const h = harness(main, { callCheap: async () => ({ ok: false, error: 'offline' }) });
    h.c = installWith(h.pi, null, h.options);
    await h.handlers.get('session_start')({}, h.ctx);
    h.c.state.want = 'handoff';
    for (let i = 1; i <= 10; i++) await h.handlers.get('turn_end')({ message: h.turn(i) }, h.ctx);
    await tick();
    assert.equal(handoffsOf(h.entries).active.keys.size, 9, 'Pi’s handoff turn also increments the live return counter');
    assert.equal(h.c.state.want, 'handback');
    const resumed = harness(h.ctx.model, {}, h.entries);
    resumed.c.restoreHandoff(resumed.ctx); resumed.c.restoreCadence(resumed.ctx);
    assert.equal(resumed.c.state.want, 'handback', 'pending decision is independent of reconstructed counts');
    await resumed.c.switchAtTurnEnd(resumed.ctx, { message: resumed.turn(11) });
    assert.equal(resumed.ctx.model.id, main.id);
  }
});

test('#7 bug 2: the three note attempts belong to the durable handoff after compaction', async () => {
  for (const main of [SOL, OPUS]) {
    let calls = 0;
    const opts = { callCheap: async (ctx, model, args) => args.system === HANDBACK_NOTE_SYSTEM ? (calls++, { ok: false, error: 'offline' }) : { ok: true, text: '<summary>Earlier work.</summary>' } };
    const h = harness(main, opts); await startStint(h); await finishStint(h);
    for (let i = 0; i < 3; i++) await h.c.handBackView({ messages: messagesOf(h) }, h.ctx);
    const projected = await compact(h, h.entries.find(e => e.message?.role === 'assistant' && e.message.timestamp === 3).message);
    for (let i = 0; i < 3; i++) {
      const resumed = harness(main, opts, h.entries);
      const view = await resumed.c.handBackView({ messages: projected }, resumed.ctx);
      if (main === OPUS) assert.ok(textOf(view).includes(NO_NOTE)); else assert.equal(view, undefined);
    }
    assert.equal(calls, 3);
    assert.ok(records(h, 'handback-note-attempt').every(e => e.data.stint === records(h, 'momentum-switch')[0].id));
  }
});

test('Pi model_change ids are entry ids, including setModel reasserting the cheap model', async () => {
  for (const main of [SOL, OPUS]) {
    const h = harness(main); await startStint(h);
    await h.pi.setModel(h.ctx.model);
    assert.deepEqual(modelRef(h.entries.at(-1)), { provider: h.ctx.model.provider, id: h.ctx.model.id });
    const resumed = harness(h.ctx.model, {}, h.entries);
    resumed.c.restoreHandoff(resumed.ctx);
    assert.equal(resumed.c.state.main?.id, main.id);
    assert.equal(handoffsOf(h.entries).active?.keys.size, 2);
  }
});

test('A5 / B1: GPT → Claude → GPT preserves Pi’s effective bash options and command prefix', async () => {
  const h = harness();
  const made = [];
  const factory = (cwd, options = {}) => {
    made.push({ cwd, options });
    return { name: 'bash', description: 'Configured Pi bash.', parameters: {}, execute: async (id, params) => ({ content: [{ type: 'text', text: `${options.shellPath}: ${options.commandPrefix}; ${params.command}` }] }) };
  };
  const original = factory(h.ctx.cwd, { shellPath: '/bin/bash', commandPrefix: h.pi.getSettings().shellCommandPrefix });
  h.tools.set('bash', original);
  installWith(h.pi, factory);
  await h.handlers.get('session_start')({}, h.ctx);
  await h.handlers.get('before_agent_start')({}, h.ctx);
  assert.equal(h.tools.get('bash'), original, 'GPT startup uses the original host tool');
  for (const model of [OPUS, SOL]) {
    await h.pi.setModel(model);
    const bash = h.tools.get('bash');
    const out = await bash.execute('check', { command: 'check' }, undefined, undefined, h.ctx);
    assert.match(textOf(out), /\/bin\/bash: export CONFIGURED_SHELL_PREFIX=present; check/);
    assert.equal(bash.description.includes('still running'), model === OPUS);
  }
  assert.ok(made.every(x => x.cwd === h.ctx.cwd && x.options.shellPath === '/bin/bash'));
  const { default: install } = await import('../extension.js');
  const normalized = harness(OPUS);
  normalized.pi.getSettings = () => ({ shellPath: 'file:///bin/bash', shellCommandPrefix: 'configured prefix' });
  await install(normalized.pi, async () => ({
    createBashToolDefinition: factory,
    SettingsManager: { inMemory: settings => { assert.equal(settings.shellPath, 'file:///bin/bash'); return { getShellPath: () => '/bin/bash' }; } },
  }));
  await normalized.handlers.get('session_start')({}, normalized.ctx);
  await normalized.handlers.get('before_agent_start')({}, normalized.ctx);
  assert.deepEqual(made.at(-1).options, { shellPath: '/bin/bash', commandPrefix: 'configured prefix' });
});

test('stale judge usage survives but its model and epoch cannot restore another selection’s cadence', async () => {
  for (const selected of [OPUS, SOL]) {
    let finish;
    const h = harness(SOL, { callCheap: () => new Promise(r => { finish = r; }) });
    for (let i = 1; i <= 10; i++) h.c.maybeJudge(h.ctx, { message: h.turn(i) });
    await tick();
    h.ctx.model = selected; h.add({ type: 'model_change', provider: selected.provider, modelId: selected.id });
    h.c.modelSelected({ model: selected, source: 'set' });
    for (let i = 20; i < 32; i++) h.c.maybeJudge(h.ctx, { message: h.turn(i) });
    finish({ ok: true, text: '{"handoff":true}', usage: { cost: { total: .03 } } }); await tick();
    const d = records(h, 'handoff-judge')[0].data;
    assert.deepEqual(d.model, { provider: SOL.provider, id: SOL.id });
    assert.equal(d.epoch, 0); assert.equal(d.stale, true);
    assert.equal(savingsOf(h.entries, h.ctx.modelRegistry).total, -.03);
    let judges = 0;
    const resumed = harness(selected, { callCheap: async () => { judges++; return { ok: true, text: '{"handoff":false}' }; } }, h.entries);
    resumed.c.restoreHandoff(resumed.ctx); resumed.c.restoreCadence(resumed.ctx);
    assert.equal(resumed.c.state.calls, 12);
    assert.equal(resumed.c.state.judgedAt ?? null, null);
    resumed.c.maybeJudge(resumed.ctx, { message: resumed.turn(33) }); await tick();
    assert.equal(judges, 1);
    assert.equal(records(h, 'handoff-judge').at(-1).data.epoch, 1);
  }
});

test('unresolved explicit role overrides are logged, noticed only in TUI, and behave as no cheaper model', async () => {
  for (const role of ['HANDOFF', 'JUDGE', 'SUMMARY']) for (const mode of ['tui', 'print', 'rpc']) {
    const name = `SOLPI_${role}_MODEL`, old = process.env[name];
    process.env[name] = 'openai/does-not-exist';
    try {
      const calls = [], h = harness(SOL, { callCheap: async (ctx, model) => { calls.push(model.id); return { ok: true, text: '<summary>Summary.</summary>' }; } });
      h.ctx.mode = mode;
      h.c.configure(h.ctx);
      if (role === 'HANDOFF') { h.c.state.want = 'handoff'; await h.c.switchAtTurnEnd(h.ctx, {}); assert.equal(h.ctx.model, SOL); }
      if (role === 'JUDGE') { for (let i = 0; i < 10; i++) h.c.maybeJudge(h.ctx, { message: h.turn(i) }); await tick(); }
      if (role === 'SUMMARY') await h.c.onBeforeCompact({ preparation: { firstKeptEntryId: 'tail', messagesToSummarize: [] } }, h.ctx);
      assert.deepEqual(calls, role === 'SUMMARY' ? [SOL.id] : []);
      const logs = records(h, 'model-override');
      assert.equal(logs.length, 1); assert.equal(logs[0].data.variable, name); assert.equal(logs[0].data.model, process.env[name]);
      assert.equal(h.notices.length, mode === 'tui' ? 1 : 0);
      if (mode === 'tui') assert.match(h.notices[0][0], new RegExp(name + '.*does-not-exist'));
      h.c.configure(h.ctx); assert.equal(records(h, 'model-override').length, 1);
    } finally { if (old === undefined) delete process.env[name]; else process.env[name] = old; }
  }
});

test('one-hour cache writes use Pi pricing, including the reviewer’s $0.70 saving', async () => {
  const h = harness(OPUS); await startStint(h); await finishStint(h);
  const cheap = h.entries.find(e => e.message?.model === HAIKU.id);
  for (const [long, expected] of [[100000, .70], [50000, .55], [0, .40]]) {
    cheap.message.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 100000, cacheWrite1h: long, cost: { total: .10 } };
    assert.ok(Math.abs(savingsOf(h.entries, h.ctx.modelRegistry).total - expected) < 1e-9);
  }
});

function publicSources(root) {
  return ['README.md', 'package.json', 'extension.js', ...['lib', 'test', 'scripts'].flatMap(dir =>
    readdirSync(new URL(dir, root), { withFileTypes: true }).filter(f => f.isFile() && /\.m?js$/.test(f.name)).map(f => `${dir}/${f.name}`))];
}
test('the neutral-name scan includes our scripts but excludes an installed peer', t => {
  const dir = mkdtempSync(join(tmpdir(), 'solpi-public-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const sub of ['lib', 'test', 'scripts', 'node_modules/peer']) mkdirSync(join(dir, sub), { recursive: true });
  for (const file of ['scripts/check.mjs', 'node_modules/peer/bundle.js']) writeFileSync(join(dir, file), '');
  assert.deepEqual(publicSources(pathToFileURL(dir + '/')), ['README.md', 'package.json', 'extension.js', 'scripts/check.mjs']);
});
test('only package-owned sources and fixtures need neutral labels; both measured session formats restore', async () => {
  const root = new URL('../', import.meta.url);
  const history = readFileSync(new URL('HISTORY.md', root), 'utf8');
  const versions = [...history.matchAll(/^## (E\d+) —/gm)].map(m => m[1]);
  for (const [main, cheap, version] of [[SOL, LUNA, versions[0]], [OPUS, HAIKU, versions[1]]]) {
    const h = harness(main); await startStint(h);
    const switchEntry = records(h, 'momentum-switch')[0];
    delete switchEntry.data.strong; delete switchEntry.data.cheap; switchEntry.data.version = version;
    const resumed = harness(cheap, {}, h.entries);
    resumed.c.restoreHandoff(resumed.ctx); assert.equal(resumed.c.state.main?.id, main.id);
    await finishStint(resumed);
    const legacyNote = 'Measured saved note.';
    h.pi.appendEntry(LOG, { version, mechanism: 'handback-note', stint: `${cheap.id}@2`, steps: 4, written: true, note: legacyNote });
    const again = harness(main, { callCheap: async () => assert.fail('reuse measured note') }, h.entries);
    assert.match(textOf(await again.c.handBackView({ messages: messagesOf(h) }, again.ctx)), /Measured saved note/);
    assert.equal(records(h, 'momentum-switch').at(-1).data.version, 'sol-pi-v2');
  }
  for (const file of publicSources(root)) {
    const source = readFileSync(new URL(file, root), 'utf8');
    assert.doesNotMatch(source, /\b[Ee]\d{3}\b/, file);
    assert.ok(!source.includes(['openai', 'openai', 'gpt-6.1-sol'].join('/')), file);
  }
});
