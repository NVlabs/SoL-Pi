# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: MIT
"""Claude Code model-switching proxy.
Opus hands routine steps to Haiku and implementation steps to Sonnet.
Judges approve hand-offs and returns; formal proofs stay on Opus.
The cheap model sees the task, a brief and recent work, then its own steps.
Opus sees a hand-off note in place of each stint, with user instructions kept.
Its cache stays warm during stints; the bridge marks its previous request end.
State and request records live beside CCSAVE_LOG; request headers are never logged.
See README.md for configuration, and for the results measured on the earlier revision this code builds on.
Python 3 standard library only.
"""
import contextlib
import hashlib
import http.client
import http.server
import json
import math
import os
import re
import signal
import ssl
import stat
import sys
import tempfile
import threading
import time
import urllib.parse
import unicodedata


def default_log():
    project = os.getcwd()
    root = os.environ.get('XDG_STATE_HOME', '')
    if not os.path.isabs(root):
        root = os.path.expanduser('~/.local/state')
    directory = os.path.join(os.path.realpath(root), 'sol-pi-v2')
    records = os.path.join(directory, hashlib.sha256(os.fsencode(project)).hexdigest())
    parent = records
    while parent != '/':
        if os.path.lexists(os.path.join(parent, '.git')) or (parent == project and project != os.path.expanduser('~')):
            raise SystemExit('ccsave: choose an XDG_STATE_HOME outside the checkout')
        parent = os.path.dirname(parent)
    for path in (directory, records):
        os.makedirs(path, mode=0o700, exist_ok=True)
        info = os.lstat(path)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise SystemExit('ccsave: records directory must be private and owned by you: ' + path)
    return os.path.join(records, 'ccsave.jsonl')


def read_record(path):
    return open(path, encoding='utf-8', opener=lambda name, flags: os.open(name, flags | os.O_NOFOLLOW))


def open_append(path):
    """A private record opened for appending; refuses a symlink or a non-regular file."""
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        os.close(fd)
        raise OSError('refusing non-regular file: ' + path)
    return fd


@contextlib.contextmanager
def record_writer(path):
    if os.path.islink(path):
        raise OSError('refusing symlink: ' + path)
    with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=os.path.dirname(os.path.abspath(path)), delete=False) as out:
        try:
            yield out
            out.flush()
            os.replace(out.name, path)
        except BaseException:
            with contextlib.suppress(FileNotFoundError):
                os.unlink(out.name)
            raise


def write_json(path, data):
    if path:
        try:
            with record_writer(path) as out:
                json.dump(data, out)
        except OSError as exc:
            print('ccsave: cannot save {}: {}'.format(path, exc), file=sys.stderr)
            return False
    return True


if __name__ == '__main__' and sys.argv[1:] == ['--default-log']:
    print(default_log())
    sys.exit(0)
if __name__ == '__main__' and sys.argv[1:] == ['--launcher']:
    errors = open_append(os.environ['CCSAVE_LOG'] + '.err')
    os.dup2(errors, 2)
    os.dup2(errors, 1)

try:
    UP = urllib.parse.urlparse(os.environ.get("CCSAVE_UPSTREAM", ""))
except ValueError:
    raise SystemExit("ccsave: invalid CCSAVE_UPSTREAM URL") from None
PORT = int(os.environ.get("CCSAVE_PORT") or 0)
LOG = os.environ.get("CCSAVE_LOG", "")
PING_S = float(os.environ.get("CCSAVE_PING_S") or 270)  # 0 turns keep-warm off
PING_IDLE_CAP_S = float(os.environ.get("CCSAVE_PING_IDLE_CAP_S") or 3600)  # no pings after this long without a client request
CLIENT_FILE = os.environ.get("CCSAVE_CLIENT_PID_FILE", "")
WATCH_S = 5
PING_TEXT = "This is an automated cache keep-alive request, not part of the task. Reply with just: ok"
HOP = {"host", "content-length", "connection", "transfer-encoding", "keep-alive", "proxy-connection", "te", "trailer", "upgrade"}
PARENT = os.getppid()
def model_setting(name, filename, default=""):
    if name in os.environ:
        return os.environ[name].strip()
    try:
        with open(os.path.join(os.path.dirname(__file__), filename)) as f:
            return f.read().strip()
    except FileNotFoundError:
        return default


CHEAP = model_setting("CCSAVE_CHEAP_MODEL", "cheap-model.txt")
MID = model_setting("CCSAVE_MID_MODEL", "mid-model.txt", CHEAP)
JUDGE = model_setting("CCSAVE_JUDGE_MODEL", "judge-model.txt", CHEAP)
ENABLED = bool(CHEAP and JUDGE)
STATE_FILE = LOG + ".state" if LOG else ""
JUDGE_EVERY = int(os.environ.get("CCSAVE_JUDGE_EVERY") or 5)  # the hand-off judge (earlier revisions waited 10)
RETURN_EVERY = int(os.environ.get("CCSAVE_RETURN_EVERY") or 10)  # the return judge
TASK_CHARS, TRAJ_ITEMS, TRAJ_CHARS = 6000, 80, 40000  # task and recent-work sizes for the judge
NOTE_CHARS = 4 * 100000  # 4 characters per token over half of a 200k window
MALFORMED = {400, 404, 413, 422}
LIMITED = 429
RETRY_S = tuple(float(s) for s in os.environ.get("CCSAVE_RETRY_S", "3,10,30").split(",") if s)  # the waits before sending a rate-limited Haiku request again (a third, longer wait was added to the first two)
COMPACT_MARK = "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools."  # Claude Code 2.1.288's compaction instruction

