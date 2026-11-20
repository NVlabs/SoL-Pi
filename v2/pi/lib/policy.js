// SoL-Pi v2 compaction policy: pure functions, no I/O. extension.js owns the hooks, the cheap-model call and the session entries.
// Every number here is a platform fact, a price from Pi's model registry, or a measured prior (README.md "What decides").
import nodePath from "node:path";

export const CACHE_TTL_MS = 300_000; // platform: Anthropic's prompt-cache lifetime (5 min); OpenAI keeps a prefix 5-10 min
export const REREAD_PRIOR = 3; // measured prior: files re-read after a cut (36 applied cuts, no re-read rebound); a session's own cuts replace it (rereadsPerCut)

export const obj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const str = (x) => (typeof x === "string" ? x : x == null ? "" : JSON.stringify(x));
export const tok = (chars) => Math.ceil(chars / 4);
export const tsOf = (m) => { const t = obj(m) ? m.timestamp : null; const n = typeof t === "number" ? t : Date.parse(t); return Number.isFinite(n) ? n : 0; };
const clip = (s, h, t) => (s.length <= h + t + 40 ? s : `${s.slice(0, h)}\n[... ${s.length - h - t} chars omitted ...]\n${s.slice(-t)}`);
export const textOf = (m) => (typeof m?.content === "string" ? m.content
  : Array.isArray(m?.content) ? m.content.map((b) => (b?.type === "text" ? b.text : b?.type === "image" ? "[image]" : "")).filter(Boolean).join("\n") : "");

/** USD per token from Pi's model.cost (USD per million tokens); a missing cache price is billed as input. */
export function pricesOf(cost) {
  const c = obj(cost) ? cost : {};
  const m = (x) => (Number(x) > 0 ? Number(x) / 1e6 : 0);
  const input = m(c.input);
  return { input, output: m(c.output), read: m(c.cacheRead) || input, write: m(c.cacheWrite) || input };
}

export function prefixOf(message) {
  const u = obj(message) && obj(message.usage) ? message.usage : null;
  if (!u || ![u.input, u.cacheRead, u.cacheWrite].every(Number.isFinite)) return null;
  const p = u.input + u.cacheRead + u.cacheWrite;
  return p > 0 ? p : null; // an error reply carries all-zero usage: no measurement
}

/**
 * Carry: what the history added after `afterTs` has already cost on the requests made since. Each request re-read it at
 * the cache-read price, or wrote it again at the cache-write price when the cache had expired (the request read less than
 * the history it started from). Read from the messages' own usage, so it survives a restart.
 */
export function carryUsd(messages, P, afterTs = -Infinity) {
  let base = null; let c = 0;
  for (const m of messages || []) {
    if (!obj(m) || m.role !== "assistant" || !(tsOf(m) > afterTs)) continue;
    const p = prefixOf(m); if (p === null) continue;
    if (base === null) { base = p; continue; }
    c += ((Number(m.usage.cacheRead) || 0) < base ? P.write : P.read) * Math.max(0, p - base);
  }
  return c;
}

