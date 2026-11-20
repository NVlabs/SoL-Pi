import assert from 'node:assert/strict';
import { createController } from '../extension.js';
import { builtinTools } from './host.js';

const SOL = { provider: 'openai', id: 'gpt-6.1-sol', api: 'openai-responses', cost: { input: 2, output: 10, cacheRead: .1, cacheWrite: 2 }, contextWindow: 272000 };
const LUNA = { ...SOL, id: 'gpt-6-luna', cost: { input: .2, output: .75 } };
const OPUS = { ...SOL, provider: 'anthropic', id: 'claude-opus-5-5', api: 'anthropic-messages', cost: { input: 4, output: 20, cacheRead: .2, cacheWrite: 5 } };
const HAIKU = { ...OPUS, id: 'claude-haiku-5-5', cost: { input: .5, output: 2.5 } };
const models = [SOL, LUNA, OPUS, HAIKU], LOG = 'legacy-ac-activation';
const tick = () => new Promise(r => setTimeout(r, 0));
const textOf = view => JSON.stringify(view);
const messagesOf = h => h.entries.filter(e => e.type === 'message').map(e => e.message);
const records = (h, mechanism) => h.entries.filter(e => e.data?.mechanism === mechanism);
function harness(model = SOL, opts = {}, entries = []) {
  let seq = entries.length;
  const handlers = new Map(), notices = [], tools = new Map();
  const ctx = { model, mode: 'print', cwd: '/nonexistent', sessionManager: { getBranch: () => entries },
    ui: { notify: (...args) => notices.push(args), setStatus() {} },
    modelRegistry: { find: (p, id) => models.find(m => m.provider === p && m.id === id), getAvailable: () => models, hasConfiguredAuth: () => true } };
  const add = e => { const entry = { ...e, id: `entry-${seq++}` }; entries.push(entry); return entry; };
  const pi = { appendEntry: (customType, data) => add({ type: 'custom', customType, data }), on: (n, fn) => handlers.set(n, fn),
    registerTool: def => tools.set(def.name, def), getSettings: () => ({ shellPath: '/bin/bash', shellCommandPrefix: 'export CONFIGURED_SHELL_PREFIX=present' }),
    setModel: async m => { ctx.model = m; add({ type: 'model_change', provider: m.provider, modelId: m.id }); await handlers.get('model_select')?.({ model: m, source: 'set' }, ctx); return true; } };
  const options = { readFile: () => null, ...opts };
  pi.getAllTools = builtinTools;
  pi.getActiveTools = () => ['bash'];
  const h = { pi, ctx, entries, add, handlers, notices, tools, options };
  h.c = createController(pi, options);
  h.turn = (t, model = ctx.model) => {
    const m = { role: 'assistant', provider: model.provider, model: model.id, timestamp: t, content: [{ type: 'toolCall', id: `tool-${t}`, name: 'bash', arguments: { command: 'check' } }] };
    add({ type: 'message', message: m }); add({ type: 'message', message: { role: 'toolResult', toolCallId: `tool-${t}`, timestamp: t + .1, content: [{ type: 'text', text: `result ${t}` }] } });
    return m;
  };
  return h;
}
async function startStint(h) {
  h.turn(1); h.c.state.want = 'handoff'; await h.c.switchAtTurnEnd(h.ctx, {}); h.turn(2); h.turn(3);
}
async function finishStint(h) { h.c.state.want = 'handback'; await h.c.switchAtTurnEnd(h.ctx, {}); }
async function compact(h, keep) {
  const first = h.entries.find(e => e.message === keep);
  const messages = messagesOf(h), at = messages.indexOf(keep);
  const out = await h.c.onBeforeCompact({ preparation: { firstKeptEntryId: first.id, messagesToSummarize: messages.slice(0, at), turnPrefixMessages: [], tokensBefore: 10000 } }, h.ctx);
  assert.ok(out?.compaction);
  h.add({ type: 'compaction', ...out.compaction });
  return [{ role: 'compactionSummary', summary: out.compaction.summary, timestamp: 100 }, ...messages.slice(at)];
}

export { SOL, LUNA, OPUS, HAIKU, models, LOG, tick, textOf, messagesOf, records, harness, startStint, finishStint, compact };
