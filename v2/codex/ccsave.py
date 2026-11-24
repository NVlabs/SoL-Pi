# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: MIT
"""Local Responses API proxy: judged hand-offs, hand-back notes and prompt-cache keep-warm.
See README.md for use.
"""
import hashlib
from contextlib import closing
import http.client
import http.server
import json
import os
import re
import socket
import ssl
import unicodedata
import sys
import threading
import time
import urllib.parse
import zlib
import signal

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
from records import open_record, replacement

UP = urllib.parse.urlparse(os.environ.get("CCSAVE_UPSTREAM", "").strip())
PORT = int(os.environ.get("CCSAVE_PORT") or 0)
LOG = os.environ.get("CCSAVE_LOG", "")
LOG_HANDLE = None
LOG_TEXT = os.environ.get("CCSAVE_LOG_TEXT", "1") != "0"
PING_S = float(os.environ.get("CCSAVE_PING_S") or 270)  # 0 turns keep-warm off
STOP_AFTER_S = 3600
PING_TEXT = "This is an automated cache keep-alive request, not part of the task. Reply with just: ok"
HOP = {"host", "content-length", "connection", "transfer-encoding", "keep-alive", "proxy-connection", "te", "trailer", "upgrade"}
PARENT = os.getppid()
CHEAP = os.environ.get("CCSAVE_CHEAP_MODEL", "")
_CHEAP_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cheap-model.txt")
if "CCSAVE_CHEAP_MODEL" not in os.environ and os.path.exists(_CHEAP_FILE):
    with open(_CHEAP_FILE) as f:
        CHEAP = f.read().strip()
STATE_FILE = LOG + ".state" if LOG else ""
# As in the Pi extension, the judge first looks at the configured model's 10th call, then every 10 calls; the same on the
# cheap model.
JUDGE_EVERY = int(os.environ.get("CCSAVE_JUDGE_EVERY") or 10)
TASK_CHARS, TRAJ_ITEMS, TRAJ_CHARS = 6000, 80, 40000  # the judge's task and recent-work sizes, as in the Pi extension
NOTE_CHARS = 4 * 136000  # as in the Pi extension, the note writer gets 4 characters a token over half of its window (Luna: 272k)

# The Pi extension's prompts (../pi/extension.js), word for word, except the return judge's last rule and NOTE_HEAD.
JUDGE_INSTRUCTIONS = """You decide when a coding agent may hand its next steps to a cheaper model.

So far the agent has worked on a strong, expensive model. If you approve, a much cheaper and weaker model takes over the same
session: it sees the whole conversation, the same files and the same tools. The hand-off is not final: the cheaper model's work
is checked every 10 steps, and the strong model comes back as soon as it is stuck or its results get worse. So
judge the next steps, not the whole task. A step on the cheaper model costs a small fraction of a step on the strong model; a
hard step on the cheaper model loses quality, because it is worse at hard reasoning.

Approve when the next steps carry out something already decided, for example:
- running, repeating or checking experiments, tests or evaluations, and reading their results;
- trying parameter values or variants of a change that already works;
- applying an established fix to more cases, small edits, cleaning up, or writing the report.

Keep the strong model when the next step itself needs hard reasoning:
- designing or choosing an approach, or comparing approaches;
- debugging a failure whose cause is not clear, a regression or wrong results;
- a new algorithm, a non-trivial refactor, or careful reasoning about correctness or performance;
- writing or repairing a proof or a mathematical argument.

Reply with one JSON object and nothing else:
{"handoff": true or false, "phase": "<a short phrase naming the current phase>", "reason": "<one or two sentences>"}"""
RETURN_INSTRUCTIONS = """You decide when a coding agent should give its work back from a cheaper model to the strong model.

The agent started on a strong, expensive model, which handed the work to a much cheaper and weaker model. If you approve, the
strong model takes the work back and continues. Keeping the cheaper model saves cost; the strong model is needed when the
cheaper model cannot make progress on its own.

Give the work back when:
- the cheaper model is stuck: the same error or failing check keeps coming back, or its recent attempts made no progress;
- its results got worse, or something broke for a reason that is not obvious;
- it starts writing or repairing a proof or a mathematical argument, which needs the strong model;
- the steps it took over are done and the next step needs a new decision.

Otherwise keep the cheaper model, also when the work left is open-ended: while it makes progress, it goes on.

Reply with one JSON object and nothing else:
{"handback": true or false, "phase": "<a short phrase naming the current phase>", "reason": "<one or two sentences>"}"""
HANDBACK_NOTE_SYSTEM = """You write a hand-off note for a coding agent. A cheaper model worked on the task for a while; the stronger model now
takes the work back. It will not see the cheaper model's steps below, only your note. Write:
1. Done: what was changed or run (files, commands) and the results actually observed (tests, errors, measurements), quoting
   numbers and error messages exactly.
2. State: where the work stands now.
3. Open: what is unfinished, failed or still unclear.
4. Unverified: anything the cheaper model claimed or assumed without checking.
Report only what the steps show; do not propose a new plan. Plain text, at most 300 words."""
NOTE_HEAD = "[Hand-off note. A cheaper model carried out steps since your last turn; its steps are not shown. The note is its report: what it did, the results, what is open and what it did not verify. Look again only at what your next decision depends on.]"
# Guidelines for both models: batch independent reads; keep reasoning short on routine steps.
GUIDELINES = {"type": "message", "role": "developer", "content": [{"type": "input_text", "text": (
    "When you need several independent read-only actions (reading files, listing directories, searching code, viewing logs, "
    "git status/log/show/diff), issue them together as parallel tool calls in one turn, or combine them in one bash command, "
    "instead of one per turn: every extra turn re-reads the whole conversation. Keep separate turns when a step depends on the "
    "previous result.\n\nYour reasoning is billed and re-read on every later turn. On routine steps (reading files, small edits, "
    "re-running a command, formatting fixes) keep your thinking to a few sentences; think at length when planning, designing an "
    "approach, or debugging a failure.")}]}