# Judges see the task and recent work, not the full conversation.
JUDGE_INSTRUCTIONS = """You decide when a coding agent may hand its next steps to a cheaper model.

So far the agent has worked on a strong, expensive model. If you approve, a cheaper and weaker model takes over: it sees
the task, a transcript of the recent work and your reason as its instructions, and it has the same files and the same tools.
The hand-off is not final: the cheaper model's work is checked every 10 steps, and the strong model comes back as soon as it
is stuck or its results get worse. So judge the next steps, not the whole task. A step on the cheaper model costs a small
fraction of a step on the strong model; a hard step on the cheaper model loses quality, because it is worse at hard
reasoning.

Approve when the next steps carry out something already decided, and say which kind they are:
- "routine": running, repeating or checking experiments, tests or evaluations, and reading their results; trying parameter
  values or variants of a change that already works; applying an established fix to more cases, small edits, cleaning up,
  or writing the report;
- "implementation": writing or changing code to a design or plan that is already decided, fixing a failure whose cause is
  already clear, or adding tests for behaviour that is already specified.

Keep the strong model when the next step itself needs hard reasoning:
- designing or choosing an approach, or comparing approaches;
- debugging a failure whose cause is not clear, a regression or wrong results;
- a new algorithm, a refactor without a decided plan, or careful reasoning about correctness or performance;
- writing or repairing a proof or a mathematical argument;
- only waiting for a running job (a submission, an evaluation, a long run) while other parts of the task still need design
  or new code: the strong model works on those parts while the job runs.

When the task is formal proof work, proving theorems in Lean, Coq, Isabelle or another proof assistant, keep the strong model
in every phase: its builds, submissions and easy cases too.

Reply with one JSON object and nothing else ("kind" when you approve; "formal_proofs" says whether the task is formal proof work):
{"handoff": true or false, "kind": "routine" or "implementation", "formal_proofs": true or false, "phase": "<a short phrase naming the current phase>", "reason": "<one or two sentences>"}"""
RETURN_INSTRUCTIONS = """You decide when a coding agent should give its work back from a cheaper model to the strong model.

The agent started on a strong, expensive model, which handed the work to a cheaper and weaker model. If you approve, the
strong model takes the work back and continues. Keeping the cheaper model saves cost; the strong model is needed when the
cheaper model cannot make progress on its own.

Give the work back when:
- the cheaper model is stuck: the same error or failing check keeps coming back, or its recent attempts made no progress;
- its results got worse, or something broke for a reason that is not obvious;
- it starts writing or repairing a proof or a mathematical argument, which needs the strong model;
- the steps it took over are done and the next step needs a new decision;
- the next step needs hard reasoning: designing or choosing an approach, a new algorithm or component, a non-trivial
  refactor, debugging a failure whose cause is not clear, or careful reasoning about correctness or performance;
- it is only waiting for a running job while other parts of the task still need design or new code, which the strong
  model can work on meanwhile.

Otherwise keep the cheaper model, also when the work left is open-ended: while it makes progress on steps already decided,
it goes on.

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
STEPS_HEAD = "[A cheaper model carried out steps since your last turn. They follow as a transcript. Look again only at what your next decision depends on.]"
CHEAP_INTRO = ("You have taken over this session from a stronger model to carry out steps it has already decided. Carry them out "
               "and check each result. End your turn with a short report of what you did and the results as soon as those steps "
               "are done, or earlier when the next step needs a new decision: choosing or changing an approach, debugging a "
               "failure whose cause is not clear, a new algorithm, or a proof. The stronger model reads your report and decides "
               "what comes next.\n\n[The stronger model hands you the next steps: {brief}]\n\nIts recent work, oldest first (the "
               "files are on disk as it left them):\n\n{work}")


SAVED_FILE = os.environ.get("CCSAVE_SAVED_FILE", LOG + ".saved.json" if LOG else "")
# USD per million tokens: input, output, cache read, 5-minute cache write, 1-hour cache write. Two rows price prompts
# (input, cache read and cache write tokens) up to and over LONG_PROMPT tokens.
# Source: Anthropic's pricing page, https://platform.claude.com/docs/en/about-claude/pricing, read on 2026-11-23.
PRICES = {"claude-opus-5-5": [4, 20, 0.2, 5, 8],
          "claude-sonnet-5-5": [2, 10, 0.1, 2.5, 4],
          "claude-haiku-5-5": [[0.1, 0.5, 0.01, 0.125, 0.2], [0.5, 2.5, 0.05, 0.625, 1]]}
LONG_PROMPT = 100000


def price_row(v):
    return isinstance(v, list) and len(v) == 5 and all(
        isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) and x >= 0 for x in v)


try:
    PRICES.update(json.loads(os.environ.get("CCSAVE_PRICES", "{}")))
    if not all(price_row(v) or isinstance(v, list) and len(v) == 2 and all(map(price_row, v)) for v in PRICES.values()):
        raise ValueError()
except (ValueError, TypeError):
    raise SystemExit("ccsave: CCSAVE_PRICES must map model ids to five non-negative, finite token prices, "
                     "or to two such lists for prompts up to and over 100,000 tokens.")


class Saving:
    lock = threading.Lock()
    data = {"current_model": "unknown", "baseline_cost": 0.0, "cheap_cost": 0.0, "judge_note_cost": 0.0, "ping_cost": 0.0,
            "estimated_saved": 0.0, "unpriced_models": [], "unpriced_pings": 0}


def save_saving():
    write_json(SAVED_FILE, Saving.data)


def reset_saving(model):
    with Saving.lock:
        Saving.data = {"ledger_id": State.st['ledger_id'], "current_model": model, "baseline_cost": 0.0, "cheap_cost": 0.0, "judge_note_cost": 0.0,
                       "ping_cost": 0.0, "estimated_saved": 0.0, "unpriced_models": [], "unpriced_pings": 0}
        save_saving()


def set_current(model):
    with Saving.lock:
        Saving.data["current_model"] = model
        save_saving()


def cost(model, usage, ledger=None):
    prices = PRICES.get(model) or PRICES.get((model or "").rsplit("/", 1)[-1])
    if prices is None:
        missing = (Saving.data if ledger is None else ledger)["unpriced_models"]
        if model not in missing:
            missing.append(model)
        return None
    creation = usage.get("cache_creation") or {}
    hour = creation.get("ephemeral_1h_input_tokens", 0)
    counts = [usage.get("input_tokens", 0), usage.get("output_tokens", 0), usage.get("cache_read_input_tokens", 0),
              max(0, usage.get("cache_creation_input_tokens", 0) - hour), hour]
    if isinstance(prices[0], list):  # priced by prompt length: the whole request at the second row over LONG_PROMPT
        prices = prices[1] if counts[0] + sum(counts[2:]) > LONG_PROMPT else prices[0]
    return sum(n * p for n, p in zip(counts, prices)) / 1e6


def account(rec, ledger=None):
    usage = rec.get("usage")
    # A ping without usage and without an error status may still be billed: count it, and the estimate is partial.
    unknown = rec.get("kind") == "ping" and not usage and 200 <= rec.get("status", 200) < 300
    if not unknown and (not usage or not 200 <= rec.get("status", 0) < 300):
        return
    with Saving.lock:
        d = Saving.data if ledger is None else ledger
        if rec.get("kind") == "side":
            actual = cost(rec.get("model"), usage, d)
            if actual is not None:
                d["judge_note_cost"] += actual
        elif rec.get("kind") == "ping":
            actual = None if unknown else cost(rec.get("model"), usage, d)
            if actual is not None:
                d["ping_cost"] += actual
            if unknown:
                d["unpriced_pings"] += 1
        elif rec.get("kind") == "request" and rec.get("routed"):
            actual, baseline = cost(rec.get("model"), usage, d), cost(rec.get("baseline_model"), usage, d)
            if actual is not None and baseline is not None:
                d["cheap_cost"] += actual
                d["baseline_cost"] += baseline
        else:
            return
        d["estimated_saved"] = d["baseline_cost"] - d["cheap_cost"] - d["judge_note_cost"] - d["ping_cost"]
        if d is Saving.data:
            save_saving()
        else:
            rec["retired_generation_cost"] = actual


log_lock = threading.Lock()


def log(rec, token=None, ledger=None):
    if token is None:
        account(rec, ledger)
    else:
        with State.lock:
            if State.judging is token:
                account(rec)
    if LOG:
        try:
            with log_lock:
                fd = open_append(LOG)
                try:
                    os.write(fd, (json.dumps(rec) + "\n").encode())
                finally:
                    os.close(fd)
        except OSError as exc:
            print('ccsave: cannot log: ' + str(exc), file=sys.stderr)


def upstream():
    if UP.scheme == "https":
        return http.client.HTTPSConnection(UP.hostname, UP.port or 443, timeout=1800, context=ssl.create_default_context())
    return http.client.HTTPConnection(UP.hostname, UP.port or 80, timeout=1800)


def is_main(body):
    """Claude Code's own turns (tools and thinking on); its side requests (titles, summaries, token counts) are not."""
    return (isinstance(body, dict) and bool(body.get("tools")) and isinstance(body.get("thinking"), dict)
            and body["thinking"].get("type") in ("enabled", "adaptive") and isinstance(body.get("messages"), list)
            and bool(body["messages"]) and body["messages"][-1].get("role") in ("user", "system"))  # 2.1.288 ends on a system message


