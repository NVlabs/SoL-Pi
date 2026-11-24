/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REVIEW_NOTE, CHEAP_NOTE, MEASURED_CHEAP_NOTE, QUALITY_RULE, JUDGE_INSTRUCTIONS, RETURN_INSTRUCTIONS, CLAUDE_RETURN_INSTRUCTIONS, NOTE_HEAD,
  YIELD_NOTE, CLAUDE_CODE_BASH_TIMEOUT_MS, GPU_CLAUDE_BASH_TIMEOUT_MS, measuredInstructions, yieldMsFor, yieldNote,
} from '../extension.js';
import { SOL, LUNA, OPUS, HAIKU, tick, messagesOf, records, harness, startStint, finishStint } from './fixture.js';

const img = n => ({ type: 'image', data: `IMG${n}`, mimeType: 'image/png' });
const seeing = m => ({ ...m, input: ['text', 'image'] });
const SEEING = [SOL, LUNA, OPUS, HAIKU].map(seeing);
const [SOL_I, , OPUS_I] = SEEING;
function visionHarness(model, opts) {
  const h = harness(model, opts);
  h.ctx.modelRegistry.getAvailable = () => SEEING;
  h.ctx.modelRegistry.find = (p, id) => SEEING.find(m => m.provider === p && m.id === id);
  return h;
}
const stop = (model, stopReason = 'stop') => ({ role: 'assistant', provider: model.provider, model: model.id, timestamp: 9, stopReason, content: [{ type: 'text', text: 'Done.' }] });
const withSend = h => { const sent = []; h.pi.sendUserMessage = (content, options) => sent.push({ content, options }); return sent; };
const imageTurn = { role: 'toolResult', toolCallId: 'v0', toolName: 'read', content: [{ type: 'text', text: 'render' }, img(0)] };
const seeImage = h => h.c.noteImages({ context: { contextEntries: [{ messages: [{ role: 'user', content: 'task' }, imageTurn] }] } });

test('measured work is an image in the session or a GPU on the machine; text-only work on a machine without a GPU is not', () => {
  const plain = harness(SOL, { gpu: false });
  plain.c.noteImages({ context: { contextEntries: [{ messages: [{ role: 'user', content: 'task' }, { role: 'toolResult', content: [{ type: 'text', text: 'ok' }] }] }] } });
  assert.equal(plain.c.state.sawImage, undefined);
  assert.equal(records(plain, 'measured-work').length, 0);
  seeImage(plain);
  assert.equal(plain.c.state.sawImage, true);
  assert.equal(records(plain, 'measured-work').length, 1);
  assert.equal(harness(SOL, { gpu: true }).c.gpu, true);
});

test('each judge text gets the quality rule once on measured work, and keeps its own text otherwise', () => {
  for (const text of [JUDGE_INSTRUCTIONS, RETURN_INSTRUCTIONS, CLAUDE_RETURN_INSTRUCTIONS]) {
    const changed = measuredInstructions(text);
    assert.notEqual(changed, text);
    assert.equal(changed.split(QUALITY_RULE).length, 2, 'the rule appears exactly once');
    assert.equal(changed.replace(/;\n- (the next step is )?deciding what to keep[^\n]*\.\n/, '.\n'), text, 'nothing else changes');
  }
});

test('on measured work a normal stop of the cheap model hands the work back and asks the strong model to review it (GPT and Claude)', async () => {
  for (const make of [s => harness(s, { gpu: true }), s => { const h = harness(s, { gpu: false }); seeImage(h); return h; }]) for (const strong of [SOL, OPUS]) {
    const h = make(strong), sent = withSend(h);
    await startStint(h);
    const end = h.add({ type: 'message', message: stop(h.ctx.model) }).message;
    await h.c.switchAtTurnEnd(h.ctx, { message: end });
    assert.equal(h.ctx.model.id, strong.id, 'the strong model has the session again');
    assert.deepEqual(sent, [{ content: REVIEW_NOTE, options: { deliverAs: 'followUp' } }], 'the run goes on with a review');
    assert.equal(records(h, 'strong-review').length, 1);
    await h.c.onAgentEnd(h.ctx);
    assert.equal(h.ctx.model.id, strong.id, 'agent end changes nothing more');
  }
});

