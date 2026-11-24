/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

// Estimated token savings, reconstructed from session usage without changing agent behavior.
import { entryKey, handoffsOf } from './session.js';

function tokenCost(usage, model) {
  if (!usage || !model?.cost) return 0;
  const input = (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
  const tier = [...(model.cost.tiers ?? [])].filter(t => input > t.inputTokensAbove).sort((a, b) => b.inputTokensAbove - a.inputTokensAbove)[0];
  const p = { ...model.cost, ...tier };
  const longWrite = usage.cacheWrite1h ?? 0, shortWrite = (usage.cacheWrite || 0) - longWrite;
  return ((usage.input || 0) * (p.input || 0) + (usage.output || 0) * (p.output || 0) +
    (usage.cacheRead || 0) * (p.cacheRead ?? p.input ?? 0) + shortWrite * (p.cacheWrite ?? p.input ?? 0) + longWrite * 2 * (p.input || 0)) / 1e6;
}
const actualCost = (u, m) => Number.isFinite(u?.cost?.total) ? u.cost.total : tokenCost(u, m);
const noteCall = d => ['handback-note', 'handback-note-attempt', 'handback-note-failure'].includes(d?.mechanism);
const judgeCall = d => ['handoff-judge', 'handback-judge'].includes(d?.mechanism);

export function savingsOf(entries, registry) {
  const find = ref => ref && registry?.find(ref.provider, ref.id);
  const route = value => { const at = value?.indexOf('/') ?? -1; return at > 0 ? find({ provider: value.slice(0, at), id: value.slice(at + 1) }) : null; };
  const { spans, owned } = handoffsOf(entries);
  const fees = entries.map(e => {
    const d = e.type === 'custom' && e.customType === 'sol-pi-v2' ? e.data : null;
    const span = noteCall(d) && spans.find(s => s.id === d.stint || s.keys.has(d.stint));
    return judgeCall(d) || noteCall(d) ? actualCost(d.usage, route(d.judge ?? d.writer) ?? (span && find(span.cheap))) : 0;
  });
  const stints = spans.map((s, index) => {
    let gross = 0, overhead = 0;
    const start = index ? spans[index - 1].end ?? spans[index - 1].start : 0;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i], m = e.message;
      if (owned.get(entryKey(e))?.span === s) gross += tokenCost(m.usage, find(s.strong)) - actualCost(m.usage, find(s.cheap));
      if ((noteCall(e.data) && (s.id === e.data.stint || s.keys.has(e.data.stint))) || (judgeCall(e.data) && i >= start && i < (s.end ?? entries.length))) overhead += fees[i];
    }
    return { ...s, gross, saved: gross - overhead };
  });
  return { stints, total: stints.reduce((sum, s) => sum + s.gross, 0) - fees.reduce((sum, fee) => sum + fee, 0) };
}