def ping_body(body):
    """The same request (the same cached prefix and thinking settings), unstreamed, asking for "ok" in its last message."""
    b = dict(body)
    b.pop("stream", None)
    budget = (b.get("thinking") or {}).get("budget_tokens")
    b["max_tokens"] = min(b.get("max_tokens") or 4096, budget + 512 if budget else 4096)
    last = dict(b["messages"][-1])
    content = last.get("content")
    last["content"] = ([{"type": "text", "text": content}] if isinstance(content, str) else list(content or [])) + \
        [{"type": "text", "text": PING_TEXT}]
    b["messages"] = b["messages"][:-1] + [last]
    return b


def blocks(m):
    c = m.get("content")
    return c if isinstance(c, list) else [{"type": "text", "text": c}] if isinstance(c, str) else []


def text_of(m):
    return "\n".join(b.get("text", "") for b in blocks(m) if b.get("type") == "text")


def result_text(b):
    c = b.get("content")
    return c if isinstance(c, str) else "\n".join(x.get("text", "") if x.get("type") == "text" else f"[{x.get('type')}]"
                                                   for x in c or [] if isinstance(x, dict))


def clip(t, head, tail):
    return t if len(t) <= head + tail + 40 else f"{t[:head]}\n[... {len(t) - head - tail} chars omitted ...]\n{t[-tail:]}"


def steps_of(msgs):
    """The (role, block) pairs a transcript shows: text, tool calls and results; thinking and system messages left out."""
    return [(m.get("role"), b) for m in msgs if m.get("role") in ("user", "assistant") for b in blocks(m)
            if b.get("type") in ("text", "tool_use", "tool_result")]


def transcript(steps, max_chars):
    """A labeled transcript at the first of three clip levels that fits max_chars, else its head and tail."""
    text = ""
    for rh, rt, am, at, th, tt in ((1500, 1500, 1500, 500, 3000, 1000), (600, 600, 600, 300, 1500, 500), (250, 250, 300, 150, 600, 300)):
        out, n = [], 0
        for role, b in steps:
            t = b.get("type")
            if t == "text" and role == "user":
                out.append(f"[user]\n{clip(b.get('text', ''), 6000, 2000)}")
            elif t == "text":
                out.append(f"[assistant]\n{clip(b.get('text', ''), th, tt)}")
            elif t == "tool_use":
                n += 1
                out.append(f"=== T{n} ===\n[tool call {b.get('name', '')}]\n{clip(json.dumps(b.get('input'), ensure_ascii=False), am, at)}")
            else:
                out.append(f"[tool result{' (error)' if b.get('is_error') else ''}]\n{clip(result_text(b), rh, rt)}")
        text = "\n\n".join(out)
        if len(text) <= max_chars:
            return text
    return f"{text[:int(max_chars * 0.2)]}\n[... middle of the range omitted for length ...]\n{text[-int(max_chars * 0.8):]}"


def task_of(msgs):
    """The task: the first user message's text without Claude Code's system reminders."""
    first = next((m for m in msgs if m.get("role") == "user"), {})
    parts = [b.get("text", "") for b in blocks(first) if b.get("type") == "text" and not b.get("text", "").lstrip().startswith("<system-reminder>")]
    return "\n".join(parts) or text_of(first)


def is_compaction(msgs):
    """Claude Code's compaction request: its instruction appended to the last user message."""
    for m in reversed(msgs):
        if isinstance(m, dict) and m.get("role") == "user":
            return any(b.get("type") == "text" and str(b.get("text", "")).startswith(COMPACT_MARK) for b in blocks(m))
    return False


def summary_key(text):
    return [text[:80], len(text), hashlib.sha256(text.encode()).hexdigest()]


def is_summary(message, key):
    text = task_of([message]).strip()
    if not key:
        return text.startswith("This session is being continued from a previous conversation")
    start = text.find(key[0])
    return start >= 0 and summary_key(text[start:start + key[1]]) == key


def plain(m):
    """A message as the cache compares it: its content as blocks, without cache markers. Claude Code sends its newest
    message as blocks with a marker and the same message as a string once it is older."""
    return json.dumps(dict(m, content=[{k: v for k, v in b.items() if k != "cache_control"} if isinstance(b, dict) else b
                                       for b in blocks(m)]), sort_keys=True)


def mark(m):
    return plain(m)[:4000]


def fingerprint(m):
    return hashlib.sha256(plain(m).encode()).hexdigest()


def instruction(m):
    return m.get("role") == "user" and any(b.get("type") != "tool_result" for b in blocks(m))


def stop_hook(m):
    texts = [b.get("text", "") for b in blocks(m) if b.get("type") == "text"]
    text = re.sub(r"\s+", "", " ".join(texts).lower())
    while text and unicodedata.category(text[-1]).startswith("P"):
        text = text[:-1]
    return bool(texts) and (all(t.startswith("Stop hook feedback:") for t in texts) or
                           text in ("continue", "continueworking", "keepgoing", "goon", "proceed"))


def tool_ids(msgs):
    return {b["id"] for m in msgs for b in blocks(m) if b.get("type") == "tool_use"}


def turn_keys(message):
    return ["tool:" + key for key in tool_ids([message])] or [fingerprint(message)]


def split_results(msgs, s):
    end = s["b"]
    owned, rest = [], []
    ids = tool_ids(msgs[s["a"]:end])
    while ids and end < len(msgs) and msgs[end].get('role') == 'user':
        message = msgs[end]
        content = blocks(message)
        if not any(block.get('type') == 'tool_result' for block in content):
            break
        taken, left = [], []
        for block in content:
            (taken if block.get('type') == 'tool_result' and block.get('tool_use_id') in ids else left).append(block)
        if taken:
            owned.append(dict(message, content=taken))
        if left:
            rest.append(dict(message, content=left) if taken else message)
        end += 1
    return owned, rest, end


def detach(msgs, stint):
    if "edit" not in stint:
        return msgs, []
    index = stint["a"] + stint["edit"]
    if not 0 <= index < len(msgs) or msgs[index].get("role") != "user":
        return msgs, []
    message = msgs[index]
    ids = tool_ids(msgs[stint["a"]:stint["b"]]) if index >= stint["a"] else None
    prefix, extra = [], []
    for block in blocks(message):
        original = ((ids is None or block.get("tool_use_id") in ids) if block.get("type") == "tool_result" else
                    fingerprint(dict(message, content=[block])) in stint["original"])
        (prefix if original else extra).append(block)
    return msgs[:index] + [dict(message, content=prefix)] + msgs[index+1:], [dict(message, content=extra)] if extra else []