test('without measured work the cheap model ends as released: GPT at agent end, Claude at its last turn, and no review', async () => {
  for (const strong of [SOL, OPUS]) {
    const h = harness(strong, { gpu: false }), sent = withSend(h);
    await startStint(h);
    const cheap = h.ctx.model;
    await h.c.switchAtTurnEnd(h.ctx, { message: h.add({ type: 'message', message: stop(cheap) }).message });
    assert.deepEqual(sent, []);
    assert.equal(h.ctx.model.id, strong === OPUS ? OPUS.id : cheap.id);
    assert.equal(records(h, 'strong-review').length, 0);
  }
});

test('an aborted, failed or cut-off turn, a stop of the strong model, or a host without sendUserMessage queues no review', async () => {
  for (const stopReason of ['aborted', 'error', 'length']) for (const strong of [SOL, OPUS]) {
    const h = harness(strong, { gpu: true }), sent = withSend(h);
    await startStint(h);
    const cheap = h.ctx.model;
    await h.c.switchAtTurnEnd(h.ctx, { message: h.add({ type: 'message', message: stop(cheap, stopReason) }).message });
    assert.deepEqual(sent, []);
    assert.equal(h.ctx.model.id, strong === OPUS ? OPUS.id : cheap.id);
  }
  const own = harness(SOL, { gpu: true }), sent = withSend(own);
  await own.c.switchAtTurnEnd(own.ctx, { message: own.add({ type: 'message', message: stop(SOL) }).message });
  assert.deepEqual(sent, []); assert.equal(own.ctx.model.id, SOL.id);
  const old = harness(SOL, { gpu: true });
  await startStint(old);
  const cheap = old.ctx.model;
  await old.c.switchAtTurnEnd(old.ctx, { message: old.add({ type: 'message', message: stop(cheap) }).message });
  assert.equal(old.ctx.model.id, cheap.id, 'an older host keeps the released behaviour');
});

test('the judges see the latest images and the quality rule on measured work; text-only work without a GPU gets the released request', async () => {
  const msgs = [{ role: 'user', content: [{ type: 'text', text: 'task' }] }];
  for (let t = 1; t <= 6; t++) msgs.push({ role: 'assistant', content: [{ type: 'toolCall', id: `c${t}`, name: 'read', arguments: { path: `f${t}.png` } }] },
    { role: 'toolResult', toolCallId: `c${t}`, toolName: 'read', content: [{ type: 'text', text: `file ${t}` }, img(t)] });
  const textOnly = msgs.map(m => m.role === 'toolResult' ? { ...m, content: m.content.filter(b => b.type === 'text') } : m);
  const judgeOnce = async (h, messages, calls) => {
    for (let k = 0; k < 10; k++) h.c.maybeJudge(h.ctx, { message: msgs[1], context: { contextEntries: [{ messages }] } });
    await tick(); await tick();
    return calls.at(-1);
  };
  const reply = calls => async (_, model, args) => { calls.push(args); return { ok: true, text: '{"handoff": false, "handback": false, "phase": "p", "reason": "r"}' }; };
  const calls = [], h = visionHarness(SOL_I, { gpu: false, callCheap: reply(calls) });
  seeImage(h);
  const forward = await judgeOnce(h, msgs, calls);
  assert.deepEqual(forward.images.map(i => i.data), ['IMG3', 'IMG4', 'IMG5', 'IMG6'], 'the four most recent images, oldest first');
  assert.match(forward.user, /IMAGES: the 4 most recent images [^\n]* Keep the strong model when they show/);
  assert.equal(forward.system, measuredInstructions(JUDGE_INSTRUCTIONS));
  await startStint(h);
  const back = await judgeOnce(h, msgs, calls);
  assert.equal(back.system, measuredInstructions(RETURN_INSTRUCTIONS));
  assert.match(back.user, /Give the work back when they show that the results do not match/);
  assert.equal(records(h, 'handback-judge').at(-1).data.images, 4);
  const plainCalls = [], plain = visionHarness(SOL_I, { gpu: false, callCheap: reply(plainCalls) });
  const textual = await judgeOnce(plain, textOnly, plainCalls);
  assert.equal('images' in textual, false); assert.doesNotMatch(textual.user, /IMAGES:/); assert.match(textual.user, /\n\nDecide now\.$/);
  assert.equal(textual.system, JUDGE_INSTRUCTIONS, 'the released instructions');
  const gpuCalls = [], gpu = harness(OPUS, { gpu: true, callCheap: reply(gpuCalls) });
  const onGpu = await judgeOnce(gpu, textOnly, gpuCalls);
  assert.equal(onGpu.system, measuredInstructions(JUDGE_INSTRUCTIONS)); assert.equal('images' in onGpu, false);
  const blindCalls = [], blind = harness(SOL, { gpu: false, callCheap: reply(blindCalls) });
  seeImage(blind);
  assert.equal('images' in await judgeOnce(blind, msgs, blindCalls), false, 'a judge without image input gets text only');
});