TOOL_CALL_RE = re.compile(r"\btools\.[A-Za-z_]\w*\(")  # one tool call inside a code-mode script: the judges count calls, not scripts
CHEAP_NOTE = {"type": "message", "role": "developer", "content": [{"type": "input_text", "text": (
    "You have taken over this session from a stronger model to carry out steps it has already decided; a note where you took "
    "over says which. Carry them out and check each result. End your turn with a short report of what you did and the results "
    "as soon as those steps are done, or earlier when the next step needs a new decision: choosing or changing an approach, "
    "debugging a failure whose cause is not clear, a new algorithm, or a proof. The stronger model reads your report and "
    "decides what comes next.")}]}
BRIEF = "[The stronger model hands you the next steps: {}]"


def log(rec):
    if not LOG_TEXT:
        rec = {k: v for k, v in rec.items() if k not in ("text", "error_body")}
    if LOG_HANDLE:
        LOG_HANDLE.write((json.dumps(rec) + "\n").encode())
        LOG_HANDLE.flush()


def upstream():
    if UP.scheme == "https":
        return http.client.HTTPSConnection(UP.hostname, UP.port or 443, timeout=1800, context=ssl.create_default_context())
    return http.client.HTTPConnection(UP.hostname, UP.port or 80, timeout=1800)


def responses_ping(body):
    """The configured model's latest Responses request, unstreamed, asking for "ok" at low effort through a trailing item."""
    ask = {"type": "message", "role": "user", "content": [{"type": "input_text", "text": PING_TEXT}]}
    return dict({k: v for k, v in body.items() if k != "stream"}, input=list(body.get("input") or []) + [ask, {"type": "configuration_update", "reasoning": {"effort": "low"}}],
                max_output_tokens=512, tool_choice="none")


def item_type(it):
    return it.get("type", "message" if it.get("role") else None)


def text_of(it):
    c = it.get("content")
    return c if isinstance(c, str) else " ".join(b.get("text", "") for b in c or [] if isinstance(b, dict))


def output_of(it):
    o = it.get("output")
    return o if isinstance(o, str) else " ".join(b.get("text", "") for b in o if isinstance(b, dict)) if isinstance(o, list) else json.dumps(o)


def clip(t, head, tail):
    return t if len(t) <= head + tail + 40 else f"{t[:head]}\n[... {len(t) - head - tail} chars omitted ...]\n{t[-tail:]}"


def transcript(items, max_chars):
    """The Pi extension's labeled transcript, of Codex's items: user and assistant messages, tool calls and results (reasoning is
    encrypted), at the first of three clip levels that fits max_chars, else its head and tail."""
    for rh, rt, am, at, th, tt in ((1500, 1500, 1500, 500, 3000, 1000), (600, 600, 600, 300, 1500, 500), (250, 250, 300, 150, 600, 300)):
        out, n = [], 0
        for it in items:
            t, role = item_type(it), it.get("role")
            if t == "message" and role == "user":
                out.append(f"[user]\n{clip(text_of(it), 6000, 2000)}")
            elif t == "message" and role == "assistant":
                out.append(f"[assistant]\n{clip(text_of(it), th, tt)}")
            elif t in ("custom_tool_call", "function_call"):
                n += 1
                out.append(f"=== T{n} ===\n[tool call {it.get('name', '')}]\n{clip(str(it.get('input') or it.get('arguments') or ''), am, at)}")
            elif t in ("custom_tool_call_output", "function_call_output"):
                out.append(f"[tool result]\n{clip(output_of(it), rh, rt)}")
        text = "\n\n".join(out)
        if len(text) <= max_chars:
            return text
    return f"{text[:int(max_chars * 0.2)]}\n[... middle of the range omitted for length ...]\n{text[-int(max_chars * 0.8):]}"