def stint_steps(msgs, s):
    return msgs[s["a"]:s["b"]] + split_results(msgs, s)[0]


def markers(body):
    parts = [body.get("system") if isinstance(body.get("system"), list) else [], body.get("tools") or []]
    parts += [m.get("content") for m in body.get("messages") or [] if isinstance(m.get("content"), list)]
    return sum(1 for part in parts for b in part if isinstance(b, dict) and b.get("cache_control"))


def end_of(messages):
    """Where a request ends: its message count, the block of its last message that carries a cache marker (else the
    last block), and that message as the cache compares it."""
    c = blocks(messages[-1]) if messages else []
    if not c:
        return None
    marked = [i for i, b in enumerate(c) if isinstance(b, dict) and b.get("cache_control")]
    return len(messages), marked[-1] if marked else len(c) - 1, plain(messages[-1])


def bridge(body, end):
    """The request with a cache marker where the same model's previous request ended (`end`), while that message is
    still in place unchanged and the request uses fewer than Anthropic's 4 markers."""
    msgs = body.get("messages") or []
    if not end or end[0] >= len(msgs):
        return body
    k, i, was = end
    c = blocks(msgs[k - 1])
    if i >= len(c) or not isinstance(c[i], dict) or c[i].get("cache_control") or plain(msgs[k - 1]) != was:
        return body
    if markers(body) >= 4:
        return body
    c = list(c)
    c[i] = dict(c[i], cache_control={"type": "ephemeral"})
    log({"at": round(time.time(), 3), "kind": "bridge", "model": body.get("model"), "message": k - 1, "block": i})
    return dict(body, messages=msgs[:k - 1] + [dict(msgs[k - 1], content=c)] + msgs[k:])


def stint_message(msgs, s, steps, at):
    """The user message that stands for a finished stint [a, b) in Opus's requests: the system messages right before it (a
    system message may only precede an assistant turn or end the list), then the note, else the steps as a transcript. It
    carries a cache marker when one of the messages it replaces did."""
    a0 = s["a"]
    while a0 > at and msgs[a0 - 1].get("role") == "system":
        a0 -= 1
    parts = ["[System note]\n" + text_of(m) for m in msgs[a0:s["a"]]]
    parts.append(f"{NOTE_HEAD}\n\n{s['note']}" if s.get("note") else f"{STEPS_HEAD}\n\n{transcript(steps_of(steps), NOTE_CHARS)}")
    block = {"type": "text", "text": "\n\n".join(parts)}
    if any(isinstance(b, dict) and b.get("cache_control") for m in msgs[a0:s["a"]] + steps for b in blocks(m)):
        block["cache_control"] = {"type": "ephemeral"}
    return a0, {"role": "user", "content": [block]}


def view(msgs, stints):
    """Opus's messages: replace each finished stint, splitting only its boundary message."""
    out, at = [], 0
    for s in stints:
        if at <= s["a"] <= s["b"] <= len(msgs):
            clean, extra = detach(msgs, s)
            owned, rest, end = split_results(clean, s)
            if s["a"] == s["b"] and not owned and not extra:
                continue
            steps = clean[s["a"]:s["b"]] + owned
            a0, m = stint_message(clean, s, steps, at)
            out += clean[at:a0] + [m] + extra
            at = s["b"]
            if owned:
                out.extend(rest)
                at = end
    return out + msgs[at:] if out else msgs


def cheap_view(msgs, st):
    """Haiku's messages: Claude Code's first message (the task, without cache markers), the intro written when the stint began
    (the brief, the recent work, cached), then the stint's own messages."""
    first = msgs[0]
    if isinstance(first.get("content"), list):
        first = dict(first, content=[{k: v for k, v in b.items() if k != "cache_control"} if isinstance(b, dict) else b for b in first["content"]])
    return [first, {"role": "user", "content": [{"type": "text", "text": st["intro"], "cache_control": {"type": "ephemeral"}}]}] + msgs[st["start"]:]


def parse_judge(text):
    m = re.search(r"\{.*\}", text or "", re.S)
    try:
        v = json.loads(m.group(0)) if m else None
    except ValueError:
        return {}
    return v if isinstance(v, dict) else {}


def decision(text, key):
    v = parse_judge(text).get(key)
    return v if isinstance(v, bool) else None


class MessageStream:
    def __init__(self, compact):
        self.pending = b""
        self.after_cr = False
        self.data = []
        self.usage = {}
        self.summary = [] if compact else None
        self.stopped = self.failed = False

    def feed(self, chunk):
        if self.after_cr and chunk.startswith(b'\n'):
            chunk = chunk[1:]
        self.after_cr = chunk.endswith(b'\r')
        lines = (self.pending + chunk.replace(b'\r\n', b'\n').replace(b'\r', b'\n')).split(b'\n')
        self.pending = lines.pop()
        for line in lines:
            if line.startswith(b"event:") and line[6:].strip() == b"error":
                self.failed = True
            elif line.startswith(b"data:"):
                self.data.append(line[5:])
            elif not line and self.data:
                try:
                    payload = json.loads(b"\n".join(self.data))
                    event = payload["type"]
                    self.stopped = event == "message_stop"
                    self.failed |= event == "error"
                    self.usage.update((payload.get("message") or payload).get("usage") or {})
                    if self.summary is not None and event in ("content_block_start", "content_block_delta"):
                        self.summary.append((payload.get("content_block") or payload.get("delta") or {}).get("text", ""))
                except (KeyError, ValueError, TypeError, AttributeError):
                    self.failed = True
                self.data.clear()


def new_state():
    return {"ledger_id": os.urandom(16).hex(), "n": 0, "tail": None, "cheap": False, "start": None, "intro": None, "want": None, "brief": None, "stints": [],
            "calls": 0, "judged": None, "back_calls": 0, "back_judged": None, "from": None, "proofs": False, "model": None, "kind": None, "session": None, "first": None, "boundary": None, "inflight": [], "active_marks": []}


class State:
    lock = threading.RLock()
    routing = threading.Lock()  # one conversation per proxy; held across routing side calls
    request_id = generation = 0
    body = headers = path = None
    touched = 0.0  # last read of Opus's cache (request or ping)
    heard = 0.0  # the client's newest request; the proxy's own pings, judges and notes do not count
    st = new_state()  # the hand-off state of the run's conversation (persisted)
    judging = False
    ends = {}  # per model, where its newest request ended (end_of)


active = 0
draining = threading.Condition()


@contextlib.contextmanager
def active_response():
    global active
    with draining:
        active += 1
    try:
        yield
    finally:
        with draining:
            active -= 1
            draining.notify_all()


def drain():
    with draining:
        draining.wait_for(lambda: active == 0, timeout=8)


def save():
    return write_json(STATE_FILE, State.st)


def own(headers, n):
    """Headers for the proxy's own requests: the agent's credentials and API version only."""
    keep = ("authorization", "x-api-key", "api-key", "anthropic-version")
    return dict({k: v for k, v in headers.items() if k.lower() in keep},
                **{"content-type": "application/json", "accept": "application/json", "accept-encoding": "identity", "content-length": str(n)})