test("the strong model gets the stint's last two images with the cheap model's note, if it takes images", async () => {
  for (const [strong, expected] of [[SOL_I, ['IMG2', 'IMG3']], [OPUS_I, ['IMG2', 'IMG3']], [SOL, []]]) {
    const h = (strong.input ? visionHarness : harness)(strong, { gpu: false, callCheap: async () => ({ ok: true, text: 'Done: rendered the scene.' }) });
    await startStint(h);
    const cheap = h.ctx.model;
    h.add({ type: 'message', message: { role: 'assistant', provider: cheap.provider, model: cheap.id, timestamp: 4, content: [{ type: 'toolCall', id: 'v4', name: 'read', arguments: { path: 'r.png' } }] } });
    h.add({ type: 'message', message: { role: 'toolResult', toolCallId: 'v4', timestamp: 4.1, content: [{ type: 'text', text: 'render' }, img(1), img(2), img(3)] } });
    await finishStint(h);
    const view = await h.c.handBackView({ messages: messagesOf(h) }, h.ctx);
    const note = view.messages.find(m => m.role === 'user' && m.content?.[0]?.text?.startsWith(NOTE_HEAD));
    assert.ok(note, 'the stint goes out as a note');
    assert.deepEqual(note.content.slice(1).map(b => b.data), expected);
  }
});

test('on measured work the strong model gets back its own thinking level; otherwise the level stays as Pi sets it', async () => {
  for (const gpu of [true, false]) {
    const h = harness(SOL, { gpu }); withSend(h); let level = 'xhigh';
    h.pi.getThinkingLevel = () => level; h.pi.setThinkingLevel = l => { level = l; };
    const setModel = h.pi.setModel; h.pi.setModel = async m => { level = 'medium'; return setModel(m); }; // Pi applies the settings' level
    await startStint(h);
    assert.equal(level, 'medium');
    await finishStint(h);
    assert.equal(h.ctx.model.id, SOL.id);
    assert.equal(level, gpu ? 'xhigh' : 'medium');
  }
});

test("the cheap model's note asks it to stop before quality decisions on measured work only", async () => {
  for (const gpu of [true, false]) for (const strong of [SOL, OPUS]) {
    const h = harness(strong, { gpu });
    await startStint(h);
    const payload = strong === SOL ? { input: [{ role: 'developer', content: 'sys' }, { role: 'user', content: 'task' }] } : { system: 'sys', messages: [] };
    const out = h.c.cheapNote({ payload });
    const text = strong === SOL ? out.input[1].content : out.system.at(-1).text;
    assert.equal(text, gpu ? CHEAP_NOTE + MEASURED_CHEAP_NOTE : CHEAP_NOTE);
  }
});

test('with a GPU a Claude command runs 10 minutes before it goes on in the background; otherwise 2, and GPT is unchanged', () => {
  const claude = { api: 'anthropic-messages' }, gpt = { api: 'openai-responses' };
  assert.equal(yieldMsFor(claude), CLAUDE_CODE_BASH_TIMEOUT_MS);
  assert.equal(yieldMsFor(claude, true), GPU_CLAUDE_BASH_TIMEOUT_MS);
  assert.equal(yieldMsFor(gpt, true), yieldMsFor(gpt));
  assert.equal(yieldNote(), YIELD_NOTE);
  assert.match(yieldNote(true), /^A command still running after 10 minutes on Claude models/);
  assert.match(YIELD_NOTE, /^A command still running after 2 minutes on Claude models/);
});