def task_of(items):
    """The task prompt: the first user message that is not Codex's environment context or AGENTS.md."""
    users = [text_of(it) for it in items if item_type(it) == "message" and it.get("role") == "user"]
    return next((t for t in users if not t.lstrip().startswith(("<", "# AGENTS.md"))), users[0] if users else "")


def matching_range(span, prefix):
    return 0 <= span['a'] <= span['b'] <= len(prefix) and digest(prefix[span['a']:span['b']]) == span.get('content')


def view(items, stints, prefix):
    """Codex's history with each finished stint's items [a, b) replaced by its hand-off note (no note: as it is)."""
    out, at = [], 0
    for s in stints:
        if s.get("note") and at <= s["a"] < s["b"] and matching_range(s, prefix):
            out += items[at:s["a"]] + [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": f"{NOTE_HEAD}\n\n{s['note']}"}]}]
            needed = {it['call_id'] for it in items[s['b']:] if it.get('call_id') and (item_type(it) or '').endswith('_output')}
            out.extend(it for it in items[s["a"]:s["b"]] if instruction(it) or
                       (it.get('call_id') in needed and not (item_type(it) or '').endswith('_output')))
            at = s["b"]
    return out + items[at:] if at else items


def with_cheap_note(items, brief=None, at=None):
    """The cheap model's request: the note right after Codex's first developer message (the same place every time) and
    the hand-off judge's reason as a brief at `at`, where the stint begins (the same place through the stint)."""
    if brief and at is not None and 0 <= at <= len(items):
        items = items[:at] + [{"type": "message", "role": "developer", "content": [{"type": "input_text", "text": BRIEF.format(brief)}]}] + items[at:]
    i = next((k for k, it in enumerate(items) if item_type(it) == "message" and it.get("role") == "developer"), None)
    return items if i is None else items[:i + 1] + [CHEAP_NOTE] + items[i + 1:]


def with_guidelines(items):
    """The guidelines right after Codex's first developer message (the same place every time)."""
    i = next((k for k, it in enumerate(items) if item_type(it) == "message" and it.get("role") == "developer"), None)
    return items if i is None else items[:i + 1] + [GUIDELINES] + items[i + 1:]


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def mark(it, calls=None, index=None):
    kind = item_type(it)
    fields = {k: v for k, v in it.items() if k not in ('type', 'status', 'metadata') and (k != 'id' or kind == 'item_reference')}
    link = it.get('call_id')
    if calls is None:
        fields.pop('call_id', None)
    elif isinstance(link, str):
        if (kind or '').endswith('_output'):
            fields['call_id'] = calls.get(link, link)
        else:
            fields['call_id'] = calls[link] = index
    if kind == "message" and isinstance(fields.get("content"), str):
        fields["content"] = [{"type": "output_text" if it.get("role") == "assistant" else "input_text", "text": fields["content"]}]
    for key in ("content", "output"):
        if isinstance(fields.get(key), list):
            fields[key] = [{k: v for k, v in b.items() if k not in ("id", "status", "logprobs", "metadata") and (k != 'annotations' or v)}
                           if isinstance(b, dict) and b.get('type') in ('input_text', 'output_text') else b for b in fields[key]]
    return digest([kind, fields])


def marks(items):
    calls, targets, prefix = {}, {}, []
    for index, it in enumerate(items):
        signature = mark(it, calls, index)
        target = it.get('id')
        if isinstance(target, str):
            if item_type(it) == 'item_reference':
                signature = digest([signature, targets.get(target)])
            else:
                targets[target] = index
        prefix.append(signature)
    return prefix


def decision(text, key):
    m = re.search(r"\{.*\}", text or "", re.S)
    try:
        v = json.loads(m.group(0)) if m else None
    except ValueError:
        return None
    return v.get(key) if isinstance(v, dict) and isinstance(v.get(key), bool) else None


def reason_of(text):
    """The judge's reason, the brief for the cheap model."""
    m = re.search(r"\{.*\}", text or "", re.S)
    try:
        v = json.loads(m.group(0)) if m else None
    except ValueError:
        return None
    return (str(v.get("reason") or "").strip()[:1000] or None) if isinstance(v, dict) else None


def object_of(raw):
    try:
        value = json.loads(raw)
        if isinstance(value, dict):
            return value
    except ValueError:
        pass


def decoder_of(response):
    bits = {"gzip": 31, "deflate": 15}.get((response.getheader("content-encoding") or "").lower())
    if not bits:
        return lambda chunk: chunk
    decoder = zlib.decompressobj(bits)
    def decode(chunk):
        nonlocal decoder
        parts = []
        while chunk:
            if bits == 31 and decoder.eof:
                decoder = zlib.decompressobj(bits)
            parts.append(decoder.decompress(chunk))
            chunk = decoder.unused_data if bits == 31 else b''
        return b''.join(parts)
    return decode


def read_object(response, limit=None):
    raw = response.read(limit)
    return object_of(decoder_of(response)(raw)) or {}


class Events:
    def __init__(self):
        self.pending = bytearray()
        self.name = None
        self.data = []
        self.usage = None
        self.after_cr = False
        self.first_line = True

    def feed(self, chunk):
        if not chunk:
            return
        if self.after_cr and chunk.startswith(b'\n'):
            chunk = chunk[1:]
        self.after_cr = chunk.endswith(b'\r')
        start = 0
        for ending in re.finditer(br'\r\n|[\r\n]', chunk):
            self.pending.extend(chunk[start:ending.start()])
            line, self.pending = self.pending, bytearray()
            start = ending.end()
            if self.first_line:
                self.first_line = False
                if line.startswith(b'\xef\xbb\xbf'):
                    del line[:3]
            field, _, value = line.partition(b':')
            if field == b'event':
                self.name = value.strip().decode(errors='replace')
            elif field == b'data':
                self.data.append(value)
            elif not line:
                event = object_of(b"\n".join(self.data)) or {}
                kind = event.get("type") or (self.name if self.data else None)
                usage = (event.get("response") or {}).get("usage")
                self.name, self.data = None, []
                if usage is not None or kind == "response.completed":
                    self.usage = usage
                if kind in ("response.completed", "response.failed", "response.incomplete", "error"):
                    return kind
        self.pending.extend(chunk[start:])


class State:
    lock = threading.Lock()
    accepted = {}  # live stint -> most recent input accepted for that stint
    convs = {}  # prompt_cache_key -> its switching state (persisted)
    routing = {}  # per-key routing locks, shared when a state moves to a new key
    judging = set()  # conversations with a judge request out
    writing = set()
    mains = {}  # prompt_cache_key -> the configured model's latest request {"body", "headers", "path", "touched", "away"}


def new_conv():
    return {"fingerprint": 2, "n": 0, "history": None, "cheap": False, "start": None, "want": None, "stints": [], "retries": {},
            "calls": 0, "judged": None, "back_calls": 0, "back_judged": None}


def save():
    if STATE_FILE:
        with replacement(STATE_FILE) as f:
            json.dump(State.convs, f)


def load_state(file):
    convs = {k: st for k, st in json.load(file).items() if st.get('fingerprint') == 2}
    for st in convs.values():
        if "history" in st:
            ranges = {(s["generation"], s["content"]): s for s in st["stints"]}
            for reservation in st["retries"].values():
                retry = reservation["spans"]
                for index, span in enumerate(retry):
                    retry[index] = ranges.setdefault((span["generation"], span["content"]), span)
    return convs


def is_continue(it):
    content = it.get("content")
    text = "".join(text_of(it).casefold().split())
    while text and unicodedata.category(text[-1]).startswith("P"):
        text = text[:-1]
    return (it.get("role") == "user" and
            (isinstance(content, str) or all(b.get("type") == "input_text" for b in content or [])) and
            text in ("continue", "continueworking", "keepgoing", "goon", "proceed"))


def instruction(it):
    return item_type(it) == "message" and it.get("role") in ("user", "developer")


def matches_prefix(st, prefix, top):
    return (st.get("history") and st["top"] == top and st["n"] <= len(prefix)
            and digest(prefix[:st["n"]]) == st["history"])


def conv_of(key, prefix, top):
    """Called under State.lock. Adopt only an unambiguous historical prefix."""
    st = State.convs.get(key)
    if st is not None and "history" not in st:
        st = State.convs[key] = new_conv()
    if st is None:
        matches = [(k, s) for k, s in State.convs.items() if matches_prefix(s, prefix, top)]
        if len(matches) == 1:
            old, st = matches[0]
            State.routing[key] = State.routing.pop(old, threading.Lock())
            del State.convs[old]
        else:
            st = new_conv()
        State.convs[key] = st
    return st


def own(headers, n):
    """Headers for the proxy's own requests: the agent's credentials only. Codex's other headers describe its own streamed
    request; on an unstreamed judge request an upstream can reject them with HTTP 400."""
    return dict({k: v for k, v in headers.items() if k.lower() in ("authorization", "api-key", "x-api-key")},
                **{"content-type": "application/json", "accept": "application/json", "accept-encoding": "identity", "content-length": str(n)})


def side(what, instructions, user, headers, path):
    """One unstreamed request to the cheap model outside the conversation (a judge or a note); its text, or None."""
    rec = {"at": round(time.time(), 3), "kind": "side", "what": what, "model": CHEAP}
    text, c = None, None
    try:
        data = json.dumps({"model": CHEAP, "store": False, "max_output_tokens": 4000, "input": [
            {"type": "message", "role": "developer", "content": [{"type": "input_text", "text": instructions}]},
            {"type": "message", "role": "user", "content": [{"type": "input_text", "text": user}]}]}).encode()
        c = upstream()
        c.request("POST", UP.path.rstrip("/") + path, body=data, headers=own(headers, len(data)))
        r = c.getresponse()
        decode, raw, out = decoder_of(r), bytearray(), None
        while out is None:
            chunk = r.read1(65536)
            if not chunk:
                out = {}
                break
            decoded = decode(chunk)
            raw.extend(decoded)
            if decoded.rstrip().endswith(b'}'):
                out = object_of(raw)
        rec["status"] = r.status
        if r.status != 200:
            rec["error_body"] = raw[:300].decode(errors="replace")
        rec["usage"] = out.get("usage")
        rec["completed"] = r.status == 200 and out.get("status") == "completed"
        if out.get("status") != "completed":
            rec["error"] = out.get("status") or "missing-status"
        if rec["completed"]:
            text = "".join(b.get("text", "") for it in out.get("output") or [] if it.get("type") == "message"
                           for b in it.get("content") or [] if isinstance(b, dict)).strip() or None
    except Exception as e:  # no answer: the return judge gives work back; a note can be retried
        rec["error"] = type(e).__name__
    finally:
        if c is not None:
            c.close()
    rec["s"] = round(time.time() - rec["at"], 1)
    log(dict(rec, **({"text": text[:2000]} if text else {})))
    return text


def judge(kind, user, headers, path, st, generation, instructions):
    """An approval applies only to the state and instructions that were judged. A failed return gives work back."""
    text = side(kind, RETURN_INSTRUCTIONS if kind == "handback" else JUDGE_INSTRUCTIONS, user, headers, path)
    yes = decision(text, kind)
    with State.lock:
        State.judging.discard((id(st), generation))
        if (st.get("generation", 0) == generation
                and st["cheap"] == (kind == "handback") and st.get("instructions") == instructions
                and (yes or kind == "handback" and yes is None)):
            st["want"] = kind
            if kind == "handoff":
                st["brief"] = reason_of(text)
                st["approved_instructions"] = instructions
            save()


def end_stint(st, end, why, prefix):
    s = st.pop("active")
    State.accepted.pop(id(s), None)
    s.update(b=end, why=why, content=digest(prefix[s["a"]:end]))
    st["stints"].append(s)
    st.update(cheap=False, start=None, want=None, brief=None, generation=st.get("generation", 0) + 1)
    return s


def retry_notes(ranges, headers, path, bounded=False):
    with State.lock:
        pending = [(s, items) for s, items, prefix in ranges if CHEAP and not s.get("note") and s["attempts"] < 3
                   and id(s) not in State.writing and matching_range(s, prefix)]
        if not pending:
            return
        for s, items in pending:
            s["attempts"] += 1
            State.writing.add(id(s))
        save()
    def write():
        for s, items in pending:
            steps = [it for it in items[s["a"]:s["b"]] if not instruction(it)]
            note = side("note", HANDBACK_NOTE_SYSTEM, transcript(steps, NOTE_CHARS), headers, path)
            with State.lock:
                s["note"] = note
                State.writing.discard(id(s))
                save()
    if bounded:
        worker = threading.Thread(target=write, daemon=True)
        worker.start()
        worker.join(0.25)
    else:
        write()


def strong_request(key, out, headers, path):
    State.mains[key] = {"body": out, "headers": headers, "path": path, "touched": time.time(), "away": None}
    return out


def log_return(req, closed):
    log({"at": round(time.time(), 3), "kind": "switch", "to": req.get("model"), "why": closed["why"],
         "stint": [closed["a"], closed["b"]], "note": bool(closed["note"])})


def retry_request(req, stints, headers, path, prefix, extra=()):
    items = req.get("input") or []
    retry_notes([(s, items, prefix) for s in stints] + list(extra), headers, path, bounded=True)
    with State.lock:
        return dict(req, input=with_guidelines(view(items, stints, prefix)))


def handback_now(binding, req, headers, path, why):
    st, identity, prior, span, request_prefix = binding
    content = digest(request_prefix[span['a']:])
    items = req["input"]
    with State.lock:
        current = st.get("active") is span
        if current:
            accepted, prefix = State.accepted[id(span)]
            end_stint(st, len(accepted), why, prefix)
            st["judged"] = st["calls"] - JUDGE_EVERY + 1
            key = next(k for k, state in State.convs.items() if state is st)
            previous_main = State.mains.get(key)
        local = span if span.get("content") == content else dict(span, content=content, b=len(items), attempts=0, note=None)
        previous = st["retries"].get(identity)
        reservation = previous["spans"] if previous and previous["spans"][-1]["generation"] == span["generation"] else prior + [local]
        keys = list(previous["keys"]) if previous else []
        if req.get("prompt_cache_key") not in keys:
            keys.append(req.get("prompt_cache_key"))
        st["retries"][identity] = {"keys": keys, "spans": reservation}
        save()
    extra = [(span, accepted, prefix)] if current and local is not span else []
    out = retry_request(req, reservation, headers, path, request_prefix, extra)
    if current:
        log_return(req, span)
        with State.lock:
            if State.convs.get(key) is st and State.mains.get(key) is previous_main and not st['cheap']:
                strong_request(key, out, headers, path)
    return out


def restore_tools(req):
    items = req.get("input") or []
    if not items or item_type(items[0]) == "additional_tools":
        return None
    existing = State.convs.get(req.get("prompt_cache_key"))
    first = mark(items[0])
    if existing:
        matches = [existing] if existing.get("after_tools") == first else []
    else:
        top = digest(req.get('instructions'))
        matches = [s for s in State.convs.values() if s.get("after_tools") == first
                   and matches_prefix(s, marks([s['tools']] + items), top)]
    if len(matches) == 1:
        return dict(req, input=[matches[0]["tools"]] + items, tool_choice="none")


def route(key, req, headers, path, compaction, binding=None):
    """The input to send for one Codex request and whether it goes to the cheap model."""
    items = req.get("input") or []
    prefix = marks(items)
    top = digest(req.get("instructions"))
    instructions = digest([top, [sig for it, sig in zip(items, prefix) if instruction(it) and not is_continue(it)]])
    identity = digest([req.get("model"), top, prefix])
    with State.lock:
        owners = [(k, s) for k, s in State.convs.items() if identity in s.get("retries", {})
                  and (key not in State.convs or key in s["retries"][identity]["keys"])]
        if len(owners) == 1 and identity not in State.convs.get(key, {}).get("retries", {}):
            owner, st = owners[0]
            routing = State.routing.setdefault(owner, threading.Lock())
        else:
            st = conv_of(key, prefix, top)
            routing = State.routing.setdefault(key, threading.Lock())
        reserved = st['retries'].get(identity)
    if reserved:
        return retry_request(req, reserved['spans'], headers, path, prefix), False
    with routing:
        if identity in st["retries"]:
            return retry_request(req, st["retries"][identity]["spans"], headers, path, prefix), False
        closed = None
        with State.lock:
            old = st["n"]
            since = old if old and len(items) >= old else len(items)
            if len(items) < old or (old and st["tail"] != mark(items[old - 1]) and not instruction(items[old - 1])):
                State.accepted.pop(id(st.pop("active", None)), None)
                st.update(stints=[], cheap=False, start=None, want=None, brief=None, generation=st.get("generation", 0) + 1)
            if st["cheap"]:
                end = next((k for k in range(max(old, st["start"]), len(items)) if instruction(items[k])), None)
                if end is None and (not CHEAP or st["want"] == "handback" or compaction or st.get("instructions") != instructions):
                    end = len(items)
                if end is not None:
                    why = ("handback" if end == len(items) and st["want"] == "handback" else "compaction" if compaction else
                           "disabled" if not CHEAP else "handback" if end == len(items) else "message")
                    closed = end_stint(st, end, why, prefix)
            elif st["want"] == "handoff":
                if not CHEAP or st.get("approved_instructions") != instructions:
                    st.update(want=None, brief=None)
                elif not compaction:
                    st.update(cheap=True, start=len(items), want=None, back_calls=0, back_judged=None,
                              active={"a": len(items), "generation": st.get("generation", 0) + 1, "attempts": 0, "note": None},
                              generation=st.get("generation", 0) + 1)
                    if key in State.mains:
                        State.mains[key]["away"] = time.time()
                    log({"at": round(time.time(), 3), "kind": "switch", "to": CHEAP, "at_item": len(items)})
            st.update(n=len(items), tail=mark(items[-1]) if items else None, history=digest(prefix) if prefix else None,
                      top=top, instructions=instructions)
            if len(items) > 1 and item_type(items[0]) == "additional_tools":
                st["tools"], st["after_tools"] = items[0], mark(items[1])
            if st["cheap"]:
                State.accepted[id(st["active"])] = items, prefix
            if compaction and closed and st["judged"] is not None:
                st["judged"] = st["calls"] - JUDGE_EVERY + 1
            save()
        retry_notes([(s, items, prefix) for s in st['stints']], headers, path)
        if closed is not None:
            log_return(req, closed)
        with State.lock:
            v = view(items, st["stints"], prefix)
            cheap = st["cheap"]
            if not compaction:
                c, j, kind = ("back_calls", "back_judged", "handback") if cheap else ("calls", "judged", "handoff")
                st[c] += max(1, sum(len(TOOL_CALL_RE.findall(str(it.get("input") or ""))) or 1 for it in items[since:]
                                    if it.get("type") in ("custom_tool_call", "function_call")))
                if closed is not None and st["judged"] is not None:
                    st["judged"] = st["calls"] - JUDGE_EVERY + 1  # look again after the strong model's next call, not JUDGE_EVERY later
                generation = st.get("generation", 0)
                ticket = (id(st), generation)
                if CHEAP and not st["want"] and ticket not in State.judging and st[c] >= JUDGE_EVERY and (st[j] is None or st[c] - st[j] >= JUDGE_EVERY):
                    st[j] = st[c]
                    State.judging.add(ticket)
                    recent = [it for it in v if it.get("type") != "reasoning" and it.get("role") != "developer"][-TRAJ_ITEMS:]
                    brief = f"STINT BRIEF:\n{st.get('brief') or '(not supplied)'}\n\n" if cheap else ""
                    user = (f"TASK GIVEN TO THE AGENT:\n{clip(task_of(items), TASK_CHARS - 1500, 1500)}\n\n{brief}"
                            f"RECENT TRAJECTORY (oldest first):\n{transcript(recent, TRAJ_CHARS) or '(no steps yet)'}\n\nDecide now.")
                    threading.Thread(target=judge, args=(kind, user, headers, path, st, generation, instructions), daemon=True).start()
                save()
            if CHEAP or st["stints"]:
                v = with_guidelines(v)
            out = (dict(req, input=with_cheap_note(v, st.get("brief"), len(v) - (len(items) - st["start"])), model=CHEAP)
                   if cheap else strong_request(key, dict(req, input=v), headers, path))
            if cheap and binding is not None:
                binding.extend((st, identity, list(st["stints"]), st["active"], prefix))
        return out, cheap


def ping_mains():
    """One keep-warm request per conversation whose configured model has waited PING_S while the cheap model works."""
    now = time.time()
    with State.lock:
        due = [(k, dict(m)) for k, m in State.mains.items()
               if PING_S > 0 and m.get("away") and now - m["touched"] >= PING_S and now - m["away"] < STOP_AFTER_S]
        for k, _ in due:
            State.mains[k]["touched"] = now
    for k, m in due:
        rec = {"at": round(now, 3), "kind": "ping", "model": m["body"].get("model")}
        try:
            data = json.dumps(responses_ping(m["body"])).encode()
            with closing(upstream()) as c:
                c.request("POST", UP.path.rstrip("/") + m["path"], body=data, headers=own(m["headers"], len(data)))
                with c.getresponse() as r:
                    rec["status"], rec["usage"] = r.status, read_object(r).get("usage")
        except Exception as e:  # a failed ping costs nothing and changes nothing; the next one may work
            rec["error"] = type(e).__name__
        rec["s"] = round(time.time() - now, 1)
        log(rec)


def pinger():
    while True:
        time.sleep(5)
        if os.getppid() != PARENT:
            os._exit(0)
        ping_mains()


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def forward(self):
        n = int(self.headers.get("content-length") or 0)
        data = self.rfile.read(n) if n else b""
        headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP and k.lower() != "accept-encoding"}
        headers["accept-encoding"] = "identity"
        path = self.path.split("?")[0]
        req, cheap, restored, binding = {}, False, False, []
        if self.command == "POST" and path.endswith("/responses"):
            body = object_of(data) or {}
            if isinstance(body.get("input"), list) and all(isinstance(it, dict) for it in body["input"]):
                with State.lock:
                    fixed = restore_tools(body)
                restored = fixed is not None
                req = fixed or body
                out, cheap = route(req.get("prompt_cache_key"), req, headers, path, restored, binding)
                data = json.dumps(out).encode()
        rec = {"at": round(time.time(), 3), "kind": "request", "path": path, "main": False}
        if req:
            rec.update(model=out.get("model"), cheap=cheap, strong_model=req.get("model"))
        if restored:
            rec["restored"] = True
        while True:
            try:
                with closing(upstream()) as conn:
                    conn.request(self.command, UP.path.rstrip("/") + self.path, body=data or None,
                                 headers=dict(headers, **({"content-length": str(len(data))} if data else {})))
                    sock = conn.sock
                    with conn.getresponse() as response:
                        status = response.status
                        if not (cheap and (status in (401, 403, 429) or 500 <= status < 600)):
                            self.relay(response, rec, binding, req, headers, path)
                            return
                        why = "http-" + str(status)
                        out = handback_now(binding, req, headers, path, why)
                        def stop_read():
                            try:
                                sock.shutdown(socket.SHUT_RD)
                            except OSError:
                                pass
                        timer = threading.Timer(0.25, stop_read)
                        timer.start()
                        try:
                            usage = read_object(response, 65536).get("usage")
                        except (OSError, http.client.HTTPException, zlib.error):
                            usage = None
                        finally:
                            timer.cancel()
            except (OSError, http.client.HTTPException) as exc:
                why, status, usage = type(exc).__name__, None, None
                if not cheap:
                    log(dict(rec, error=why))
                    self.send_error(502, "ccsave proxy: " + why)
                    return
                out = handback_now(binding, req, headers, path, why)
            log(dict(rec, status=status, usage=usage, error=why, s=round(time.time() - rec["at"], 1)))
            log({"at": rec["at"], "kind": "fallback", "model": rec["model"], "why": why})
            data, cheap = json.dumps(out).encode(), False
            rec.update(cheap=False, model=out.get("model"))

    def relay(self, response, rec, binding, req, headers, path):
        length = response.getheader("content-length")
        events = Events() if "text/event-stream" in (response.getheader("content-type") or "").lower() else None
        decoder, body = decoder_of(response), bytearray()
        bad_status = not 200 <= response.status < 300
        finalized = False
        reserved = False

        def finish_call(error, usage):
            nonlocal finalized
            if not finalized:
                finalized = True
                if bad_status:
                    error = error or "http-" + str(response.status)
                log(dict(rec, status=response.status, s=round(time.time() - rec["at"], 1),
                         **({"usage": usage, "completed": not error} if req else {}), **({"error": error} if error else {})))
                if binding and rec.get("cheap") and error and not reserved:
                    handback_now(binding, req, headers, path, error)

        try:
            if binding and rec.get('cheap') and bad_status:
                handback_now(binding, req, headers, path, 'http-' + str(response.status))
                reserved = True
            self.send_response_only(response.status, response.reason)
            for key, value in response.getheaders():
                if key.lower() not in HOP:
                    self.send_header(key, value)
            self.send_header("content-length", length) if length is not None else self.send_header("transfer-encoding", "chunked")
            if req and response.length == 0:
                finish_call("empty-response", None)
            self.end_headers()
            while True:
                chunk = response.read1(65536)
                if not chunk:
                    if response.length:
                        raise http.client.IncompleteRead(b"")
                    break
                if req and not finalized:
                    decoded = decoder(chunk)
                    if events:
                        terminal = events.feed(decoded)
                        if terminal:
                            finish_call(None if terminal == "response.completed" else terminal, events.usage)
                    else:
                        body.extend(decoded)
                        if decoded.rstrip().endswith(b"}"):
                            obj = object_of(body)
                            if obj:
                                status = obj.get("status")
                                finish_call(None if status == "completed" else status or "missing-status", obj.get("usage"))
                                body.clear()
                    if response.length == 0:
                        finish_call("incomplete-stream" if events else "missing-status", events.usage if events else None)
                self.wfile.write(chunk if length is not None else b"%x\r\n%s\r\n" % (len(chunk), chunk))
                self.wfile.flush()
            finish_call("incomplete-stream" if req else None, events.usage if events else None)
            if length is None:
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
        except (OSError, http.client.HTTPException, zlib.error) as exc:
            self.close_connection = True
            if isinstance(exc, (BrokenPipeError, ConnectionResetError)):
                rec["closed"] = True
            finish_call(type(exc).__name__, events.usage if events else None)

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = forward