def side(what, instructions, user, headers, path, token=None, ledger=None):
    """One unstreamed request to the cheap model outside the conversation (a judge or a note); its text, or None."""
    rec = {"at": round(time.time(), 3), "kind": "side", "what": what, "model": JUDGE}
    text = None
    try:
        data = json.dumps({"model": JUDGE, "max_tokens": 4000, "system": instructions,
                           "messages": [{"role": "user", "content": user}]}).encode()
        for wait in RETRY_S + (None,):  # a rate-limited request is sent again
            c = upstream()
            c.request("POST", UP.path.rstrip("/") + path, body=data, headers=own(headers, len(data)))
            r = c.getresponse()
            raw = r.read()
            if r.status != LIMITED or wait is None:
                break
            rec["retries"] = rec.get("retries", 0) + 1
            time.sleep(wait)
        rec["status"] = r.status
        if r.status != 200:
            rec["error_body"] = raw[:300].decode(errors="replace")
        out = json.loads(raw)
        rec["usage"] = out.get("usage")
        text = "".join(b.get("text", "") for b in out.get("content") or [] if isinstance(b, dict) and b.get("type") == "text").strip() or None
    except Exception as e:  # callers keep Opus, give work back, or use a transcript when no note is available
        rec["error"] = type(e).__name__
    rec["s"] = round(time.time() - rec["at"], 1)
    log(dict(rec, **({"text": text[:2000]} if text else {})), token=token, ledger=ledger)
    return None if what in ("handback", "extend") and rec.get("status") != 200 else text


def judge_input(steps, msgs, note=""):
    return (f"TASK GIVEN TO THE AGENT:\n{clip(task_of(msgs), TASK_CHARS - 1500, 1500)}\n\n"
            f"RECENT TRAJECTORY (oldest first{note}):\n{transcript(steps[-TRAJ_ITEMS:], TRAJ_CHARS) or '(no steps yet)'}\n\nDecide now.")


@active_response()
def judge(kind, user, headers, path, token):
    """Ask the judge in the background; an approval switches at the conversation's next request."""
    text = side(kind, RETURN_INSTRUCTIONS if kind == "handback" else JUDGE_INSTRUCTIONS, user, headers, path, token)
    yes = decision(text, kind)
    if kind == "handback" and yes is None:
        yes = True  # a failed return judge gives the work back at the next request
    with State.lock:
        if State.judging is not token:
            return
        State.judging = False
        st = State.st
        if kind == "handoff" and decision(text, "formal_proofs"):
            st["proofs"] = True  # a formal-proof task stays on Opus
        if kind == "handoff" and parse_judge(text).get("kind") == "implementation" and not MID:
            yes = False
        if yes and st["cheap"] == (kind == "handback") and not (kind == "handoff" and st["proofs"]):
            st["want"] = kind
            if kind == "handoff":
                answer = parse_judge(text)
                st["brief"] = str(answer.get("reason") or "").strip()[:1000] or None
                st["kind"] = answer.get("kind")
            save()


def end_stint(st, msgs, end, why, **boundary):
    """Close the running stint at message `end` (state lock held); returns its record, whose note is still to be written."""
    s = dict(a=st["start"], b=end, note=None, why=why, **boundary)
    remember(s, msgs)
    st["stints"].append(s)
    if State.st is st:
        State.judging = False
    st.update(cheap=False, start=None, intro=None, want=None, brief=None, model=None, kind=None, inflight=[], active_marks=[], active_ids=[], **{"from": None})
    return s


def turn_end(msgs, st):
    """The running stint's first message, after the turn ends already judged, that is not a tool result: the cheap
    model ended its turn (Claude Code's stop hook answers, or the user writes)."""
    return next((k for k in range(st["from"] or st["start"], len(msgs)) if instruction(msgs[k])), None)


def write_note(s, msgs, headers, path, model, ledger=None):
    clean, _ = detach(msgs, s)
    s["note"] = side("note", HANDBACK_NOTE_SYSTEM, transcript(steps_of(stint_steps(clean, s)), NOTE_CHARS), headers, path, ledger=ledger)
    log({"at": round(time.time(), 3), "kind": "switch", "to": model, "why": s["why"], "stint": [s["a"], s["b"]], "note": bool(s["note"])})
    with State.lock:
        if any(record is s for record in State.st["stints"]):
            save()


def remember(s, msgs):
    start, end = s["a"], s["b"]
    clean, _ = detach(msgs, s)
    span = clean[start:end]
    s.update(marks=[fingerprint(m) for m in span], ids=sorted(tool_ids(span)),
             anchor=fingerprint(msgs[start - 1]) if start else None)
    owned = split_results(clean, s)[0]
    if owned:
        s["result_mark"] = fingerprint(owned[0])


def reconcile(st, msgs):
    """Recover only ranges for which this conversation actually sent cheap requests."""
    ranges = list(st["stints"])
    if st["cheap"]:
        ranges.append(dict(a=st["start"], b=st["n"], marks=st["active_marks"], ids=st.get("active_ids", []), anchor=st.get("anchor"), active=True))
    now = [fingerprint(m) for m in msgs] if ranges else []
    kept, covered, uncertain = [], set(), set()
    for stint in ranges:
        marks = stint.get("marks", [])
        start = stint["a"]
        anchor = stint.get("anchor")
        if not (marks or anchor or stint.get('ids')):
            continue
        if anchor and now[start-1:start] != [anchor] and now.count(anchor) == 1:
            start = now.index(anchor) + 1
        def matches(index):
            candidate = dict(stint, a=index, b=index+len(marks))
            sample = now[index:candidate["b"]]
            if "edit" in stint:
                clean, _ = detach(msgs, candidate)
                sample = [fingerprint(m) for m in clean[index:candidate["b"]]]
            if sample != marks:
                return False
            if "result_mark" in stint:
                owned = split_results(msgs, candidate)[0]
                return owned and fingerprint(owned[0]) == stint["result_mark"]
            return True
        exact = None
        if marks:
            exact = start if matches(start) else next((i for i, h in enumerate(now) if h == marks[0] and matches(i)), None)
        if exact is not None:
            start = exact
        end = start + stint["b"] - stint["a"]
        if exact is not None:
            kept.append(dict(stint, a=start, b=end, note=stint.get("note") or "History changed; unfinished model steps omitted. Check the working files and results."))
            kept[-1].pop("active", None)
            covered.update(range(start, end))
        else:
            ids = set(stint.get("ids", ()))
            end = next((i for i in range(start, min(end, len(msgs))) if instruction(msgs[i]) and now[i] not in marks), end)
            uncertain.update(i for i, m in enumerate(msgs) if m.get("role") == "assistant" and
                             (start <= i < end or ids.intersection(tool_ids([m]))))
        if stint.get("active") and end < len(msgs) and msgs[end].get("role") == "assistant":
            uncertain.add(end)
    strong = st.get("strong", {})
    uncertain = {i for i in uncertain - covered if not any(key in strong for key in turn_keys(msgs[i]))}
    for index in sorted(uncertain):
        omission = dict(a=index, b=index+1, why="history-mismatch",
                        note="History changed; uncertain model steps omitted. Check the working files and results.")
        remember(omission, msgs)
        kept.append(omission)
    log({"at": round(time.time(), 3), "kind": "history-mismatch", "kept": len(kept) - len(uncertain), "omitted": len(uncertain)})
    identity = {k: st[k] for k in ("proofs", "session", "first", "ledger_id")}
    st.clear()
    st.update(new_state(), **identity, stints=sorted(kept, key=lambda r: r["a"]))
    if strong:
        st["strong"] = strong
    State.judging = False
    new_generation()


