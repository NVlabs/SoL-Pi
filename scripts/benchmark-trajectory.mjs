/* SPDX-License-Identifier: MIT */
// Real Pi SDK + HTTP/SSE fixture provider + built-in read tool. No external model spend.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
const piRequire = createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'));
const { createJiti } = piRequire('jiti');
const jiti = createJiti(import.meta.url);
const { createSolPiExtension } = await jiti.import('../src/sol-pi/index.ts');
const { DEFAULT_CONFIG } = await jiti.import('../src/sol-pi/config.ts');
const root = await mkdtemp(join(tmpdir(), 'trajectory-benchmark-'));
const output = resolve(process.argv[2] ?? 'trajectory-benchmark.json');
const count = Number(process.env.TRAJECTORY_CASES ?? 50);
const live = process.argv.includes('--live');
const tui = process.argv.includes('--tui');
const lifecycle = process.argv.includes('--lifecycle');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
let requests = [];
let scenario = { calls: 1, error: false };
let cancelRequest;
let resumeFile;
const server = createServer(async (req, res) => {
  try {
    let data = ''; for await (const chunk of req) data += chunk;
    const body = JSON.parse(data); requests.push(hash(body));
    if (scenario.retry && requests.length === 1) { res.writeHead(503); res.end(JSON.stringify({ error: { message: 'fixture overloaded' } })); return; }
    const user = body.messages.findLastIndex(m => m.role === 'user');
    const done = body.messages.slice(user + 1).filter(m => m.role === 'tool').length;
    const tool = done < scenario.calls && (!scenario.compact || body.tools?.length > 0);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    chunk({ role: 'assistant', content: '' });
    if (scenario.cancel) { setTimeout(() => cancelRequest?.(), 20); return; }
    if (tool) chunk({ tool_calls: [{ index: 0, id: `call_${done}`, type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: scenario.error && done === 0 ? 'missing.txt' : 'fixture.txt' }) } }] });
    else chunk({ content: 'VERIFIED' });
    chunk({}, tool ? 'tool_calls' : 'stop'); res.end('data: [DONE]\n\n');
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const runtime = live ? await ModelRuntime.create() : await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: null });
if (!live) runtime.registerProvider('trajectory-fixture', {
  baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions', apiKey: 'local-fixture',
  models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 256 }],
});
const model = live ? (await runtime.getAvailable()).find(m => m.provider === 'multiverse' && m.id === 'glm-5-2') : runtime.getModel('trajectory-fixture', 'fixture');
assert(model, 'No selected model available');
if (tui) {
  await mkdir(join(root, '.pi'), { recursive: true });
  await writeFile(join(root, '.pi/sol-pi.json'), JSON.stringify({ version: 1, trajectoryInspector: true }));
  await writeFile(join(root, 'models.json'), JSON.stringify({ providers: { 'trajectory-fixture': runtime.getRegisteredProviderConfig('trajectory-fixture') } }));
  await writeFile(join(root, 'fixture.txt'), 'PRIVATE_FIXTURE_CONTENT\n');
  await writeFile(output, JSON.stringify({ root, kind: 'interactive-tui-smoke' }));
  const child = spawn(process.execPath, [fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')).replace(/index.js$/, 'cli.js'), '--offline', '--approve', '--no-extensions', '--extension', fileURLToPath(new URL('../src/sol-pi/index.ts', import.meta.url)), '--no-skills', '--no-context-files', '--no-prompt-templates', '--provider', 'trajectory-fixture', '--model', 'fixture', '--tools', 'read', 'Read fixture.txt.'], { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: root }, stdio: 'inherit' });
  const code = await new Promise(r => child.on('exit', r));
  server.closeAllConnections(); await new Promise(r => server.close(r));
  process.exit(code ?? 1);
}
const theme = { fg: (_color, text) => text };
const errors = [];
async function run(enabled, caseIndex, resume = false) {
  requests = [];
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false, ...(scenario.compact ? { keepRecentTokens: 1 } : {}) }, retry: { enabled: !!scenario.retry, maxRetries: 1, baseDelayMs: 1 } });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: 'Follow the user request. Use read when asked.',
    extensionFactories: [createSolPiExtension(() => ({ ...DEFAULT_CONFIG, trajectoryInspector: enabled }))],
  });
  await loader.reload();
  const manager = resume ? SessionManager.open(resumeFile, join(root, 'sessions')) : SessionManager.create(root, join(root, 'sessions'));
  const { session, extensionsResult } = await createAgentSession({ cwd: root, agentDir: root, resourceLoader: loader, settingsManager, sessionManager: manager, modelRuntime: runtime, model, thinkingLevel: 'off', tools: ['read'] });
  assert.equal(extensionsResult.errors.length, 0);
  let widget; let renders = 0; let lastLines = []; let toolErrors = 0; let toolCalls = 0;
  const render = () => { if (widget) { lastLines = widget.render(120); renders++; } };
  await session.bindExtensions({ mode: 'tui', onError: error => errors.push(error.message), uiContext: {
    setWidget(_key, factory) { widget = factory ? factory({ requestRender: render }, theme) : undefined; render(); }, notify() {}, setStatus() {},
  } });
  session.subscribe(e => { if (e.type === 'tool_execution_end') { toolCalls++; if (e.isError) toolErrors++; } });
  const start = performance.now(); const cpu = process.cpuUsage();
  try {
    cancelRequest = () => session.abort();
    await session.prompt(live ? 'Read fixture.txt using the read tool. Reply with only its first line.' : `Case ${caseIndex}: inspect fixture.txt and finish.`);
    const promptMs = performance.now() - start;
    const final = session.messages.filter(m => m.role === 'assistant').at(-1);
    if (scenario.cancel) assert.equal(final?.stopReason, 'aborted');
    else {
      assert(final && final.stopReason !== 'error' && final.stopReason !== 'aborted', `Model failed: ${final?.errorMessage ?? final?.stopReason}`);
      assert(toolCalls > 0, 'No real tool executed');
      if (!live) { assert.equal(toolCalls, scenario.calls); assert.equal(toolErrors, scenario.error ? 1 : 0); assert.equal(final.content.find(c => c.type === 'text')?.text, 'VERIFIED'); }
      else assert.equal(final.content.find(c => c.type === 'text')?.text.trim(), 'PRIVATE_FIXTURE_CONTENT');
    }
    const visible = lastLines;
    if (scenario.compact) await session.compact('Preserve the completed file-read task.');
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'exit' });
    const elapsedMs = performance.now() - start; const usage = process.cpuUsage(cpu);
    // Lifecycle/resize assertions are deliberately outside the timing window.
    if (enabled) {
      await session.prompt('/trajectory'); assert.equal(widget, undefined);
      await session.prompt('/trajectory'); assert(widget, 'Widget missing');
      for (const width of [1, 20, 40, 80, 120]) assert(widget.render(width).every(line => visibleWidth(line) <= width), `overflow at ${width}`);
    }
    let ledgerBytes = 0; let events = 0;
    if (enabled) {
      const ledger = await readFile(join(manager.getSessionDir(), 'sol-pi', manager.getSessionId(), 'trajectory-inspector/events.jsonl'), 'utf8');
      const entries = ledger.trim().split('\n').map(JSON.parse); events = entries.length; ledgerBytes = Buffer.byteLength(ledger);
      assert(entries.some(e => e.kind === 'session'), 'Missing startup');
      if (!scenario.cancel) {
        assert(entries.some(e => e.kind === 'tool'), 'Missing tool');
        assert(entries.some(e => e.kind === 'result' && !e.label.endsWith('· 0 B')), 'Wrong byte count');
      }
      assert(!ledger.includes('PRIVATE_FIXTURE_CONTENT'), 'Content leaked');
      const records = new Map(entries.filter(e => e.event === 'record').map(e => [`${e.runId}:${e.sequence}`, e]));
      for (const e of entries.filter(e => e.event === 'update')) assert(records.has(`${e.runId}:${e.sequence}`), 'Dangling update');
      for (const [key, record] of records) if (record.status === 'running') assert(entries.some(e => e.event === 'update' && `${e.runId}:${e.sequence}` === key && e.status !== 'running'), `Unclosed span ${record.kind}`);
      if (resume) assert(new Set(entries.map(e=>e.runId)).size >= 2, 'Resume run IDs collide');
    }
    resumeFile = manager.getSessionFile();
    return { enabled, caseIndex, promptMs, elapsedMs, cpuMs: (usage.user + usage.system) / 1000, rssBytes: process.memoryUsage().rss, requests: [...requests], toolCalls, toolErrors, events, ledgerBytes, renders, visible };
  } finally { session.dispose(); }
}
const pairs = [];
try {
  await mkdir(join(root, 'sessions'), { recursive: true });
  if (lifecycle) {
    await writeFile(join(root, 'fixture.txt'), 'PRIVATE_FIXTURE_CONTENT\n');
    for (const [name, config, resume] of [
      ['long-run', { calls: 50, error: false }, false],
      ['resume', { calls: 2, error: false }, true],
      ['retry', { calls: 1, error: false, retry: true }, false],
      ['cancel', { calls: 0, error: false, cancel: true }, false],
      ['compact', { calls: 2, error: false, compact: true }, false],
    ]) {
      scenario = config;
      const result = await run(true, name, resume);
      pairs.push({ name, result }); console.log(`${name}: passed`);
    }
    assert.equal(errors.length, 0, JSON.stringify(errors));
    await writeFile(output, JSON.stringify({ kind: 'real-sdk-lifecycle', root, pairs }, null, 2));
  } else {
  for (let i = -3; i < (live ? 1 : count); i++) {
    if (live && i < 0) continue;
    scenario = { calls: 1 + ((i + 5) % 5), error: i >= 0 && i % 7 === 0 };
    await writeFile(join(root, 'fixture.txt'), `PRIVATE_FIXTURE_CONTENT\n${'sample data\n'.repeat(10 + Math.max(0, i) * 10)}`);
    const results = [];
    for (const enabled of (live ? [true] : i % 2 === 0 ? [false, true] : [true, false])) results.push(await run(enabled, i));
    if (!live) assert.deepEqual(results[0].requests, results[1].requests, `Provider payload mismatch case ${i}`);
    if (i >= 0) pairs.push({ caseIndex: i, ...scenario, runs: results });
    console.log(`case ${i}: passed`);
  }
  assert.equal(errors.length, 0, JSON.stringify(errors));
  const stats = values => { const v = [...values].sort((a,b) => a-b); return { mean: v.reduce((a,b)=>a+b,0)/v.length, p50: v[Math.floor((v.length-1)*.5)], p95: v[Math.ceil((v.length-1)*.95)] }; };
  const summary = {};
  for (const enabled of [false,true]) { const runs = pairs.flatMap(p=>p.runs).filter(r=>r.enabled===enabled); if (runs.length) summary[enabled?'enabled':'disabled'] = Object.fromEntries(['promptMs','elapsedMs','cpuMs','ledgerBytes','renders'].map(k=>[k,stats(runs.map(r=>r[k]))])); }
  if (!live) summary.pairedElapsedDeltaMs = stats(pairs.map(p=>p.runs.find(r=>r.enabled).elapsedMs-p.runs.find(r=>!r.enabled).elapsedMs));
  await writeFile(output, JSON.stringify({ kind: live?'live-model-smoke':'deterministic-http-provider-benchmark', timestamp: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch, model: `${model.provider}/${model.id}`, warmupPairs: live?0:3, cases: pairs.length, root, summary, pairs }, null, 2));
  console.log(JSON.stringify({ output, summary }));
  }
} finally { server.closeAllConnections(); await new Promise(r=>server.close(r)); }