if __name__ == "__main__":
    if not UP.scheme or not UP.hostname:
        sys.exit("CCSAVE_UPSTREAM is required: set the API origin, e.g. https://api.openai.com (without /v1).")
    try:
        port = UP.port
    except ValueError:
        sys.exit("CCSAVE_UPSTREAM has an invalid port.")
    if (UP.scheme not in ("http", "https") or UP.username is not None or UP.query or UP.fragment or port == 0
            or UP.netloc.endswith(":") or any(char.isspace() for char in UP.geturl())):
        sys.exit("CCSAVE_UPSTREAM must be an http(s) URL without credentials, query or fragment.")
    if LOG:
        LOG_HANDLE = open_record(LOG, 'a+b')
        try:
            with open_record(STATE_FILE, 'rb') as f:
                State.convs = load_state(f)
        except (FileNotFoundError, ValueError):
            pass
    if os.environ.get('CCSAVE_GROUP_WITNESS'):
        signal.signal(signal.SIGTERM, lambda *_: os._exit(130 if signal.SIGINT in signal.sigpending() else 0))
    threading.Thread(target=pinger, daemon=True).start()
    server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.daemon_threads = True
    if os.environ.get("CCSAVE_PORT_FILE"):
        f = os.environ["CCSAVE_PORT_FILE"]
        with replacement(f) as out:
            out.write(str(server.server_address[1]))
    server.serve_forever()