def new_generation():
    State.generation += 1
    with Saving.lock:
        Saving.data = dict(Saving.data, unpriced_models=list(Saving.data["unpriced_models"]))


def conversation_of(body):
    metadata = body.get("metadata") or {}
    user = metadata.get("user_id") or {}
    if isinstance(user, str):
        try:
            user = json.loads(user)
        except ValueError:
            user = {}
    session = metadata.get("session_id") or (user.get("session_id") if isinstance(user, dict) else None)
    return hashlib.sha256(str(session).encode()).hexdigest() if session else None


def appended_to(msgs, previous):
    if previous and previous[0] < len(msgs) and isinstance(msgs[previous[0]], dict):
        index, size, digest = previous[:3]
        message = msgs[index]
        content = blocks(message)
        prefix, extra, cut = content[:size], content[size:], size
        for pos, length in previous[3] if len(previous) > 3 else ():
            if pos < len(prefix) and prefix[pos].get('type') == 'text' and len(prefix[pos]['text']) > length:
                text = prefix[pos]['text']
                prefix[pos] = dict(prefix[pos], text=text[:length])
                extra = [dict(prefix[pos], text=text[length:])] + extra
                cut = min(cut, pos)
        addition = dict(message, content=extra)
        if instruction(addition) and not stop_hook(addition) and fingerprint(dict(message, content=prefix)) == digest:
            return index, cut
    return None


def route(body, headers, path, compaction=False, appended=None):
    """The handler holds State.routing throughout this decision and its side calls."""
    msgs = body["messages"]
    with State.lock:
        st = State.st
        task = [b for b in blocks(msgs[0]) if b.get("type") != "text" or not b.get("text", "").lstrip().startswith("<system-reminder>")]
        session, first = conversation_of(body), fingerprint(dict(msgs[0], content=task) if task else msgs[0])
        different = st["first"] and st["first"] != first and st["first"] != fingerprint(msgs[0])
        summary = different and is_summary(msgs[0], st.get("summary"))
        changed = (session != st["session"] if session and st["session"] else
                   different and not summary and not (appended and appended[0] == 0))
        if changed:
            State.st = st = new_state()
            reset_saving(body.get("model", "unknown"))
            State.judging = False
            State.ends.clear()
            State.body = State.headers = State.path = None
            appended = None
        elif summary:
            proofs, previous_session, ledger_id = st["proofs"], st["session"], st['ledger_id']
            st.clear()
            st.update(new_state(), proofs=proofs, session=previous_session, ledger_id=ledger_id)
            State.judging = False
            new_generation()
        st["session"], st["first"] = session or st["session"], first
        mismatch = (len(msgs) < st['n'] or mark(msgs[st['n'] - 1]) != st['tail']) if st['n'] else bool(st['stints'] or st['cheap'])
        if mismatch and appended is None:
            reconcile(st, msgs)
        else:
            for stint in st["stints"]:
                if "anchor" not in stint:
                    stint.pop("parts", None)
                    remember(stint, msgs)
        last_user = next((i for i in reversed(range(len(msgs))) if msgs[i].get("role") == "user"), None)
        if compaction and st["cheap"] and not appended and any(m.get("role") == "assistant" for m in msgs[last_user+1:]):
            appended = last_user, 0
        if last_user is not None:
            content = blocks(msgs[last_user])
            st['boundary'] = [last_user, len(content), fingerprint(msgs[last_user]),
                              [(pos, len(b['text'])) for pos, b in enumerate(content) if b.get('type') == 'text']]
        else:
            st['boundary'] = None
        if any(instruction(m) and not stop_hook(m) for m in msgs[st["n"]:]) or compaction or appended:
            if st["want"] == "handoff":
                st["want"], st["brief"], st["kind"] = None, None, None
            State.judging = False
        if not st["cheap"] and (st["want"] == "handoff" or st["stints"] or "strong" in st):
            new = msgs[st["n"]:] if st["n"] and "strong" in st else view(msgs, st["stints"])
            st.setdefault("strong", {}).update((key, True) for m in new if m.get("role") == "assistant" for key in turn_keys(m))
        end = turn_end(msgs, st) if ENABLED and st["cheap"] and st["want"] != "handback" and not compaction and not appended else None
        if end is not None and not stop_hook(msgs[end]):
            end = None
        user = judge_input(steps_of(msgs[st["start"]:end + 1]), msgs, "; the cheaper model has just ended its turn") if end is not None else None
    if end is not None:
        keep = decision(side("extend", RETURN_INSTRUCTIONS, user, headers, path), "handback") is False
        with State.lock:
            if keep and st["cheap"]:
                st["from"] = end + 1
                log({"at": round(time.time(), 3), "kind": "extend", "at_msg": end})
    closed = None
    with State.lock:
        since = st["n"] or len(msgs)
        if st["cheap"]:
            end = turn_end(msgs, st)
            if appended:
                index, size = appended
                original = [fingerprint(dict(msgs[index], content=[block])) for block in blocks(msgs[index])[:size] if block.get("type") != "tool_result"]
                end = next((i for i in range(max(index+1, st["n"]), len(msgs)) if instruction(msgs[i])), len(msgs))
                while end > st["start"] and msgs[end-1].get("role") == "system":
                    end -= 1
                closed = end_stint(st, msgs, end, "compaction" if compaction else "message", edit=index-st["start"], original=original)
            elif end is not None:
                closed = end_stint(st, msgs, end, "compaction" if compaction else "message")
            elif st["want"] == "handback" or compaction or not ENABLED:
                closed = end_stint(st, msgs, len(msgs), "disabled" if not ENABLED else "compaction" if compaction else "handback")
        elif ENABLED and st["want"] == "handoff" and not compaction:
            v = view(msgs, st["stints"])
            work = transcript(steps_of(v)[-TRAJ_ITEMS:], TRAJ_CHARS)
            new_generation()
            st["anchor"] = fingerprint(msgs[-1])
            st.update(cheap=True, start=len(msgs), want=None, back_calls=0, back_judged=None, active_ids=[], **{"from": None},
                      model=MID if st["kind"] == "implementation" else CHEAP,
                      intro=CHEAP_INTRO.format(brief=st["brief"] or "carry on with the steps already decided", work=work or "(none)"))
            log({"at": round(time.time(), 3), "kind": "switch", "to": st["model"], "at_msg": len(msgs)})
        st["n"], st["tail"] = len(msgs), mark(msgs[-1])
        if st["cheap"]:
            added = msgs[st["start"] + len(st["active_marks"]):]
            st["active_marks"].extend(fingerprint(m) for m in added)
            st.setdefault("active_ids", []).extend(sorted(tool_ids(added)))
        save()
        if not ENABLED:
            return body, False
    if closed is not None:
        write_note(closed, msgs, headers, path, body.get("model"))
    with State.lock:
        cheap = st["cheap"]
        v = view(msgs, st["stints"])
        if not compaction:
            c, j, kind = ("back_calls", "back_judged", "handback") if cheap else ("calls", "judged", "handoff")
            every = RETURN_EVERY if cheap else JUDGE_EVERY
            st[c] += max(1, sum(1 for m in msgs[since:] if m.get("role") == "assistant" for b in blocks(m) if b.get("type") == "tool_use"))
            if closed is not None and st["judged"] is not None:
                st["judged"] = st["calls"] - JUDGE_EVERY + 1
            if (not st["want"] and not State.judging and not (st["proofs"] and not cheap) and st[c] >= every
                    and (st[j] is None or st[c] - st[j] >= every)):
                st[j] = st[c]
                State.judging = token = object()
                user = judge_input(steps_of(msgs[st["start"]:] if cheap else v), msgs)
                threading.Thread(target=judge, args=(kind, user, headers, path, token), daemon=True).start()
            save()
        if cheap:
            out = dict(body, model=st["model"] or CHEAP, messages=cheap_view(msgs, st))
            if markers(out) > 4:
                out["messages"][1] = {"role": "user", "content": [{"type": "text", "text": st["intro"]}]}
            return out, True
        return dict(body, messages=v), False


