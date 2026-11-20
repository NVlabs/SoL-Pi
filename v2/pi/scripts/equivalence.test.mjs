import test from 'node:test';
import '../test/host.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkpoints, hasCheckpoint } from './checkpoint.mjs';

const mutations = [
  ['A12 duplicated/misplaced results', `if (name === 'context' && out?.messages) {
    const job = out.messages.find(m => m.role === 'user' && m.content[0]?.text?.startsWith('[Background job'));
    if (job) out.messages = [job, ...out.messages, job];
  }`, 'turn 21 context #0'],
  ['B7 lost judge task and trajectory', `if (name === 'session_start') {
    const complete = ctx.modelRegistry.complete;
    ctx.modelRegistry.complete = (model, input, options) => {
      if (ctx.model.id === 'gpt-6.1-sol' && input.systemPrompt.includes('"handoff"') && input.messages[0].content[0].text.includes('part29.txt'))
        input.messages[0].content[0].text = 'no task or trajectory';
      return complete(model, input, options);
    };
  }`, 'turn 29 turn_end nested request:handoff-judge #0'],
  ['Item 12/B10 reservation after writer reply', `if (name === 'session_start') {
    let reservation;
    const append = pi.appendEntry, complete = ctx.modelRegistry.complete;
    pi.appendEntry = (type, data) => data.mechanism === 'handback-note-attempt' ? reservation = [type, data] : append(type, data);
    ctx.modelRegistry.complete = async (...args) => {
      const reply = await complete(...args);
      if (reservation) { append(...reservation); reservation = null; }
      return reply;
    };
  }`, 'durable reservation before writer request'],
];
for (const [name, mutation, key] of mutations) test(`R3 ${name}: equivalence rejects mutation`, t => {
  if (!checkpoints.every(folder => hasCheckpoint(folder))) return t.skip('needs the tagged checkpoints of the internal repository');
  const temp = mkdtempSync(join(tmpdir(), 'solpi-mutation-')), path = join(temp, 'mutant.mjs');
  try {
    const original = JSON.stringify(new URL('../extension.js', import.meta.url).href);
    writeFileSync(path, `export * from ${original}; import { installWith as install } from ${original};
      export function installWith(pi, ...args) { return install({ ...pi, appendEntry: (...entry) => pi.appendEntry(...entry), on: (name, fn) => pi.on(name, async (e, ctx) => {
        const out = await fn(e, ctx); ${mutation} return out;
      }) }, ...args); }`);
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('equivalence.mjs', import.meta.url)), '--allow-intended'], {
      env: { ...process.env, SOLPI_EQ_EXTENSION: path }, encoding: 'utf8',
    });
    assert.equal(run.status, 1, run.stderr || run.stdout);
    assert.ok(run.stdout.includes(`UNEXPECTED: ${key}`), run.stdout);
    t.diagnostic(`exit ${run.status} — ${run.stdout.split('\n').find(line => line.startsWith('UNEXPECTED:'))}`);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