/** The session's own typical sizes: median output tokens per request, median tool-result tokens, mean tool-result chars. */
export function runStats(messages) {
  const outs = []; const res = [];
  for (const m of messages || []) {
    if (!obj(m)) continue;
    if (m.role === "assistant" && Number.isFinite(m.usage?.output)) outs.push(m.usage.output);
    else if (m.role === "toolResult") res.push(resultText(m).length);
  }
  const med = (a) => { if (!a.length) return 0; const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  return { out: med(outs), resultTok: tok(med(res)), resultChars: Math.ceil(mean(res)), requests: outs.length };
}
/** One extra request on the kept context: re-reading S tokens and a typical reply of this session. */
export const requestUsd = (S, stats, P) => S * P.read + (stats?.out || 0) * P.output;
/**
 * Priced file keep: an edited file is copied into the compaction when carrying it costs less than the expected price of a
 * pointer. p = chance that a kept file is needed before the next compaction (keptUse, or retouchShare before the session
 * has measured it); a pointer that turns out needed costs one extra request.
 * Verbatim iff (1-p) * F * (write + read*remaining) <= p * requestUsd. Largest F (chars).
 */
export function fileKeepMaxChars({ p, remaining, S, stats, P }) {
  if (!(p < 1)) return Infinity;
  const perTok = (1 - p) * (P.write + P.read * Math.max(0, remaining));
  return perTok > 0 ? Math.floor(4 * (p * requestUsd(S, stats, P)) / perTok) : Infinity;
}
/** Share of files edited in the session that were touched again (edited or read) after an edit; Laplace estimate. */
/** Whether a tool call reads, edits or names the file abs: its path argument, or a shell command naming the file. */
export function touches(call, abs, cwd = "/") {
  const a = obj(call?.arguments) ? call.arguments : {};
  const p = a.path ?? a.file_path;
  if (typeof p === "string") return nodePath.resolve(cwd, p) === abs;
  return String(call?.name || "").toLowerCase() === "bash" && typeof a.command === "string" && a.command.includes(nodePath.basename(abs));
}
/** Share of this session's edited files touched again after their first edit (Laplace). */
export function retouchShare(messages, cwd = "/") {
  const firstEdit = new Map(); const again = new Set();
  (messages || []).forEach((m, i) => {
    for (const c of toolCallsOf(m)) {
      for (const [abs, at] of firstEdit) if (at < i && touches(c, abs, cwd)) again.add(abs);
      const p = obj(c.arguments) ? c.arguments.path ?? c.arguments.file_path : null;
      if (["write", "edit"].includes(String(c.name || "").toLowerCase()) && typeof p === "string" && !firstEdit.has(nodePath.resolve(cwd, p))) firstEdit.set(nodePath.resolve(cwd, p), i);
    }
  });
  return (again.size + 1) / (firstEdit.size + 2);
}
/**
 * Kept-file use measured on this session's own compactions: of the files earlier compactions copied word for word
 * (details.solpi.files), the share the agent touched before the next compaction (Laplace). Null until one kept a file.
 */
export function keptUse(entries, cwd = "/") {
  let kept = 0; let used = 0; let open = [];
  const close = () => { kept += open.length; used += open.filter((f) => f.hit).length; };
  for (const e of entries || []) {
    if (e?.type === "compaction") { close(); open = (Array.isArray(e.details?.solpi?.files) ? e.details.solpi.files : []).map((p) => ({ abs: nodePath.resolve(cwd, p), hit: false })); }
    else if (e?.type === "message") for (const c of toolCallsOf(e.message)) for (const f of open) f.hit ||= touches(c, f.abs, cwd);
  }
  close();
  return kept ? (used + 1) / (kept + 2) : null;
}
// A file read: the read tool's path, or the last argument of a reader in a shell command (before any redirection).
const READER_RE = /^(cat|head|tail|sed -n|nl|less|grep|rg)\b/;
function readPaths(call, cwd) {
  const a = obj(call?.arguments) ? call.arguments : {};
  const name = String(call?.name || "").toLowerCase();
  if (name === "read") return typeof (a.path ?? a.file_path) === "string" ? [nodePath.resolve(cwd, a.path ?? a.file_path)] : [];
  if (name !== "bash") return [];
  return segments(str(a.command)).map(bare).filter((x) => READER_RE.test(x)).flatMap((x) => {
    const args = [];
    for (const t of x.split(/\s+/).slice(1)) { if (/^\d*[<>]/.test(t)) break; if (t && !t.startsWith("-")) args.push(t); }
    return args.length ? [nodePath.resolve(cwd, args[args.length - 1].replace(/^['"]|['"]$/g, ""))] : [];
  });
}
/**
 * Re-reads measured on this session's own compactions: per compaction, the read calls of a file read in the history it
 * removed, made before the next compaction, and the requests that made them. The prior counts as one compaction.
 */
export function rereadsPerCut(entries, cwd = "/") {
  let since = new Set(); let gone = new Set(); let cuts = 0; let calls = 0; let steps = 0;
  for (const e of entries || []) {
    if (e?.type === "compaction") { cuts += 1; gone = since; since = new Set(); continue; }
    if (e?.type !== "message") continue;
    let n = 0;
    for (const c of toolCallsOf(e.message)) for (const p of readPaths(c, cwd)) { if (gone.has(p)) n += 1; since.add(p); }
    calls += n; steps += n ? 1 : 0;
  }
  return { calls: (calls + REREAD_PRIOR) / (cuts + 1), steps: (steps + REREAD_PRIOR) / (cuts + 1) };
}

// A check builds or tests the work: the command word of a segment (after timeout/env/time prefixes), never a word in its
// arguments (`mkdir tests` and `grep check` are not checks). Running a program (./x, python x.py, node x.js) counts.
const CHECK_CMD_RE = /^(pytest|py\.test|tox|nox|make|ninja|cmake|bazel|ctest|cargo (test|build|check|run|clippy)|go (test|build|vet|run)|(npm|pnpm|yarn|bun) (test|run|t)\b|npx (jest|vitest|tsc|mocha|playwright)|jest|vitest|mocha|tsc|gcc|g\+\+|cc|c\+\+|clang|clang\+\+|javac|java|mvn|gradle|\.\/gradlew|dotnet (test|build)|swift (test|build)|zig (build|test)|ruff|mypy|eslint|rspec|phpunit|deno test|node --test|\.\/\S+|(bash|sh) \S+\.sh|python3? -m (pytest|unittest)|python3? (-\S+ )*\S+\.py|node \S+\.m?js)(\s|$)/;
const CHECKPOINT_RE = /\bgit (commit|tag)\b/;
const FAIL_TEXT_RE = /(\berror(:|\[)|\bFAIL(ED)?\b|failed with exit code|Traceback \(most recent|\bpanic\b|Segmentation fault|core dumped|AssertionError|Assertion .* failed)/;
const READONLY_RE = /^\s*(cat|head|tail|ls|grep|rg|find|wc|sed -n|less|file|stat|echo|pwd|du|df|which|nl|diff)\b/;
const PREFIX_RE = /^\s*((timeout\s+(-\S+\s+)*\S+|time|nice|env|\w+=\S+)\s+)+/;
export const bare = (seg) => seg.replace(PREFIX_RE, "");

export function toolCallsOf(message) {
  if (!obj(message) || message.role !== "assistant" || !Array.isArray(message.content)) return [];
  return message.content.filter((b) => obj(b) && b.type === "toolCall");
}
function argText(call) {
  const a = obj(call.arguments) ? call.arguments : {};
  return str(a.command ?? a.path ?? a.file_path ?? a.cmd ?? "");
}
export function resultText(msg) {
  if (!obj(msg)) return "";
  const c = msg.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.filter((b) => obj(b) && b.type === "text").map((b) => b.text).join("\n");
  return "";
}
export function commandLines(command) {
  const out = []; let term = null;
  for (const line of String(command || "").split("\n")) {
    if (term !== null) { if (line.trim() === term) term = null; continue; }
    out.push(line);
    const h = line.match(/<<-?\s*['"]?([A-Za-z_][\w]*)['"]?/);
    if (h) term = h[1];
  }
  return out;
}
export function segments(command) {
  return commandLines(command).flatMap((l) => l.split(/&&|\|\||;|\|/)).map((x) => x.trim()).filter(Boolean);
}
const isCheckSeg = (x) => !READONLY_RE.test(x) && CHECK_CMD_RE.test(bare(x));
export function cmdKey(command) {
  const segs = segments(command);
  const cd = [...segs].reverse().find((x) => /^cd\s/.test(x));
  const seg = bare([...segs].reverse().find(isCheckSeg)
    ?? [...segs].reverse().find((x) => !READONLY_RE.test(x) && !/^cd\b/.test(x)) ?? segs[segs.length - 1] ?? "");
  const toks = seg.split(/\s+/).filter((t) => t && !/^\d?>/.test(t) && !/^<</.test(t) && !/^2>&1$/.test(t));
  return ((cd ? cd.replace(/\s+/g, " ") + " :: " : "") + toks.join(" ")).slice(0, 240);
}
/** One command line whose result belongs to its check: no `;`, `||`, background or substitution, pipes only into filters. */
export function unambiguousCommand(command) {
  const lines = commandLines(command).map((l) => l.trim()).filter(Boolean);
  if (lines.length !== 1) return false;
  const s = lines[0].replace(/\d?>&\d/g, "").replace(/&>/g, ">");
  if (/(;|\|\||(^|[^&])&(?!&)|`|\$\()/.test(s)) return false;
  return s.split(/(?<!\|)\|(?!\|)/).slice(1).every((x) => /^\s*(head|tail|grep|tee|cat|wc|sed -n|cut|sort|uniq)\b/.test(x));
}
export function classifyCall(call, result) {
  const name = String(call.name || "").toLowerCase();
  const text = argText(call);
  const rt = resultText(result);
  const isCheck = name === "bash" && segments(text).some(isCheckSeg);
  const failed = !!(result && result.isError) || /(Command )?exited with code [1-9]/.test(rt) || (isCheck && FAIL_TEXT_RE.test(rt));
  const kind = name === "bash" && CHECKPOINT_RE.test(text) ? "checkpoint" : isCheck ? "check" : null;
  return { kind, failed, name, text };
}
/** Finished tool calls in transcript order: {seq, index (assistant msg), resultIndex, id, kind, failed, key, ...}. */
export function scanEvents(messages) {
  const results = new Map();
  messages.forEach((m, i) => { if (obj(m) && m.role === "toolResult" && m.toolCallId) results.set(m.toolCallId, { m, i }); });
  const events = [];
  messages.forEach((m, index) => {
    for (const call of toolCallsOf(m)) {
      const r = results.get(call.id);
      if (!r) continue;
      const c = classifyCall(call, r.m);
      events.push({ seq: events.length, index, resultIndex: r.i, id: call.id, kind: c.kind, failed: c.failed, tool: c.name, call,
        command: c.text.slice(0, 300), key: c.kind === "check" ? cmdKey(c.text) : null, unambiguous: unambiguousCommand(c.text), result_text: resultText(r.m) });
    }
  });
  return events;
}
/** Open failing checks: key -> newest failing event (a pass clears the same key when its result is unambiguous). */
export function failureLedger(events) {
  const open = new Map();
  for (const e of events) {
    if (!e.key) continue;
    if (e.failed) open.set(e.key, e);
    else if (e.unambiguous) open.delete(e.key);
  }
  return open;
}
/** Newest passing check outputs, one per command key, oldest first. */
export function recentResults(events, { tailChars = Infinity } = {}) {
  const pick = []; const keys = new Set();
  for (const e of [...events].reverse()) {
    if (e.kind !== "check" || e.failed || keys.has(e.key)) continue;
    keys.add(e.key); pick.push(e);
  }
  return pick.reverse().map((e) => ({ command: e.command.replace(/\s+/g, " ").slice(0, 200), tail: tailOf(e.result_text, tailChars) }));
}
/** Tail of an output, at most n chars (n = the session's mean tool-result size, so a kept output is a typical one). */
export const tailOf = (t, n) => { t = String(t ?? "").trimEnd(); return n > 0 && t.length > n ? "[...]\n" + t.slice(-n) : t; };

const msgChars = (m) => {
  if (!obj(m)) return 0;
  if (m.role === "compactionSummary" || m.role === "branchSummary") return str(m.summary).length;
  if (m.role === "bashExecution") return str(m.command).length + str(m.output).length;
  if (typeof m.content === "string") return m.content.length;
  if (!Array.isArray(m.content)) return 0;
  return m.content.reduce((a, b) => a + (obj(b) ? str(b.text ?? b.thinking ?? "").length + str(b.thinkingSignature ?? "").length + (b.type === "toolCall" ? str(b.arguments).length + 40 : 0) : 0), 0);
};
/** Estimated tokens of messages as sent (an assistant reply counts at least its measured output, reasoning included). */
export const estTokens = (msgs) => msgs.reduce((a, m) => a + (obj(m) && m.role === "assistant" ? Math.max(Number(m.usage?.output) || 0, tok(msgChars(m))) : tok(msgChars(m))), 0);

/** Files written by the tool calls of messages[from..to], most recent first. */
export function editedFiles(messages, from, to, cwd = "/") {
  const seen = new Map(), results = new Map(), calls = new Map();
  for (let i = from; i <= to; i++) {
    const m = messages[i];
    if (m?.role === 'toolResult' && m.toolCallId) results.set(m.toolCallId, results.has(m.toolCallId) ? null : { m, i });
    for (const c of toolCallsOf(m)) calls.set(c.id, calls.has(c.id) ? null : i);
  }
  for (let i = from; i <= to; i++) {
    for (const c of toolCallsOf(messages[i])) {
      const name = String(c.name || "").toLowerCase();
      const a = obj(c.arguments) ? c.arguments : {};
      const result = results.get(c.id);
      const success = calls.get(c.id) === i && result?.i > i && result.m.toolName === name && result.m.isError === false;
      if (name === 'read' && typeof a.path === 'string') {
        const file = seen.get(nodePath.resolve(cwd, a.path)), blocks = result?.m.content;
        if (file?.finished < i && success && a.offset == null && a.limit == null && !result.m.details?.truncation && blocks?.length === 1 && blocks[0].type === 'text') {
          file.text = blocks[0].text;
        }
      }
      const paths = [];
      if (["write", "edit"].includes(name) && typeof (a.path ?? a.file_path) === "string") paths.push(a.path ?? a.file_path);
      if (name === "bash" && typeof a.command === "string") {
        const cmd = commandLines(a.command).join("\n");
        for (const mm of cmd.matchAll(/(?:(?<![0-9&])>>?|\btee\s+(?:-a\s+)?)\s*([\w./~+-]+\.[A-Za-z]\w{0,7})\b/g)) paths.push(mm[1]);
        for (const mm of cmd.matchAll(/\bsed\s+-i\S*\s+(?:-e\s+)?(?:'[^']*'|"[^"]*"|\S+)\s+([\w./+-]+\.[A-Za-z]\w{0,7})\b/g)) paths.push(mm[1]);
      }
      for (const p of paths) {
        if (/^\/dev\//.test(p)) continue;
        const abs = nodePath.resolve(cwd, p);
        seen.delete(abs); seen.set(abs, { path: p, abs, at: i, finished: success && name !== 'bash' ? result.i : undefined, text: null });
      }
    }
  }
  return [...seen.values()].reverse();
}

/** Context tokens of turn [a, end]: the assistant message (incl. its reasoning) and its tool results. */
export function turnTokens(messages, a, end) {
  return estTokens([messages[a]]) + estTokens(messages.slice(a + 1, end + 1));
}
/** Index range [a, end] of an assistant turn and its directly following tool results (end <= k). */
export function turnSpan(messages, a, k) {
  const ids = new Set(toolCallsOf(messages[a]).map((b) => b.id));
  let end = a;
  while (end + 1 <= k && obj(messages[end + 1]) && messages[end + 1].role === "toolResult" && ids.has(messages[end + 1].toolCallId)) end++;
  return end;
}
/**
 * Labelled visible transcript of the given message indices for the cheap model: never reasoning. Every assistant turn
 * with tool calls gets a label T<n> (keepable); returns {text, turns: [{n, index}]}. Clipping tightens until it fits.
 */
export function labeledTranscript(messages, idxs, maxChars) {
  const levels = [
    { resultHead: 1500, resultTail: 1500, argMax: 1500, argTail: 500, textHead: 3000, textTail: 1000 },
    { resultHead: 600, resultTail: 600, argMax: 600, argTail: 300, textHead: 1500, textTail: 500 },
    { resultHead: 250, resultTail: 250, argMax: 300, argTail: 150, textHead: 600, textTail: 300 },
  ];
  let res = null;
  for (const L of levels) {
    const out = []; const turns = []; let n = 0;
    for (const i of idxs) {
      const m = messages[i];
      if (!obj(m)) continue;
      if (m.role === "user") { const t = textOf(m); if (t) out.push(`[user]\n${clip(t, 6000, 2000)}`); }
      else if (m.role === "compactionSummary" || m.role === "branchSummary") out.push(`[summary of the earlier work]\n${str(m.summary)}`);
      else if (m.role === "bashExecution") out.push(`[shell command run by the user]\n$ ${str(m.command)}\n${clip(str(m.output), L.resultHead, L.resultTail)}`);
      else if (m.role === "custom") { const t = textOf(m); if (t) out.push(`[message from an extension]\n${clip(t, L.textHead, L.textTail)}`); }
      else if (m.role === "assistant" && Array.isArray(m.content)) {
        if (toolCallsOf(m).length) { n += 1; turns.push({ n, index: i }); out.push(`=== T${n} ===`); }
        for (const b of m.content) {
          if (!obj(b)) continue;
          if (b.type === "text" && b.text) out.push(`[assistant]\n${clip(b.text, L.textHead, L.textTail)}`);
          else if (b.type === "toolCall") out.push(`[tool call ${b.name}]\n${clip(str(b.arguments), L.argMax, L.argTail)}`);
        }
      } else if (m.role === "toolResult") {
        out.push(`[tool result ${m.toolName ?? ""}${m.isError ? " ERROR" : ""}]\n${clip(resultText(m), L.resultHead, L.resultTail)}`);
      }
    }
    res = { text: out.join("\n\n"), turns };
    if (res.text.length <= maxChars) return res;
  }
  const head = res.text.slice(0, Math.floor(maxChars * 0.2));
  const tail = res.text.slice(-Math.floor(maxChars * 0.8));
  const text = `${head}\n[... middle of the range omitted for length ...]\n${tail}`;
  return { text, turns: res.turns.filter((t) => text.includes(`=== T${t.n} ===`)) };
}

/**
 * Possible verbatim tails of the closed range (h, k] (k = last tool result before the newest turn), shortest first:
 * [{k: k2, turns, tokens}], k2 always a tool result followed by an assistant message (closed pairs, alternation kept).
 */
export function tailOptions(messages, h, k, maxTurns = Infinity) {
  const out = [{ k, turns: 0, tokens: 0 }];
  let tokens = 0; let turns = 0; let i = k;
  while (turns < maxTurns) {
    let a = i;
    while (a > h && obj(messages[a]) && messages[a].role === "toolResult") a--;
    if (a <= h + 1 || !obj(messages[a]) || messages[a].role !== "assistant") break;
    const end = turnSpan(messages, a, k);
    if (end !== i || end - a !== toolCallsOf(messages[a]).length) break;
    tokens += turnTokens(messages, a, end);
    turns += 1;
    const k2 = a - 1;
    if (k2 <= h + 1 || !obj(messages[k2]) || messages[k2].role !== "toolResult") break;
    out.push({ k: k2, turns, tokens });
    i = k2;
  }
  return out;
}
/**
 * The current work-loop iteration: assistant turns since the newest check, checkpoint or failed step before message k,
 * at most the session's median completed iteration. Without a completed iteration, the newest turn only.
 */
export function loopTurns(messages, events, h, k) {
  const marks = [...new Set(events.filter((e) => e.index <= k && (e.kind || e.failed)).map((e) => e.index))].sort((x, y) => x - y);
  const turnsBetween = (a, b) => { let n = 0; for (let i = a + 1; i <= b; i++) if (obj(messages[i]) && messages[i].role === "assistant") n++; return n; };
  const gaps = [];
  for (let i = 1; i < marks.length; i++) gaps.push(turnsBetween(marks[i - 1], marks[i]));
  if (!gaps.length) return 1;
  gaps.sort((x, y) => x - y);
  const median = gaps[Math.floor(gaps.length / 2)];
  const last = marks[marks.length - 1];
  return Math.max(1, Math.min(last > h ? turnsBetween(last, k) : median, median));
}
const PRIOR_REREADS = { calls: REREAD_PRIOR, steps: REREAD_PRIOR };
/** The re-reads a cut causes (stats.rereads, else the prior): each call writes a typical result, each request re-reads S. */
const rereadUsd = (stats, P, S) => { const r = stats?.rereads ?? PRIOR_REREADS; return r.calls * (stats?.resultTok || 0) * P.write + r.steps * ((stats?.out || 0) * P.output + S * P.read); };
/** The part of a cut's price that a verbatim tail of t tokens adds (rewrite, re-read requests, re-planning read). */
export const tailPriceUsd = (t, priced, P, rereads = PRIOR_REREADS) => t * ((P.write - P.read) + rereads.steps * P.read + (priced ? P.read : 0));
/** The part of a cut's price that does not depend on its size (the session's re-reads at its own sizes). */
export const cutPriceFloor = (stats, P) => rereadUsd(stats, P, 0);

/**
 * Whether the next request finds the prompt cache expired: the newest request's tools ran past the cache lifetime (the
 * session's own clock, request to its last tool result), and no request of this session after such a pause still read its
 * cache (a provider that keeps it longer).
 */
export function cacheCold(messages) {
  let prev = null; let end = 0; let keeps = false;
  for (const m of (messages || []).filter(obj)) {
    if (m.role === "toolResult" && prev) end = Math.max(end, tsOf(m));
    if (m.role !== "assistant") continue;
    const p = prev && prefixOf(prev);
    if (p && end - tsOf(prev) > CACHE_TTL_MS && prefixOf(m) !== null && (Number(m.usage.cacheRead) || 0) >= p / 2) keeps = true;
    prev = m; end = 0;
  }
  return !keeps && tsOf(prev) > 0 && end - tsOf(prev) > CACHE_TTL_MS;
}

/**
 * Cut gate, priced only. cost = rewrite of everything after the system prompt + the summary call + the re-read prior +
 * one re-planning request off a check/checkpoint boundary. Cut iff the re-reads already paid on the history since the last
 * cut (carry) reach the cost (ski-rental) and the saving over the expected remaining requests covers it. On a cold cache
 * the next request writes the whole context again anyway: the cut adds no rewrite and spares writing the closed history.
 */
export function cutGate({ X, S, remaining, cold = false, summaryInTokens, summaryOutTokens = 0, carryUsd = null, replanUsd = 0, stats = null, P, SP }) {
  const r = (x) => Math.round(x * 1e5) / 1e5;
  if (!(X > 0)) return { pays: false, reason: "nothing_to_cut" };
  const saving = X * (cold ? P.write + P.read * Math.max(0, remaining - 1) : P.read * remaining);
  const rewrite = cold ? 0 : S * (P.write - P.read);
  const summary = summaryInTokens * SP.input + summaryOutTokens * SP.output;
  const reread = rereadUsd(stats, P, S);
  const cost = rewrite + summary + reread + (replanUsd || 0);
  const g = { X: Math.round(X), S: Math.round(S), remaining: r(remaining), saving_usd: r(saving), rewrite_usd: r(rewrite), summary_usd: r(summary), reread_usd: r(reread),
    replan_usd: r(replanUsd || 0), cost_usd: r(cost), carry_usd: carryUsd == null ? null : r(carryUsd), ...(cold ? { cold: true } : {}) };
  if (carryUsd != null && carryUsd < cost) return { pays: false, reason: "carry_below_cut_price", ...g };
  if (saving < cost) return { pays: false, reason: "saving_below_cost", ...g };
  return { pays: true, reason: "pays", ...g };
}

/**
 * Plan anchor (the agent's plan lives in its reasoning; losing the planning turn made it re-plan every request): the
 * turn with the most reasoning in (lower, k], searched only after the newest user message (an older plan may be stale).
 */
export function planAnchor(messages, lower, k) {
  const thinkChars = (m) => (Array.isArray(m?.content) ? m.content.filter((b) => obj(b) && b.type === "thinking").reduce((a, b) => a + str(b.thinking).length, 0) : 0);
  let from = lower;
  for (let i = k; i > lower; i--) if (obj(messages[i]) && messages[i].role === "user") { from = i; break; }
  let best = null;
  for (let i = from + 1; i <= k; i++) {
    const m = messages[i];
    if (!obj(m) || m.role !== "assistant" || !toolCallsOf(m).length) continue;
    const t = thinkChars(m);
    if (t > 0 && (!best || t >= best.t)) best = { i, t };
  }
  if (!best) return null;
  const end = turnSpan(messages, best.i, k);
  if (end - best.i !== toolCallsOf(messages[best.i]).length) return null;
  return { index: best.i, end, id: toolCallsOf(messages[best.i])[0]?.id ?? null };
}

const SUMMARY_SECTIONS = [
  "If the range starts with a [summary of the earlier work], your summary replaces it: carry its requests, work done, results and findings into your sections, shortening older items rather than dropping them, so that your summary covers the whole session.",
  "1. Requests and constraints: what the user asked for and every requirement, constraint or preference the user or the agent established (quote exact numbers, formats, paths).",
  "2. Work done: what was built or changed, in which files, and how (functions, algorithms, parameters).",
  "3. Results: every measured result, test outcome and number, with the command that produced it.",
  "4. Findings and dead ends: approaches tried and why they were kept or rejected.",
  "5. Environment: commands used to build, run and test; important directories and files.",
  "6. Open items: work that was started in this range and is not finished yet, with its exact state; the current best version or result and what it is compared against; the next step the agent last said it would take (quote it).",
  "Do not reproduce source code or long verbatim passages in the summary: name files, functions and parameters instead (the files are on disk).",
  "Report facts only, as a mid-session work log. Do not give instructions, do not write a final report, do not say whether the work is finished or should continue, and do not invent anything not in the log.",
];

export const SUMMARY_SYSTEM = [
  "You compact the earlier part of a coding agent's session so the agent can keep working with a shorter context.",
  "The range you receive is closed: the agent has moved past it, and its newest turns stay in its context outside this range.",
  "The harness separately keeps, word for word, every message the user wrote, the latest outputs of passing checks, unresolved failing checks and the current disk content of edited files, so you do not need to preserve those.",
  "The range is split into turns labelled T1, T2, ... (one assistant step: its text, tool calls and tool results). You see only visible messages, tool calls and tool results.",
  "Do two things:",
  "A. KEEP: list the few turns whose exact text the agent still needs verbatim to continue (for example exact specifications, interfaces, formats or error output it is still working on that a summary would distort). Most important first, at most 6. Do not keep turns only as history. Write 'none' if nothing must stay verbatim.",
  "B. SUMMARY: summarize everything else factually in plain text, at most about 1200 words, with these sections:",
  ...SUMMARY_SECTIONS,
  "Ongoing or iterative work (tuning, experiments, debugging) is NOT a reason to decline: record its state under Open items and keep the turns it needs.",
  "DECLINE only if the range holds unfinished work whose state would be lost even with your summary and kept turns (for example a multi-step change that exists only in the log and not on disk).",
  "Reply exactly in this format:",
  "DECISION: CUT or DECLINE",
  "REASON: <one line>",
  "KEEP: <comma-separated turn labels such as T3, T7, or none>",
  "<summary>",
  "...your summary...",
  "</summary>",
].join("\n");

// Pi has already chosen what to remove and what to keep.
export const SUMMARY_ONLY_SYSTEM = [
  "You summarize a coding agent's session so it can keep working with a shorter context.",
  "Pi has already chosen the cut and kept tail. Summarize the whole range below, including unfinished work and exact details needed to continue; no turns in this range will be kept separately.",
  "You see visible messages, tool calls and tool results. Write a factual summary of at most about 1200 words with these sections:",
  ...SUMMARY_SECTIONS,
  "Reply with <summary>...your summary...</summary> only.",
].join("\n");

/** The compaction text Pi stores and sends in place of the compacted history. */
export function compactionText({ users = [], summary, keptTurns = 0, results = [], failures = [], files = [] }) {
  const parts = ["[Cost-harness compaction: part 2 was written by a smaller model from the visible messages and tool output only; parts 1 and 3 were copied word for word." +
    (keptTurns ? ` ${keptTurns} earlier step(s) were kept as they were and follow this summary, before the most recent work.` : "") +
    " Files on disk are authoritative; re-read a file before editing it if its content is not shown here.]"];
  if (users.length) parts.push("## 1. Messages from the user (verbatim, oldest first)\n" + users.map((u, i) => `[${i + 1}] ${u.text ?? u}`).join("\n\n"));
  parts.push("## 2. Summary of the earlier work\n" + String(summary).trim());
  const kept = [];
  if (results.length) kept.push("### Latest outputs of passing checks (tails, oldest first)\n" + results.map((r) => `$ ${r.command}\n${r.tail}`).join("\n\n"));
  if (failures.length) kept.push("### Unresolved failing checks (latest failing output)\n" + failures.map((f) => `$ ${f.command}\n${f.tail}`).join("\n\n"));
  const verbatim = files.filter((f) => f.text != null);
  const pointers = files.filter((f) => f.text == null);
  if (verbatim.length) kept.push("### Confirmed content of edited files\n" + verbatim.map((f) => `--- ${f.path}\n${f.text}`).join("\n\n"));
  if (pointers.length) kept.push("### Other edited paths\n" + pointers.map((f) => `- ${f.path}`).join("\n"));
  if (kept.length) parts.push("## 3. Kept verbatim\n" + kept.join("\n\n"));
  return parts.join("\n\n");
}