def handback_now(body, headers, path, why, st, owner, ledger):
    """The upstream API rejected a cheap request: close its stint and send the request to Opus."""
    msgs = body["messages"]
    with State.lock:
        closed = end_stint(st, msgs, len(msgs), why)
        if st is State.st:
            save()
    write_note(closed, msgs, headers, path, body.get("model"), ledger=None if owner is State.st else ledger)
    return dict(body, messages=view(msgs, st["stints"]))


def client_alive():
    if os.getppid() != PARENT:
        return False
    if CLIENT_FILE:
        try:
            with open(CLIENT_FILE) as f:
                pid = int(f.read())
            os.kill(pid, 0)
        except FileNotFoundError:
            return True  # launcher has not started Claude Code yet
        except (ProcessLookupError, ValueError):
            return False
        except PermissionError:
            return True
    return True


def watch_client():
    while True:
        time.sleep(WATCH_S)
        if not client_alive():
            if os.getppid() == PARENT:
                drain()
            os._exit(0)


def pinger():
    while True:
        time.sleep(WATCH_S)
        with State.lock:
            now = time.time()
            due = (PING_S > 0 and State.body is not None and now - State.touched >= PING_S
                   and now - State.heard < PING_IDLE_CAP_S)
            if due:
                body, headers, path, State.touched, ledger = State.body, State.headers, State.path, now, Saving.data
        if not due:
            continue
        rec = {"at": round(now, 3), "kind": "ping"}
        try:
            data = json.dumps(ping_body(body)).encode()
            if not client_alive():
                continue
            c = upstream()
            c.request("POST", UP.path.rstrip("/") + path, body=data,
                      headers=dict(headers, **{"content-length": str(len(data)), "accept-encoding": "identity"}))
            r = c.getresponse()
            raw = r.read()
            rec["status"] = r.status
            try:
                out = json.loads(raw)
                rec["usage"], rec["model"] = out.get("usage"), out.get("model") or body.get("model")
            except ValueError:
                pass
        except Exception as e:  # its cost is unknown (a partial estimate); nothing else changes and the next one may work
            rec["error"] = type(e).__name__
        rec["s"] = round(time.time() - now, 1)
        log(rec, ledger=None if ledger.get("ledger_id") == Saving.data.get("ledger_id") else ledger)  # charged to its conversation


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def opus_sent(self, out, headers):
        """Opus's request as sent (the bridge applied): kept for the pings and the next bridge."""
        with State.lock:
            if ENABLED:
                out = bridge(out, State.ends.get("opus"))
            State.ends["opus"] = end_of(out.get("messages") or [])
            State.body, State.headers, State.path, State.touched = out, headers, self.path, time.time()
        return out

    def entity(self):
        encoding = ','.join(self.headers.get_all('transfer-encoding', [])).lower()
        lengths = self.headers.get_all('content-length', [])
        if not encoding:
            if lengths and (len(lengths) != 1 or not re.fullmatch(r'[0-9]+', lengths[0])):
                raise ValueError()
            size = int(lengths[0]) if lengths else 0
            data = self.rfile.read(size)
            if len(data) != size:
                raise ValueError()
            return data
        if encoding != 'chunked' or lengths:
            raise ValueError()

        def line():
            raw = self.rfile.readline(65537)
            if len(raw) > 65536 or not raw.endswith(b'\r\n'):
                raise ValueError()
            return raw[:-2]

        data = bytearray()
        while True:
            digits = line().partition(b';')[0]
            if not re.fullmatch(b'[0-9a-fA-F]+', digits):
                raise ValueError()
            size = int(digits, 16)
            if not size:
                while line():
                    pass
                return bytes(data)
            chunk = self.rfile.read(size)
            if len(chunk) != size or self.rfile.read(2) != b'\r\n':
                raise ValueError()
            data.extend(chunk)

    @active_response()
    def forward(self):
        State.heard = time.time()  # any client request keeps keep-warm going for PING_IDLE_CAP_S
        try:
            data = self.entity()
        except (ValueError, OverflowError):
            self.close_connection = True
            self.send_error(400, 'Invalid request framing')
            return
        headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP and k.lower() != 'accept-encoding'}
        headers['accept-encoding'] = 'identity'
        main, cheap, body = False, False, {}
        state = request_id = generation = ledger = None
        compact = False
        if self.command == "POST" and self.path.split("?")[0].endswith("/messages"):
            try:
                parsed = json.loads(data)
                body = parsed if isinstance(parsed, dict) else {}
            except ValueError:
                pass
        msgs = body.get("messages")
        main = is_main(body)
        disabled_history = not ENABLED and isinstance(msgs, list) and msgs and (State.st['cheap'] or conversation_of(body))
        if main or disabled_history or (isinstance(msgs, list) and any(is_compaction([m]) for m in reversed(msgs))):
            with State.routing:
                edit = appended_to(msgs, State.st["boundary"])
                compact = is_compaction(msgs)
                if edit and not compact:
                    index, size = edit
                    compact = is_compaction([dict(msgs[index], content=blocks(msgs[index])[size:])])
                main = compact or main
                if main or disabled_history:
                    out, cheap = route(body, headers, self.path, compact, edit)
                    with State.lock:
                        state = State.st
                        State.request_id += 1
                        request_id = State.request_id
                        if cheap:
                            generation, ledger = State.generation, Saving.data
                            state["inflight"].append(request_id)
                            snapshot = dict(state, stints=list(state["stints"]))
                            if not save():
                                end_stint(state, msgs, len(msgs), 'inflight-not-saved')
                                save()
                                log({'kind': 'persistence-error', 'reason': 'inflight-not-saved', 'fallback': body.get('model')})
                                cheap, out = False, dict(body, messages=view(msgs, state['stints']))
                    set_current(out.get("model", "unknown"))
                    if main and not cheap:
                        out = self.opus_sent(out, headers)
                    if ENABLED:
                        data = json.dumps(out).encode()
        t = time.time()
        try:
            r = self.send_upstream(data, headers, cheap)
            for wait in RETRY_S if cheap else ():  # a rate-limited Haiku request is sent again before the stint ends
                if r.status != LIMITED:
                    break
                r.close()
                time.sleep(wait)
                r = self.send_upstream(data, headers, cheap)
            if cheap and (r.status in MALFORMED or r.status in (401, 403, LIMITED) or r.status >= 500):
                why = "rate-limited" if r.status == LIMITED else "rejected"
                with State.routing:
                    current = state is State.st and generation == State.generation and state["cheap"] and request_id == State.request_id
                    self.finish_cheap(state, request_id, False)
                    out = handback_now(body, headers, self.path, why, state if current else snapshot, state, ledger)
                    if current:
                        out = self.opus_sent(out, headers)
                        set_current(out.get("model", "unknown"))
                    cheap = False
                try:
                    diagnostic = r.read1(300).decode(errors="replace")
                except (OSError, http.client.HTTPException) as exc:
                    diagnostic = type(exc).__name__
                r.close()
                log({"at": round(t, 3), "kind": "cheap-" + why, "status": r.status, "complete": False, "reason": why, "error": diagnostic})
                data = json.dumps(out).encode()
                r = self.send_upstream(data, headers)
        except Exception as e:
            self.finish_cheap(state, request_id, False)
            self.send_error(502, "ccsave proxy: " + type(e).__name__)
            log({"at": round(t, 3), "kind": "request", "main": main, "status": 502, "complete": False, "reason": type(e).__name__, "error": type(e).__name__})
            return
        seen, error = [], None
        streamed = (isinstance(body, dict) and body.get("stream") is True) or "event-stream" in (r.getheader("content-type") or "")
        stream = MessageStream(compact) if streamed else None
        length = r.getheader("content-length")
        received = 0
        try:
            self.send_response_only(r.status, r.reason)
            for k, v in r.getheaders():
                if k.lower() not in HOP:
                    self.send_header(k, v)
            self.send_header("content-length", length) if length is not None else self.send_header("transfer-encoding", "chunked")
            self.end_headers()
            while True:
                chunk = r.read1(65536)
                if not chunk:
                    break
                received += len(chunk)
                if stream:
                    stream.feed(chunk)
                    if stream.failed:
                        self.finish_cheap(state, request_id, False)
                elif self.path.split("?")[0].endswith("/messages"):
                    seen.append(chunk)
                self.wfile.write(chunk if length is not None else b"%x\r\n%s\r\n" % (len(chunk), chunk))
                self.wfile.flush()
            if length is not None and received != int(length):
                error = "short-body"
                self.close_connection = True
            if length is None:
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
        except (OSError, http.client.HTTPException) as e:
            error = type(e).__name__
            self.close_connection = True
        reason = error or ("http-error" if not 200 <= r.status < 300 else
                           "stream-error" if stream and stream.failed else
                           "missing-message-stop" if stream and (not stream.stopped or stream.data or stream.pending.strip()) else "ok")
        complete = reason == "ok"
        try:
            reply = json.loads(b"".join(seen)) if seen else {}
            usage = stream.usage if stream else reply.get("usage")
        except (ValueError, AttributeError):
            reply, usage = {}, None
        if compact and complete:
            text = ("".join(stream.summary) if stream else text_of(reply)).strip()
            with State.lock:
                if text and state is State.st and request_id == State.request_id:
                    state["summary"] = summary_key(text)
                    save()
        self.finish_cheap(state, request_id, complete)
        log({"at": round(t, 3), "kind": "request", "path": self.path.split("?")[0], "main": main, "routed": cheap, "baseline_model": body.get("model"),
             "status": r.status, "complete": complete, "reason": reason, "s": round(time.time() - t, 1), **({"error": error} if error else {}),
             **({"model": out.get("model") if cheap else body.get("model"), "usage": usage or None} if stream or seen else {})}, ledger=ledger)

    def finish_cheap(self, state, request_id, complete):
        with State.lock:
            if request_id is not None and state is State.st and request_id in state["inflight"]:
                state["inflight"].remove(request_id)
                if not complete and state["cheap"]:
                    state["want"] = "handback"
                    State.judging = False
                save()

    def send_upstream(self, data, headers, cheap=False):
        c = upstream()
        c.request(self.command, UP.path.rstrip("/") + self.path, body=data or None,
                  headers=dict(headers, **({"content-length": str(len(data))} if data else {})))
        sock = c.sock
        response = c.getresponse()
        if cheap and (response.status in MALFORMED or response.status in (401, 403, LIMITED) or response.status >= 500):
            sock.settimeout(1)
        return response

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = forward


