// Background bash results stay in the session and follow any note replacing their delivery turn.
import { handoffsOf, sameModel } from './session.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';
const shellScope = new AsyncLocalStorage(), children = channel('child_process');
const clip = text => text.length <= 4000 ? text : `${text.slice(0, 1950)}\n[... ${text.length - 3900} chars omitted ...]\n${text.slice(-1950)}`;
const jobText = j => j.missing
  ? `[Background job ${j.job} result not captured: ${j.command}]\nThe previous process ended before this result was captured. Rerun the command or check its output.`
  : `[Background job ${j.job} ended after ${j.minutes} min (${j.failed ? 'failed; ' : ''}exit ${j.exitCode ?? 'unknown'}): ${j.command}]\n${j.text}`;

export function backgroundJobs(log, now, waitFor, yieldText, live = { results: new Map() }, warn) {
  const jobs = new Map(), handed = new Map(), reserved = new Set(); let restored = false, offered = false, next = 0;
  const entriesOf = ctx => ctx?.sessionManager?.getBranch?.() ?? [];
  const compactionOf = ctx => entriesOf(ctx).findLast(e => e.type === 'compaction')?.id ?? null;
  function restore(ctx) {
    if (restored) return;
    restored = true;
    const launches = new Map();
    for (const e of entriesOf(ctx)) {
      if (e.type !== 'custom' || e.customType !== 'legacy-ac-activation') continue;
      const d = e.data;
      if (d?.mechanism === 'bash-yield') {
        next = Math.max(next, d.job);
        launches.set(d.job, e.id);
        jobs.set(e.id, live.results.has(e.id) ? null : { job: d.job, command: d.command ?? '(command unavailable in older session)', missing: true });
      }
      if (d?.mechanism === 'bash-yield-result') {
        const launch = d.launch ?? launches.get(d.job);
        if (jobs.has(launch)) jobs.set(launch, d);
      }
      if (d?.mechanism === 'bash-yield-end') offered = true;
      if (d?.mechanism === 'bash-yield-handover') for (const job of d.jobs) handed.set(typeof job === 'number' ? launches.get(job) : job, d.compaction);
    }
    live.complete = (launch, result) => {
      if (jobs.get(launch) !== null || !entriesOf(ctx).some(e => e.id === launch)) return;
      if (log({ kind: 'applied', mechanism: 'bash-yield-result', launch, ...result })) jobs.set(launch, result);
    };
    for (const [launch, result] of live.results) if (result) live.complete(launch, result);
  }
  function deliveries(ctx) {
    restore(ctx);
    if (!offered) return [];
    const entries = entriesOf(ctx), { spans } = handoffsOf(entries), confirmed = new Map();
    const carriers = entries.flatMap((e, at) => e.message?.role === 'toolResult' ? [{ at, ...e.message }] : []);
    const launches = new Map();
    for (const [index, entry] of entries.entries()) {
      const d = entry.data;
      if (entry.customType !== 'legacy-ac-activation') continue;
      if (d?.mechanism === 'bash-yield') launches.set(d.job, entry.id);
      if (d?.mechanism !== 'bash-yield-end') continue;
      for (const [i, item] of d.jobs.entries()) {
        const { job, minutes, failed } = item, launch = item.launch ?? launches.get(job);
        if (confirmed.has(launch) || !jobs.get(launch)) continue;
        const prefix = d.toolCallId ? jobText(jobs.get(launch)) : `[Background job ${job} ended after ${minutes} min${failed ? ' (failed)' : ''}: `;
        const nextLaunch = !d.toolCallId && entries.findIndex((e, at) => at > index && e.customType === 'legacy-ac-activation' && e.data?.mechanism === 'bash-yield' && e.data.job === job);
        const carrier = carriers.find(m => m.at > index && (d.toolCallId ? m.toolCallId === d.toolCallId : nextLaunch < 0 || m.at < nextLaunch) && m.content?.some(b => b.text?.includes('\n\n' + prefix)));
        if (!carrier) continue;
        const stint = d.stint ?? spans.find(s => s.start < carrier.at && (s.end == null || carrier.at < s.end))?.id;
        const block = carrier.content.find(b => b.text?.includes('\n\n' + prefix)).text;
        const legacy = () => {
          const notice = block.slice(block.indexOf('\n\n' + prefix) + 2).split(`\n\n[Background job ${d.jobs[i + 1]?.job} ended after `)[0];
          const start = notice.indexOf(']\n') + 2;
          return start > 1 ? notice.slice(0, start) + clip(notice.slice(start)) : clip(notice);
        };
        confirmed.set(launch, { job, launch, toolCallId: carrier.toolCallId, stint, text: d.toolCallId ? prefix : legacy() });
      }
    }
    return [...confirmed.values()];
  }
  async function execute(def, id, params, signal, ctx) {
    restore(ctx);
    let child;
    const capture = event => { if (shellScope.getStore() === capture) child = child === undefined ? event.process : null; };
    children.subscribe(capture);
    const run = Promise.resolve().then(() => shellScope.run(capture, () => def.execute(id, params, signal, undefined, ctx))).then(r => ({ r }), err => ({ err }));
    let timer; const wait = waitFor(ctx?.model);
    const first = await Promise.race([run, new Promise(res => { timer = setTimeout(() => res(null), wait); })]);
    clearTimeout(timer); children.unsubscribe(capture);
    if (first) { if (first.err) throw first.err; return first.r; }
    const job = ++next, t0 = now(), waited = Math.round(wait / 60000), command = String(params?.command ?? '');
    const logged = log({ kind: 'applied', mechanism: 'bash-yield', job, command });
    const entry = logged && entriesOf(ctx).at(-1);
    if (!entry?.id || entry.data?.mechanism !== 'bash-yield' || entry.data.job !== job) {
      warn?.(ctx, 'bash-yield-untracked', 'Cannot record this job on the selected branch; waiting for its ordinary bash result.');
      const { r, err } = await run; if (err) throw err; return r;
    }
    const launch = entry.id;
    live.results.set(launch, null); jobs.set(launch, null);
    run.then(({ r, err }) => {
      const text = err ? String(err?.message ?? err) : r?.structuredContent?.output ?? (r?.content ?? []).filter(b => b?.type === 'text').map(b => b.text).join('\n');
      const exitCode = r?.structuredContent?.exit_code ?? (text.match(/Command exited with code (\d+)/)?.[1] ? Number(text.match(/Command exited with code (\d+)/)[1]) : err || r?.isError ? null : 0);
      const result = { job, command, minutes: Math.round(waited + (now() - t0) / 60000), text: clip(text), failed: Boolean(err || r?.isError || exitCode), exitCode };
      live.results.set(launch, result); live.complete(launch, result);
    });
    const text = yieldText(waited, job, child?.exitCode === null && child.signalCode === null ? child.pid : null);
    return { content: [{ type: 'text', text }], details: { job }, structuredContent: { output: text, truncated: false, exit_code: -1, wall_time_seconds: waited * 60 } };
  }
  function notices(e, ctx) {
    restore(ctx);
    if (e?.parentToolCallId || !e?.toolCallId || !jobs.size) return undefined;
    const delivered = new Set(deliveries(ctx).map(j => j.launch));
    const entries = entriesOf(ctx);
    const done = [...jobs].filter(([launch, result]) => result && !delivered.has(launch) && !reserved.has(launch));
    if (!done.length) return undefined;
    const { active } = handoffsOf(entries);
    const stint = active && sameModel(ctx?.model, active.cheap) ? active.id : undefined;
    if (!log({ kind: 'applied', mechanism: 'bash-yield-end', toolCallId: e.toolCallId, ...(stint ? { stint } : {}), jobs: done.map(([launch, { job, minutes, failed, missing }]) => ({ launch, job, minutes, failed, missing })) })) {
      warn?.(ctx, 'bash-notice-skipped', 'Cannot record the background delivery; not forwarding its output.');
      return undefined;
    }
    offered = true;
    for (const [launch] of done) reserved.add(launch);
    const text = done.map(([, result]) => jobText(result)).join('\n\n');
    return { content: [...(Array.isArray(e?.content) ? e.content : []), { type: 'text', text: `\n\n${text}` }], structuredContent: e?.structuredContent };
  }
  function outstanding(strong, ctx, results = deliveries(ctx)) {
    if (!results.length) return [];
    const { spans } = handoffsOf(entriesOf(ctx)), compaction = compactionOf(ctx);
    const stints = new Set(spans.filter(s => s.end != null && sameModel(s.strong, strong)).map(s => s.id));
    return results.filter(j => stints.has(j.stint) && (!handed.has(j.launch) || handed.get(j.launch) === compaction));
  }
  function handOver(results, ctx) {
    const fresh = results.filter(j => !handed.has(j.launch)).map(j => j.launch);
    if (!fresh.length) return;
    const compaction = compactionOf(ctx);
    for (const job of fresh) handed.set(job, compaction);
    log({ kind: 'applied', mechanism: 'bash-yield-handover', jobs: fresh, compaction });
  }
  return { execute, notices, deliveries, outstanding, handOver, restore, endBatch: () => reserved.clear() };
}
