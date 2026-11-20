// Reconstruct only hand-offs recorded by this extension, including evaluated sessions.
import { isDeepStrictEqual } from 'node:util';

export const modelRef = m => {
  const id = m?.type === 'model_change' ? m.modelId : m?.role === 'assistant' ? m.model : m?.id;
  return m?.provider && id ? { provider: m.provider, id } : null;
};
export function sameModel(a, b) {
  const left = modelRef(a), right = modelRef(b);
  return !!left && !!right && left.provider === right.provider && left.id === right.id;
}
export const entryKey = e => e?.id ?? e;
const messageKey = m => JSON.stringify([m.provider, m.model, m.timestamp]);
const route = value => { const at = value?.indexOf('/') ?? -1; return at > 0 ? { provider: value.slice(0, at), id: value.slice(at + 1) } : null; };

// Pi clones the context messages. Resolve them to their source entries, leaving ambiguous copies alone.
export function assistantEntryLookup(entries, projection) {
  const byKey = new Map();
  function add(entry, message) {
    if (message?.role !== 'assistant') return;
    const key = messageKey(message);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push({ entry, message });
  }
  if (projection) {
    for (const { sourceEntry, messages } of projection) for (const m of messages) add(sourceEntry, m);
  } else {
    for (const e of entries) if (e.type === 'message') add(e, e.message);
  }
  return m => {
    const candidates = byKey.get(messageKey(m));
    if (!candidates || candidates.length === 1) return candidates?.[0].entry;
    const direct = candidates.filter(c => c.message === m);
    const matches = direct.length ? direct : candidates.filter(c => isDeepStrictEqual(c.message, m));
    if (matches.length === 1) return matches[0].entry;
  };
}

export function handoffsOf(entries) {
  const spans = [], owned = new Map(), noteCounts = new Map();
  let active = null, lastAssistant = null, selected = null, previous = null;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i], d = e.data;
    if (e.type === 'model_change') {
      previous = selected; selected = modelRef(e);
      if (active && !sameModel(active.cheap, selected)) { active.end = i; active = null; }
    }
    if (e.type === 'custom' && e.customType === 'legacy-ac-activation' && d?.mechanism === 'momentum-switch') {
      if (active) { active.end = i; active = null; }
      if (d.reason === 'handoff') {
        const cheap = modelRef(d.cheap ?? route(d.to)), strong = modelRef(d.strong ?? lastAssistant ?? previous);
        if (cheap && strong && !sameModel(cheap, strong)) {
          active = { id: e.id, strong, cheap, start: i, end: null, keys: new Set() }; spans.push(active);
        }
      }
    }
    if (e.type === 'message' && e.message?.role === 'assistant') {
      const m = e.message, key = `${m.model}@${m.timestamp}`;
      noteCounts.set(key, (noteCounts.get(key) ?? 0) + 1);
      if (active && sameModel(active.cheap, m)) {
        owned.set(entryKey(e), { span: active, key });
      } else if (active) { active.end = i; active = null; }
      lastAssistant = modelRef(m);
    }
  }
  // Evaluated notes name their first turn by model and time. Only reuse that key if it identifies one entry.
  for (const [id, turn] of owned) {
    if (noteCounts.get(turn.key) > 1 && typeof id === 'string') turn.key = id;
    turn.span.keys.add(turn.key);
  }
  return { spans, active, owned };
}