if __name__ == "__main__":
    os.umask(0o077)
    try:
        valid_port = UP.port != 0 and not UP.netloc.endswith(":")
    except ValueError:
        valid_port = False
    if (not valid_port or UP.scheme not in ("http", "https") or not UP.hostname or UP.username is not None or
            UP.query or UP.fragment or any(c.isspace() for c in UP.geturl())):
        raise SystemExit("ccsave: CCSAVE_UPSTREAM is required; set an http(s) API base URL without credentials.")
    if not LOG:
        LOG = default_log()
        STATE_FILE, SAVED_FILE = LOG + '.state', SAVED_FILE or LOG + '.saved.json'
    if STATE_FILE and os.path.exists(STATE_FILE):  # a restarted proxy: the stints and counts so far
        try:
            with read_record(STATE_FILE) as f:
                State.st = dict(new_state(), **json.load(f))
            State.st.pop("conversation", None)
            history = State.st.pop("history", [])
            if State.st["cheap"]:
                State.st["active_marks"] = State.st["active_marks"] or history[State.st["start"]:]
            if isinstance(State.st["inflight"], bool):
                State.st["inflight"] = [0] if State.st["inflight"] else []
            if State.st["want"] == "handoff":
                State.st["want"] = None
            if State.st["cheap"] and State.st["inflight"]:
                State.st["want"] = "handback"
        except (OSError, ValueError):
            pass
    Saving.data['ledger_id'] = State.st['ledger_id']
    if SAVED_FILE and os.path.exists(SAVED_FILE):
        try:
            with read_record(SAVED_FILE) as f:
                saved = json.load(f)
            if isinstance(saved, dict) and saved.get('ledger_id') == State.st['ledger_id']:
                Saving.data.update(saved)
        except (OSError, ValueError):
            pass
    threading.Thread(target=watch_client, daemon=True).start()
    threading.Thread(target=pinger, daemon=True).start()
    server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.daemon_threads = True
    signal.signal(signal.SIGUSR1, lambda *_: sys.exit(0))
    if os.environ.get("CCSAVE_PORT_FILE"):
        f = os.environ["CCSAVE_PORT_FILE"]
        with record_writer(f) as out:
            out.write(str(server.server_address[1]))
    try:
        server.serve_forever()
    finally:
        server.server_close()
        drain()
