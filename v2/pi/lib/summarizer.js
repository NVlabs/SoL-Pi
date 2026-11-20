// Resolve hand-off, judge and summary models and make provider-neutral nested calls.
import { CACHE_TTL_MS } from "./policy.js";

const price = (m) => (Number(m?.cost?.input) || 0) + (Number(m?.cost?.output) || 0);
const PAIRS = { "gpt-6.1-sol": "gpt-6-luna", "gpt-6.2-sol": "gpt-6-luna", "claude-opus-5-5": "claude-haiku-5-5" };
const modelName = (m) => m.id.split("/").at(-1);

function cheapest(ctx, want, sameApi) {
  const main = ctx?.model, reg = ctx?.modelRegistry;
  if (!main || !reg) return null;
  if (want) { const i = want.indexOf("/"); return i > 0 ? reg.find(want.slice(0, i), want.slice(i + 1)) ?? null : null; }
  const candidates = (reg.getAvailable?.() ?? []).filter((m) => m.provider === main.provider && (!m.type || m.type === "chat") && (!sameApi || m.api === main.api) && price(m) > 0 && price(m) < price(main))
    .sort((a, b) => price(a) - price(b));
  const pair = PAIRS[modelName(main)];
  // A provider serving both families keeps its cheapest known judge, on either API.
  const known = pair && candidates.find((m) => sameApi ? modelName(m) === pair : Object.values(PAIRS).includes(modelName(m)));
  return known || candidates[0] || null;
}
export const resolveCheapModel = (ctx, env = process.env) => cheapest(ctx, env.SOLPI_SUMMARY_MODEL, true);
export function resolveHandoffModel(ctx, env = process.env) {
  const target = cheapest(ctx, env.SOLPI_HANDOFF_MODEL, true), main = ctx?.model;
  if (target && env.SOLPI_HANDOFF_MODEL && (!ctx.modelRegistry.getAvailable?.().some(m => m.provider === target.provider && m.id === target.id) || ctx.modelRegistry.hasConfiguredAuth?.(target) !== true)) return null;
  return target && target.api === main.api && (target.id !== main.id || target.provider !== main.provider) ? target : null;
}
export const resolveJudgeModel = (ctx, env = process.env) => cheapest(ctx, env.SOLPI_JUDGE_MODEL, false);

// A rate limit, overload or server error is retried with back-off (5 s doubling) within one prompt-cache lifetime, the
// window in which the summary is worth having; it bills nothing. Any other failure is final.
const TRANSIENT_RE = /\b(429|500|502|503|504|529)\b|rate.?limit|overloaded|capacity/i;

/** A complete text reply, or a failed summary (filtered, refused, truncated, or failed after the retries). */
export async function callCheap(ctx, model, args, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
  const t0 = Date.now(); const signal = args.signal ?? AbortSignal.timeout(CACHE_TTL_MS);
  for (let wait = 5000; ; wait *= 2) {
    const r = await callOnce(ctx, model, { ...args, signal });
    if (r.ok || !TRANSIENT_RE.test(`${r.error} ${r.detail}`) || signal.aborted || Date.now() - t0 + wait > CACHE_TTL_MS) return { ...r, latencyMs: Date.now() - t0 };
    await sleep(wait);
  }
}

// The cap covers the cheap model's own thinking too: Haiku 5.5 thinks by default, and 8000 cut 7 of 250 Opus summaries short.
async function callOnce(ctx, model, { system, user, signal, maxTokens = 16000 }) {
  try {
    const res = await ctx.modelRegistry.complete(model,
      { systemPrompt: system, messages: [{ role: "user", content: [{ type: "text", text: user }], timestamp: Date.now() }] },
      { maxTokens, signal, cacheRetention: "none" });
    const text = (res?.content ?? []).filter((b) => b?.type === "text").map((b) => b.text).join("");
    if (res?.stopReason !== "stop" || !text.trim()) {
      return { ok: false, error: res?.stopReason ?? "no_reply", detail: String(res?.errorMessage ?? "").slice(0, 200), usage: res?.usage ?? null };
    }
    return { ok: true, text, usage: res.usage ?? null };
  } catch (e) {
    return { ok: false, error: "exception", detail: String(e?.message ?? e).slice(0, 200), usage: null };
  }
}

/**
 * Parse the reply:
 *   DECISION: CUT | DECLINE
 *   REASON: ...
 *   KEEP: T3, T7 | none
 *   <summary>...</summary>
 */
export function parseReply(text) {
  const t = String(text || "");
  const dm = t.match(/DECISION\s*:\s*[*`"]*\s*(CUT|DECLINE)\b/i);
  const reason = (t.match(/REASON\s*:\s*(.*)/i)?.[1] ?? "").trim().slice(0, 300);
  const km = t.match(/KEEP\s*:\s*([^\n]*)/i);
  const keep = [];
  if (km) for (const mm of km[1].matchAll(/\bT\s?(\d{1,4})\b/gi)) { const n = Number(mm[1]); if (!keep.includes(n)) keep.push(n); }
  const sm = t.match(/<summary>([\s\S]*?)<\/summary>/i) ?? t.match(/<summary>([\s\S]*)$/i);
  const summary = sm ? sm[1].trim() : "";
  let decision = dm ? dm[1].toLowerCase() : null;
  if (decision === null && /\w/.test(summary)) decision = "cut"; // format slip with a usable summary
  return { decision, reason, keep, summary };
}
