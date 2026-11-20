import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setImmediate as drain } from 'node:timers/promises';
import * as current from '../extension.js';
import { checkpoint, checkpoints, hasCheckpoint } from '../scripts/checkpoint.mjs';
import { callCheap } from '../lib/summarizer.js';
import { SOL, LUNA, OPUS, HAIKU, LOG, harness, startStint, finishStint, messagesOf, records } from './fixture.js';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const result = text => ({ content: [{ type: 'text', text }] });
const view = (h, messages = messagesOf(h)) => h.c.handBackView({ messages }, h.ctx);
const receipt = (h, toolCallId, offer) => h.add({ type: 'message', message: { role: 'toolResult', toolCallId, ...offer } });
const tempDir = t => { const dir = mkdtempSync(join(tmpdir(), 'solpi-review-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };

async function launch(h) {
  let finish;
  await h.c.yieldingBash({ execute: () => new Promise(r => { finish = r; }) }, 'long', { command: 'test' }, undefined, h.ctx);
  return async () => { finish(result('finished output')); await drain(); };
}

test('parallel result hooks precede both receipts; restart reoffers only a lost receipt', async () => {
  const h = harness(OPUS, { yieldMs: 1 }); await (await launch(h))();
  const offers = await Promise.all(['a', 'b'].map(toolCallId => h.c.backgroundNotices({ toolCallId }, h.ctx)));
  assert.match(JSON.stringify(offers[0]), /finished output/); assert.equal(offers[1], undefined);
  assert.equal(records(h, 'bash-yield-end').length, 1);
  for (const saved of [true, false]) {
    const reopened = harness(OPUS, {}, structuredClone(h.entries));
    receipt(reopened, 'a', saved ? offers[0] : result('filtered')); receipt(reopened, 'b', result('ok'));
    assert.equal(!!reopened.c.backgroundNotices({ toolCallId: 'c' }, reopened.ctx), !saved);
  }
});

async function cadence(mod, strong, split, late) {
  const trace = []; let h, release, turn;
  const boot = () => {
    h = harness(h?.ctx.model ?? strong, { callCheap: async (_, model, { system }) => {
      if (system.includes('"handoff"') && (late && turn === 10 || late != null && turn === 25)) await new Promise(r => { release = r; });
      return { ok: true, text: system.includes('"handoff"') ? '{"handoff":true}' : '{"handback":true}' };
    } }, structuredClone(h?.entries ?? []));
    h.c = mod.createController(h.pi, h.options);
  };
  boot();
  for (turn = 1; turn <= (late == null ? 40 : 26); turn++) {
    await view(h); const before = h.entries.length, event = { message: h.turn(turn) };
    await h.c.switchAtTurnEnd(h.ctx, event); h.c.maybeJudge(h.ctx, event); await drain();
    if (late && turn === 11) { release(); await drain(); }
    if (late != null && turn === 17) await h.c.onAgentEnd(h.ctx);
    for (const { data } of h.entries.slice(before)) if (data?.mechanism.endsWith('-judge')) trace.push([turn, data.mechanism, data.calls]);
    if (turn === split || late != null && [17, 25].includes(turn)) boot();
  }
  return trace;
}

test('compare archived judge entries at mid-stint, completed-stint and pre-boundary restarts', async t => {
  if (!hasCheckpoint('sol-pi-v2-pi', '0ab3f0c5a') || !checkpoints.every(folder => hasCheckpoint(folder))) return t.skip('needs the tagged checkpoints of the internal repository');
  const dir = tempDir(t), head = await checkpoint(dir, 'sol-pi-v2-pi', '0ab3f0c5a');
  for (const [index, strong] of [SOL, OPUS].entries()) {
    const old = await checkpoint(dir, checkpoints[index]);
    for (const split of [19, 21, 29]) {
      const archived = await cadence(old, strong, split), previous = await cadence(head, strong, split), fresh = await cadence(current, strong, split);
      if (split === 19) {
        assert.deepEqual(archived, [[10, 'handoff-judge', 10]], 'old process lost ownership on cheap');
        assert.deepEqual(fresh, await cadence(old, strong), 'retained stint must use evaluated live transition accounting');
        assert.equal(previous[2][0], 29); assert.equal(fresh[2][0], 30);
      } else {
        assert.deepEqual(fresh, archived);
        if (strong === SOL) assert.deepEqual(previous, archived);
        else assert.notDeepEqual(previous, archived, 'previous Claude process incorrectly carried the strong count');
      }
      t.diagnostic(`${strong.id}, restart ${split}: ${fresh.map(([turn, kind, calls]) => `${kind}@${turn}:${calls}`).join(', ')}`);
    }
    if (strong === SOL) for (const late of [false, true]) {
      const fresh = await cadence(current, strong, null, late);
      for (const baseline of [old, head]) assert.deepEqual(fresh, await cadence(baseline, strong, null, late));
      assert.deepEqual(fresh.at(-1), [26, 'handoff-judge', late ? 21 : 20]);
      t.diagnostic(`same GPT restarts, ${late ? 'delayed' : 'immediate'} first reply: calls=${fresh.at(-1)[2]} on all three versions`);
    }
  }
});

test('first-extension wins cannot mask startup policy or synthesized SDK bash; missing factory warns once', async () => {
  for (const kind of ['base', 'load', 'startup', 'inactive', 'missing', 'stock']) {
    const h = harness(OPUS); h.ctx.mode = 'tui';
    const stock = h.pi.getAllTools()[0], remote = { ...stock, sourceInfo: { source: 'local', path: '/policy' } };
    let policy = kind === 'load', own;
    if (kind === 'inactive') h.pi.getActiveTools = () => [];
    h.pi.getAllTools = () => [own ?? (policy ? remote : kind === 'base' ? { ...stock, promptGuidelines: undefined } : stock)];
    h.pi.registerTool = def => { own = { ...def, sourceInfo: { source: 'local', path: '/solpi' } }; };
    current.installWith(h.pi, kind === 'missing' ? null : () => ({ ...stock, description: 'stock' }));
    await h.handlers.get('session_start')({}, h.ctx);
    if (kind === 'startup') policy = true;
    await h.handlers.get('before_agent_start')?.({}, h.ctx);
    for (const m of [SOL, OPUS]) await h.pi.setModel(m);
    assert.equal(!!own, kind === 'stock', kind);
    assert.equal(records(h, 'bash-yield-skipped').length, kind === 'stock' ? 0 : 1, kind);
    assert.equal(h.notices.length, kind === 'stock' ? 0 : 1, kind);
  }
});

test('a bundled Pi executable resolves its stock factory with no adjacent installed peer', async t => {
  const host = tempDir(t), bundle = join(host, 'dist', 'bundle'), cli = join(bundle, 'cli.js'); mkdirSync(bundle, { recursive: true });
  writeFileSync(join(host, 'package.json'), JSON.stringify({ type: 'module', name: '@earendil-works/pi-coding-agent', main: 'dist/index.js' }));
  writeFileSync(cli, ''); writeFileSync(join(bundle, 'index.js'), 'export function createBashToolDefinition() {}');
  const sdk = await current.piPackage(cli, () => { throw Error('native import misses loader alias'); });
  assert.equal(typeof sdk.createBashToolDefinition, 'function');
});

test('only confirmed edited bytes survive; denied, unmatched and shell-inferred paths never disclose disk', async t => {
  if (!checkpoints.every(folder => hasCheckpoint(folder))) return t.skip('needs the tagged checkpoints of the internal repository');
  const dir = tempDir(t), secret = 'denied disk canary', visible = 'approved contents\n';
  const project = join(dir, 'project'); mkdirSync(project);
  for (const name of ['../denied.txt', 'unknown.txt', 'inferred.txt', 'edited.txt']) writeFileSync(join(project, name), name === 'edited.txt' ? visible : secret);
  for (const [index, strong] of [SOL, OPUS].entries()) {
    const old = await checkpoint(dir, checkpoints[index]);
    const h = harness(strong, { readFile: undefined, callCheap: async () => ({ ok: true, text: '<summary>done</summary>' }) }); h.ctx.cwd = project; h.ctx.mode = 'tui';
    const call = (id, name, args, text, isError) => {
      h.add({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: args }] } });
      if (text != null) receipt(h, id, { toolName: name, isError, ...result(text) });
    };
    call('edit', 'edit', { path: 'edited.txt' }, 'Successfully replaced one block.', false);
    call('read', 'read', { path: 'edited.txt' }, visible, false);
    call('no', 'edit', { path: '../denied.txt' }, 'denied', true);
    call('absent', 'write', { path: 'unknown.txt', content: 'never written' });
    call('shell', 'bash', { command: 'false && tee inferred.txt' }, 'failed', true);
    call('write', 'write', { path: 'request.txt', content: 'request, not read contents' }, 'OK', false);
    const preparation = { messagesToSummarize: messagesOf(h), firstKeptEntryId: h.add({ type: 'message', message: { role: 'user', content: 'next' } }).id, settings: { keepRecentTokens: 100000 } };
    const compact = c => c.onBeforeCompact({ preparation }, h.ctx).then(x => x.compaction.summary);
    const baseline = await compact(old.createController(h.pi, { callCheap: h.options.callCheap }));
    const out = await compact(h.c);
    const snapshot = text => text.match(/--- edited\.txt(?: \(read from disk at compaction\))?\n([\s\S]*?)(?=\n\n(?:---|###)|$)/)?.[1];
    assert.equal(snapshot(baseline), visible); assert.equal(snapshot(out), snapshot(baseline));
    assert.ok(baseline.includes(secret) && !out.includes(secret)); assert.ok(!out.includes('request, not read contents'));
    for (const path of ['../denied.txt', 'unknown.txt', 'inferred.txt', 'request.txt']) assert.ok(out.includes(`- ${path}`));
    assert.equal(records(h, 'file-content-skipped').length, 1); assert.equal(h.notices.length, 1);
  }
});

test('README identifies the yielded-output bash redaction boundary', () => {
  assert.match(readme, /yielded output bypasses other extensions’ bash-result handlers/i);
});

test('one outer reservation includes three transient retries and the fourth dispatch', async () => {
  for (const model of [SOL, OPUS]) {
    const waits = [], h = harness(model, { callCheap: (...args) => callCheap(...args, async ms => { waits.push(ms); }) });
    let calls = 0; h.ctx.modelRegistry.complete = async () => ++calls < 4 ? { stopReason: 'error', errorMessage: '503' } : { stopReason: 'stop', ...result('verified') };
    await startStint(h); await finishStint(h); await view(h);
    assert.equal(calls, 4); assert.deepEqual(waits, [5000, 10000, 20000]); assert.deepEqual(records(h, 'handback-note-attempt').map(e => e.data.attempt), [1]);
  }
  assert.match(readme, /outer writer attempts[^.]*inner retries/i);
});

test('system messages do not split TUI notes and same-start partial notes never replace later work', async () => {
  for (const model of [SOL, OPUS]) {
    const h = harness(model, { callCheap: async (_, m, { user }) => ({ ok: true, text: [...user.matchAll(/result (\d+)/g)].map(x => x[1]).join('+') }) });
    await startStint(h); const at = h.entries.findIndex(e => e.message?.timestamp === 3);
    h.entries.splice(at, 0, { id: 'system', type: 'message', message: { role: 'system', content: 'tools' } });
    h.ctx.mode = 'tui'; h.ctx.sessionManager.buildSessionProjection = () => ({ messages: messagesOf(h) }); await finishStint(h);
    assert.deepEqual(records(h, 'handback-note').map(e => e.data.note), ['2+3']);
    const msgs = messagesOf(h).filter(m => m.role !== 'system');
    const smaller = await view(h, msgs.slice(0, -2)); assert.match(smaller.messages.at(-1).content[0].text, /\n2$/);
    assert.match((await view(h, msgs)).messages.at(-1).content[0].text, /\n2\+3$/);
    const changed = msgs.map(m => m.toolCallId === 'tool-3' ? { ...m, ...result('result 4') } : m);
    delete records(h, 'handback-note')[0].data.range;
    assert.match((await view(h, changed)).messages.at(-1).content[0].text, /\n2\+4$/);
  }
});

test('live completions follow the launch, including leaving and reselecting its branch', async () => {
  for (const away of [false, true]) {
    const h = harness(OPUS, { yieldMs: 1 }); h.c = current.installWith(h.pi, () => h.pi.getAllTools()[0], h.options);
    await h.handlers.get('session_start')({}, h.ctx); await h.handlers.get('before_agent_start')?.({}, h.ctx); const finish = await launch(h);
    const selected = h.entries.slice(); if (away) h.entries.length = 0;
    const tree = () => h.handlers.get('session_tree')({}, h.ctx); await tree(); await finish();
    const offer = () => h.handlers.get('tool_result')({ toolCallId: 'next' }, h.ctx);
    if (away) { assert.equal(records(h, 'bash-yield-result').length, 0); assert.equal(offer(), undefined); h.entries.splice(0, Infinity, ...selected); await tree(); }
    assert.deepEqual(records(h, 'bash-yield-result').map(e => e.data.text), ['finished output']);
    assert.match(JSON.stringify(offer()), /finished output/);
  }
});

test('reused legacy job numbers retain both launch receipts and bounded output', async () => {
  const h = harness(OPUS, { callCheap: async () => ({ ok: true, text: 'note' }) }); await startStint(h);
  for (const name of ['first','second']) {
    h.pi.appendEntry(LOG, { mechanism: 'bash-yield', job: 1 }); h.pi.appendEntry(LOG, { mechanism: 'bash-yield-end', jobs: [{ job: 1, minutes: 2, failed: false }] });
    receipt(h, name, result(`\n\n[Background job 1 ended after 2 min: ${name}]\n${name}HEAD${'x'.repeat(22000)}${name}TAIL`));
  }
  await finishStint(h); const out = (await view(h)).messages.filter(m => m.role === 'user' && m.content[0].text.startsWith('[Background job'));
  assert.equal(out.length, 2); for (const [i,name] of ['first','second'].entries()) {
    const text = out[i].content[0].text; assert.ok(text.includes(name + 'HEAD') && text.endsWith(name + 'TAIL') && text.length < 4100);
  }
});

test('simultaneous identical commands each name their own actual child PID', async t => {
  const h = harness(OPUS, { yieldMs: 1 }), children = new Map();
  const def = { execute: async id => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore' });
    children.set(id, child); t.after(() => child.kill()); await once(child, 'exit'); return result('end');
  } };
  await Promise.all(['first', 'second'].map(async id => {
    const out = await h.c.yieldingBash(def, id, { command: 'identical' }, undefined, h.ctx);
    assert.ok(out.content[0].text.endsWith(`kill -TERM ${children.get(id).pid}`));
  }));
});

test('auto-switch delayed before Pi commits restores the intervening manual selection exactly once', async () => {
  const h = harness(), select = h.pi.setModel; let release;
  h.pi.setModel = async m => { if (m === LUNA) await new Promise(r => { release = r; }); return select(m); };
  h.c = current.installWith(h.pi, null); h.c.state.want = 'handoff'; const move = h.c.switchAtTurnEnd(h.ctx, {});
  await select(OPUS); release(); await move;
  assert.equal(h.ctx.model, OPUS); assert.equal(h.c.state.main, null); assert.deepEqual(records(h, 'model-selection').map(e => e.data.model.id), [OPUS.id]);
});

test('a catalog hit without configured auth incurs no judge; warning is once', async t => {
  process.env.SOLPI_HANDOFF_MODEL = `openai/${LUNA.id}`; t.after(() => delete process.env.SOLPI_HANDOFF_MODEL);
  let calls = 0; const h = harness(SOL, { callCheap: () => { calls++; } }); h.ctx.mode = 'tui';
  h.ctx.modelRegistry.hasConfiguredAuth = model => model !== LUNA;
  for (let i = 0; i < 31; i++) { h.c.maybeJudge(h.ctx, { message: h.turn(i) }); await drain(); }
  assert.equal(calls, 0); assert.equal(records(h, 'model-override').length, 1); assert.equal(h.notices.length, 1);
});

test('measured Opus attribution, release fix and benchmark-visible stop hint are documented', () => {
  assert.match(readme, /Opus[^.]*measured[^.]*`c75207d`/); assert.match(readme, /`f391b4b`[^.]*replay baseline[^.]*twice across processes/);
  assert.match(readme, /can change benchmark results[^\n]*kill -TERM/i);
});
