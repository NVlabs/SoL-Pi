# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: MIT
"""Offline proxy regressions against a local mock Messages API and a stub Claude Code.
Tests cover routing, notes, cache markers, conversation state, failures, launcher lifetime and savings.
Run: python3 test_ccsave.py"""
import copy
import concurrent.futures
import gzip
import itertools
import signal
import socket
import struct
import http.client
import http.server
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch
TEST_ENV = {key: value for key, value in os.environ.items() if not key.startswith("CCSAVE_")}
with patch.dict(os.environ, TEST_ENV, clear=True):
    import ccsave as proxy

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from ccsave import CHEAP, JUDGE, MID, NOTE_HEAD, STEPS_HEAD, decision, steps_of, task_of, transcript, view  # noqa: E402

OPUS = "claude-opus-5-5"
SEEN = []
IDS = itertools.count()
NOTE = "Done: ran the tests, 3 passed."


def sysmsg(t, mark=False):
    b = {"type": "text", "text": t}
    if mark:
        b["cache_control"] = {"type": "ephemeral"}
    return {"role": "system", "content": [b]}


FIRST = {"role": "user", "content": [{"type": "text", "text": "<system-reminder>env</system-reminder>"},
                                     {"type": "text", "text": "Make the tests pass."}]}
START = [FIRST, sysmsg("## Bash command sandbox")]


def step(i, out="ok"):
    return [{"role": "assistant", "content": [{"type": "thinking", "thinking": f"think {i}", "signature": f"s{i}"},
                                              {"type": "tool_use", "id": f"t{i}", "name": "Bash", "input": {"command": f"step {i}"}}]},
            {"role": "user", "content": [{"type": "tool_result", "tool_use_id": f"t{i}", "content": f"{out} {i}"}]},
            sysmsg(f"<total_tokens>{i}</total_tokens>")]


def with_last_marker(msgs):
    """As Claude Code sends them: its newest message as blocks with a cache marker, older system messages as strings."""
    older = [dict(m, content=m["content"][0]["text"]) if m["role"] == "system" else m for m in msgs[:-1]]
    return older + [dict(msgs[-1], content=[dict(b, cache_control={"type": "ephemeral"}) for b in msgs[-1]["content"]])]


def bare(msgs):
    """Messages as blocks without cache markers: the proxy may add one where Opus's previous request ended (the bridge)."""
    return [dict(m, content=[{k: v for k, v in b.items() if k != "cache_control"} for b in m["content"]]) if isinstance(m.get("content"), list)
            else dict(m, content=[{"type": "text", "text": m["content"]}]) for m in msgs]


class Gateway(http.server.BaseHTTPRequestHandler):
    """Streams the agent's requests; answers judges and note requests; rejects the cheap model when told to."""
    protocol_version = "HTTP/1.1"
    approve = True
    reject_cheap = False
    proofs = False  # what the hand-off judge says about formal proof work
    back_at_end = True  # the return judge's answer when the cheap model has just ended its turn
    fail_return = None
    waiting = False
    on_request = None
    stream_failure = None
    after_stream = None
    kind = "routine"  # the kind of steps the hand-off judge names

    def log_message(self, *a):
        pass

    def handle(self):
        try:
            super().handle()
        except (OSError, http.client.HTTPException):
            pass  # interrupted-stream and killed-proxy cases deliberately break sockets

    def reply(self, status, obj, ctype="application/json"):
        out = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    limit_once = 0  # rate-limit this many requests to the cheap model, then answer

    def do_POST(self):
        Gateway.raw = self.rfile.read(int(self.headers["content-length"]))
        body = json.loads(Gateway.raw)
        SEEN.append(body)
        if Gateway.respond and Gateway.respond(self, body):
            return
        if Gateway.on_request:
            Gateway.on_request(body)
        if Gateway.limit_once and body.get("model") in (CHEAP, JUDGE):  # the judge is its own model
            Gateway.limit_once -= 1
            return self.reply(429, {"error": {"message": "rate limit"}})
        if body.get("stream"):
            if Gateway.reject_cheap and body.get("model") == CHEAP:
                return self.reply(Gateway.reject_cheap, {"error": {"message": "prompt is too long" if Gateway.reject_cheap == 400 else "rate limit"}})
            events = [{"type": "message_start", "message": {"usage": {"input_tokens": 100, "cache_read_input_tokens": 10}}},
                      {"type": "message_delta", "usage": {"output_tokens": 5}}, {"type": "message_stop"}]
            failure = Gateway.stream_failure if body.get("model") == CHEAP else None
            if failure:
                events = events[:-1]
                if failure == "error":
                    events += [{"type": "error", "error": {"type": "overloaded_error", "message": "overloaded"}}, {"type": "message_stop"}]
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.send_header("transfer-encoding", "chunked")
            self.end_headers()
            for e in events:
                part = b"event: x\ndata: " + json.dumps(e).encode() + b"\n\n"
                self.wfile.write(b"%x\r\n%s\r\n" % (len(part), part))
            self.wfile.flush()
            if Gateway.after_stream:
                Gateway.after_stream(body)
            if failure == "reset":
                self.close_connection = True
                self.connection.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
                self.connection.close()
                return
            self.wfile.write(b"0\r\n\r\n")
            return
        ask = body.get("system") if isinstance(body.get("system"), str) else ""
        if ask.startswith("You decide when a coding agent should give") and Gateway.fail_return:
            if Gateway.fail_return == "malformed":
                return self.reply(200, {"content": [{"type": "text", "text": "undecided"}]})
            return self.reply(503, {"error": {"message": "offline failure"}})
        at_end = "has just ended its turn" in json.dumps(body.get("messages"))
        text = (json.dumps({"handoff": Gateway.approve, "kind": Gateway.kind, "formal_proofs": Gateway.proofs, "reason": "run the remaining tests"}) if ask.startswith("You decide when a coding agent may hand") else
                json.dumps({"handback": Gateway.back_at_end if at_end else Gateway.approve}) if ask.startswith("You decide when a coding agent should give") else
                NOTE if ask.startswith("You write a hand-off note") else "ok")
        if Gateway.waiting:
            if ask.startswith("You decide when a coding agent may hand"):
                text = json.dumps({"handoff": "only waiting for a running job" not in ask})
            elif ask.startswith("You decide when a coding agent should give"):
                text = json.dumps({"handback": "only waiting for a running job" in ask})
        self.reply(200, {"content": [{"type": "text", "text": text}], "usage": {"input_tokens": 50, "output_tokens": 7}, "model": body.get("model")})


def rules_ok(body):
    msgs = body["messages"]
    for k, m in enumerate(msgs):
        if m.get("role") == "system" and k + 1 < len(msgs) and msgs[k + 1].get("role") != "assistant":
            return f"system message {k} is followed by {msgs[k + 1].get('role')}"
    calls = set()
    for m in msgs:
        for b in proxy.blocks(m):
            if b.get("type") == "tool_use":
                calls.add(b["id"])
            elif b.get("type") == "tool_result" and b["tool_use_id"] not in calls:
                return "orphan tool_result " + b["tool_use_id"]
    parts = [body.get("system") if isinstance(body.get("system"), list) else [], body.get("tools") or []]
    parts += [m.get("content") for m in msgs if isinstance(m.get("content"), list)]
    n = sum(1 for p in parts for b in p if isinstance(b, dict) and b.get("cache_control"))
    return None if n <= 4 else f"{n} cache markers"


class Rules(unittest.TestCase):
    def test_transcript_task_and_view(self):
        msgs = START + step(1, "x" * 5000) + [{"role": "assistant", "content": [{"type": "text", "text": "Done."}]}]
        t = transcript(steps_of(msgs), 40000)
        self.assertIn("=== T1 ===\n[tool call Bash]", t)
        self.assertIn("chars omitted", t, "a long result is clipped")
        self.assertIn("[assistant]\nDone.", t)
        self.assertNotIn("think 1", t, "thinking is left out")
        self.assertNotIn("total_tokens", t, "system messages are left out")
        self.assertEqual(task_of(msgs), "Make the tests pass.", "the task, not Claude Code's reminders")
        h = START + step(1) + step(2) + step(3)
        v = view(h, [{"a": 5, "b": 11, "note": "N"}])
        self.assertEqual(v[:4], h[:4], "Opus's context before the stint unchanged")
        self.assertEqual(v[4]["role"], "user")
        self.assertTrue(v[4]["content"][0]["text"].startswith("[System note]\n<total_tokens>1</total_tokens>\n\n" + NOTE_HEAD))
        self.assertEqual(len(v), 5)
        v = view(h, [{"a": 5, "b": 8, "note": None}])
        self.assertIn(STEPS_HEAD, v[4]["content"][0]["text"])
        self.assertIn("step 2", v[4]["content"][0]["text"], "no note: the steps as a transcript")
        self.assertNotIn("think 2", v[4]["content"][0]["text"])
        self.assertEqual(v[5:], h[8:])
        self.assertTrue(decision('ok {"handoff": true, "reason": "x"}', "handoff"))
        self.assertIsNone(decision('{"handoff": "yes"}', "handoff"))


def wait_for(predicate, timeout=8):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(.01)
    raise AssertionError("timed out waiting for " + str(predicate))


class Through(unittest.TestCase):
    def port_open(self, port):
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=.2):
                return True
        except OSError:
            return False

    def state(self):
        path = Path(self.log + ".state")
        return json.loads(path.read_text()) if path.exists() else {}

    def saved(self):
        return json.loads(Path(self.log + ".saved.json").read_text())

    def start(self, script=None, **overrides):
        portfile = self.log + ".port"
        if os.path.exists(portfile):
            os.remove(portfile)
        env = dict(TEST_ENV, CCSAVE_UPSTREAM=f"http://127.0.0.1:{self.gw.server_address[1]}", CCSAVE_PORT_FILE=portfile,
                   CCSAVE_LOG=self.log, CCSAVE_JUDGE_EVERY="2", CCSAVE_RETURN_EVERY="2", CCSAVE_PING_S="0", CCSAVE_RETRY_S="0.01,0.02,0.03")
        env.update(overrides)
        bootstrap = '''import json, os, runpy, sys, threading
def completed(frame, event, arg):
    if event == "return" and frame.f_code.co_name == "side" and os.environ.get("CCSAVE_TEST_DELAY"):
        threading.Event().wait(.30)
    if event == "return" and frame.f_code.co_name == "judge":
        state = frame.f_globals["State"].st
        with open(os.environ["CCSAVE_LOG"] + ".decisions", "a") as out:
            print(json.dumps([frame.f_locals["kind"], state["want"], state["proofs"]]), file=out)
threading.setprofile(completed)
runpy.run_path(sys.argv[1], run_name="__main__")'''
        self.shell = subprocess.Popen([sys.executable, "-B", "-c", bootstrap, (script or HERE + "/ccsave.py")], env=env)
        wait_for(lambda: os.path.exists(portfile))
        self.port = int(Path(portfile).read_text())

    def setUp(self):
        SEEN.clear()
        Gateway.respond = Gateway.on_request = Gateway.stream_failure = Gateway.after_stream = None
        Gateway.fail_return, Gateway.waiting = None, False
        Gateway.approve, Gateway.reject_cheap, Gateway.limit_once, Gateway.proofs, Gateway.back_at_end, Gateway.kind = True, 0, 0, False, True, "routine"
        self.gw = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Gateway)
        threading.Thread(target=lambda: self.gw.serve_forever(poll_interval=.02), daemon=True).start()
        self.tmp = tempfile.TemporaryDirectory()
        self.log = self.tmp.name + "/ccsave.jsonl"
        self.start()

    def tearDown(self):
        self.stop()
        self.gw.shutdown()
        self.gw.server_close()
        self.tmp.cleanup()

    def stop(self):
        self.shell.kill()
        self.shell.wait(timeout=5)

    def post(self, msgs, metadata=None, wait_judges=True, disconnect=False, transform=None, validate=True, headers=None):
        before = self.state()
        decisions = Path(self.log + ".decisions")
        offset = decisions.stat().st_size if decisions.exists() else 0
        requests_before = len(self.logged("request"))
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)  # retries use short injected waits
        body = {"model": OPUS, "stream": True, "max_tokens": 128000, "thinking": {"type": "adaptive"},
                "system": [{"type": "text", "text": "You are Claude Code.", "cache_control": {"type": "ephemeral"}},
                           {"type": "text", "text": "More.", "cache_control": {"type": "ephemeral"}}],
                "tools": [{"name": "Bash", "input_schema": {}}], "messages": with_last_marker(msgs)}
        request_id = next(IDS)
        body["metadata"] = dict(metadata or {}, test_request=request_id)
        if transform:
            transform(body)
        self.last_body = body
        data = json.dumps(body, indent=2).encode()
        c.request("POST", "/v1/messages?beta=true", body=data, headers=dict({"content-type": "application/json", "anthropic-version": "2023-06-01"}, **(headers or {})))
        r = c.getresponse()
        try:
            r.read()
        except (OSError, http.client.HTTPException):
            if not disconnect:
                raise
        finally:
            c.close()
        self.assertEqual(r.status, 200)
        if not disconnect:
            wait_for(lambda: len(self.logged("request")) > requests_before)
        after = self.state()
        if wait_judges:
            key = "back_judged" if after.get("cheap") else "judged"
            calls = "back_calls" if after.get("cheap") else "calls"
            if after.get(key) is not None and after.get(key) != before.get(key) and after.get(key) == after.get(calls):
                kind = "handback" if after.get("cheap") else "handoff"
                def applied():
                    if decisions.exists():
                        for line in decisions.read_bytes()[offset:].splitlines():
                            completed, want, proofs = json.loads(line)
                            if completed == kind and (not want or self.state().get("want") == want):
                                return True
                wait_for(applied)
        sent = [b for b in SEEN if b.get("metadata", {}).get("test_request") == request_id][-1]
        if validate:
            self.assertIsNone(rules_ok(sent), "the gateway's rules")
        return sent

    def logged(self, kind):
        if not Path(self.log).exists():
            return []
        rows = Path(self.log).read_text().splitlines()
        try:
            return [r for r in map(json.loads, rows) if r.get("kind") == kind]
        except ValueError:
            return []  # a writer may still be appending the last line

    def test_a_stint_is_judged_in_and_out_and_reaches_opus_only_as_its_note(self):
        h = START + step(1)
        self.assertEqual(self.post(START)["model"], OPUS)
        self.assertEqual(self.post(h)["model"], OPUS, "the judge approves now; the switch comes at the next request")
        h += step(2)
        sent = self.post(h)
        a = len(h)
        self.assertEqual(sent["model"], CHEAP)
        self.assertEqual(sent["messages"][0], FIRST, "the cheap model sees the task")
        intro = sent["messages"][1]["content"][0]["text"]
        self.assertIn("[The stronger model hands you the next steps: run the remaining tests]", intro)
        self.assertIn("step 2", intro, "and the recent work")
        self.assertNotIn("think 2", intro)
        self.assertEqual(len(sent["messages"]), 2)
        h += step(3)
        sent = self.post(h)
        self.assertEqual(sent["model"], CHEAP, "its second request; the return judge approves")
        self.assertEqual(bare(sent["messages"][2:]), bare(h[a:]), "the stint's own messages follow its intro")
        h += step(4)
        sent = self.post(h)
        self.assertEqual(sent["model"], OPUS)
        self.assertEqual(bare(sent["messages"][:a - 1]), h[:a - 1], "Opus's own context unchanged, its thinking kept")
        note = sent["messages"][a - 1]["content"][0]
        self.assertEqual(note["text"], f"[System note]\n<total_tokens>2</total_tokens>\n\n{NOTE_HEAD}\n\n{NOTE}")
        self.assertIn("cache_control", note, "the request's end marker moves to the note")
        self.assertEqual(len(sent["messages"]), a, "the cheap model's steps are not sent")
        b = len(h)
        h += [{"role": "assistant", "content": [{"type": "thinking", "thinking": "opus", "signature": "o"},
                                                {"type": "tool_use", "id": "t5", "name": "Bash", "input": {"command": "step 5"}}]},
              {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t5", "content": "ok 5"}]}, sysmsg("s5")]
        Gateway.approve = False
        sent = self.post(h)
        self.assertEqual(sent["messages"][a - 1]["content"][0]["text"].split("\n\n")[-1], NOTE, "later requests carry the note")
        self.assertEqual(bare(sent["messages"][a:]), bare(h[b:]))
        sides = [s["what"] for s in self.logged("side")]
        self.assertEqual(sides, ["handoff", "handback", "note", "handoff"], "back from the stint the judge looks after one call")
        note_req = [x for x in SEEN if not x.get("stream") and str(x.get("system", "")).startswith("You write a hand-off note")][-1]
        self.assertIn("step 3", note_req["messages"][0]["content"])
        self.assertNotIn("step 2", note_req["messages"][0]["content"], "the note is written from the stint's steps only")
        models = [(r["model"], r["routed"]) for r in self.logged("request") if r.get("main")]
        self.assertEqual(models, [(OPUS, False), (OPUS, False), (CHEAP, True), (CHEAP, True), (OPUS, False), (OPUS, False)])
        self.assertTrue(all(r["usage"] == {"input_tokens": 100, "cache_read_input_tokens": 10, "output_tokens": 5} for r in self.logged("request") if r.get("main")))

    def test_the_cheap_model_ending_its_turn_gives_the_work_back_and_the_state_survives_a_restart(self):
        h = START + step(1)
        self.post(START), self.post(h)
        h += step(2)
        Gateway.approve = False  # the return judge keeps the cheap model
        self.assertEqual(self.post(h)["model"], CHEAP)
        a = len(h)
        h += [{"role": "assistant", "content": [{"type": "text", "text": "All done: tests pass."}]}]
        k = len(h)
        h += [{"role": "user", "content": "Stop hook feedback: Do not stop. Continue working on the implementation."}, sysmsg("hook")]
        sent = self.post(h)
        self.assertEqual(sent["model"], OPUS, "the cheap model ended its turn")
        self.assertEqual(sent["messages"][a - 1]["content"][0]["text"].split("\n\n")[-1], NOTE)
        self.assertEqual(bare(sent["messages"][a:]), bare(h[k:]), "the stop hook's message follows the note")
        self.assertEqual([s["why"] for s in self.logged("switch") if "why" in s], ["message"])
        self.stop()
        self.start()  # Claude Code restarted: a new proxy
        h += step(6)
        sent = self.post(h)
        self.assertEqual((sent["model"], sent["messages"][a - 1]["content"][0]["text"].split("\n\n")[-1]), (OPUS, NOTE))

    def test_a_turn_end_the_judge_keeps_continues_the_stint_and_the_note_covers_all_of_it(self):
        h = START + step(1)
        self.post(START), self.post(h)
        h += step(2)
        Gateway.approve = False  # the return judge every few calls keeps the cheap model
        self.assertEqual(self.post(h)["model"], CHEAP)
        a = len(h)
        h += [{"role": "assistant", "content": [{"type": "text", "text": "Ran the first batch: 3 of 5 pass."}]},
              {"role": "user", "content": "Stop hook feedback: Do not stop. Continue working on the implementation."}, sysmsg("hook")]
        Gateway.back_at_end = False
        sent = self.post(h)
        self.assertEqual(sent["model"], CHEAP, "kept at its turn end: it goes on")
        self.assertEqual(bare(sent["messages"][2:]), bare(h[a:]), "with its report and the stop hook's message in its view")
        ext = [s for s in self.logged("side") if s["what"] == "extend"]
        self.assertEqual(len(ext), 1)
        ask = [x for x in SEEN if not x.get("stream") and "has just ended its turn" in json.dumps(x.get("messages"))][-1]
        self.assertTrue(ask["system"].startswith("You decide when a coding agent should give"), "the return judge decides")
        self.assertIn("3 of 5 pass", ask["messages"][0]["content"])
        self.assertEqual(len(self.logged("extend")), 1)
        h += step(7)
        self.assertEqual(self.post(h)["model"], CHEAP, "a tool step after the kept turn end stays with it")
        k = len(h)
        h += [{"role": "assistant", "content": [{"type": "text", "text": "All 5 pass now."}]},
              {"role": "user", "content": "Stop hook feedback: Do not stop."}, sysmsg("hook 2")]
        Gateway.back_at_end = True
        sent = self.post(h)
        self.assertEqual(sent["model"], OPUS, "given back at the next turn end")
        self.assertEqual(sent["messages"][a - 1]["content"][0]["text"].split("\n\n")[-1], NOTE)
        self.assertEqual(bare(sent["messages"][a:]), bare(h[k + 1:]), "extended hooks fold into the note")
        note_req = [x for x in SEEN if not x.get("stream") and str(x.get("system", "")).startswith("You write a hand-off note")][-1]
        self.assertIn("3 of 5 pass", note_req["messages"][0]["content"])
        self.assertIn("step 7", note_req["messages"][0]["content"])
        self.assertEqual([s["why"] for s in self.logged("switch") if "why" in s], ["message"])

    def test_implementation_goes_to_the_mid_model_and_routine_to_the_cheap_one(self):
        self.assertNotEqual(MID, CHEAP)
        Gateway.kind = "implementation"
        h = START + step(1)
        self.post(START), self.post(h)
        h += step(2)
        Gateway.approve = False
        sent = self.post(h)
        self.assertEqual(sent["model"], MID, "implementation: the mid model")
        h += step(3)
        self.assertEqual(self.post(h)["model"], MID, "for the whole stint")
        h += [{"role": "assistant", "content": [{"type": "text", "text": "Implemented."}]},
              {"role": "user", "content": "Stop hook feedback: Do not stop."}, sysmsg("hook")]
        self.assertEqual(self.post(h)["model"], OPUS, "given back at its turn end")
        self.assertEqual([s.get("to") for s in self.logged("switch")], [MID, OPUS])
        self.assertEqual([r["model"] for r in self.logged("request") if r.get("routed")], [MID, MID])
        Gateway.kind, Gateway.approve = "routine", True
        h += step(8)
        self.post(h)
        h += step(9)
        self.assertEqual(self.post(h)["model"], CHEAP, "a routine stint: the cheap model")

    def test_a_formal_proof_task_stays_on_opus(self):
        Gateway.proofs = True  # the judge approves, but says the task is formal proof work
        h = START + step(1)
        self.post(START), self.post(h)
        for i in range(2, 8):
            h += step(i)
            self.assertEqual(self.post(h)["model"], OPUS)
        self.assertEqual([s["what"] for s in self.logged("side")], ["handoff"], "asked once, then never again")
        self.assertEqual(self.logged("switch"), [])

    def test_opus_is_kept_warm_while_the_cheap_model_works(self):
        self.stop()
        self.start(CCSAVE_PING_S="1")  # the proxy reads the interval at startup
        h = START + step(1)
        self.post(START), self.post(h)
        Gateway.approve = False
        h += step(2)
        self.post(h)  # on the cheap model now
        pings = wait_for(lambda: self.logged("ping"))
        self.assertTrue(pings and all(p["status"] == 200 for p in pings))
        ping = [x for x in SEEN if not x.get("stream") and x.get("messages") and "keep-alive" in json.dumps(x["messages"][-1])][-1]
        self.assertEqual(ping["model"], OPUS)
        self.assertEqual(bare(ping["messages"][:-1]), bare(START + step(1))[:-1], "Opus's newest request, before the stint")
        saved = self.saved()
        self.assertAlmostEqual(saved["ping_cost"], sum(proxy.cost(p["model"], p["usage"]) for p in pings))
        self.assertGreater(saved["ping_cost"], 0)
        self.assertAlmostEqual(saved["estimated_saved"], saved["baseline_cost"] - saved["cheap_cost"] - saved["judge_note_cost"] - saved["ping_cost"])

    def test_rejected_or_rate_limited_cheap_request_returns_with_note(self):
        for status, why in ((400, "rejected"), (429, "rate-limited")):
            with self.subTest(status=status):
                h = [dict(FIRST, content="Task " + str(status)), START[1]]
                Gateway.approve, Gateway.reject_cheap = True, 0
                self.post(h)
                h += step(1)
                self.post(h)
                Gateway.approve = False
                h += step(2)
                self.post(h)
                a = len(h)
                h += step(3)
                Gateway.reject_cheap = status
                sent = self.post(h)
                self.assertEqual(sent["model"], OPUS)
                self.assertEqual(sent["messages"][a - 1]["content"][0]["text"].split("\n\n")[-1], NOTE)
                self.assertEqual(self.logged("switch")[-1]["why"], why)

    def test_a_rate_limit_is_retried_before_the_work_goes_back(self):
        h = START + step(1)
        self.post(START)
        Gateway.limit_once = 1  # the hand-off judge is rate-limited once, then approves
        self.post(h)
        self.assertEqual([(s["what"], s.get("retries")) for s in self.logged("side")], [("handoff", 1)])
        Gateway.approve = False
        h += step(2)
        self.assertEqual(self.post(h)["model"], CHEAP)
        h += step(3)
        Gateway.limit_once = 1  # Haiku's next request is rate-limited once
        sent = self.post(h)
        self.assertEqual(sent["model"], CHEAP, "sent again after a wait, the stint goes on")
        self.assertEqual(self.logged("cheap-rate-limited"), [])

    def begin_stint(self):
        h = START + step(1)
        self.post(START), self.post(h)
        Gateway.approve = False
        h += step(2)
        self.assertEqual(self.post(h)["model"], CHEAP)
        return h

    def test_compaction_during_stint_with_and_without_results(self):
        for mixed in (False, True):
            with self.subTest(mixed=mixed):
                if mixed:
                    self.stop()
                    Path(self.log + ".state").unlink()
                    self.start()
                Gateway.approve = True
                h = self.begin_stint()
                compaction = proxy.COMPACT_MARK + " Summarize this conversation."
                if mixed:
                    h += step(3)[:2]
                    h[-1]["content"].append({"type": "text", "text": compaction})
                else:
                    h += [{"role": "assistant", "content": "cheap report"}, {"role": "user", "content": compaction}]
                h += [sysmsg("compact")]
                sent = self.post(h)
                self.assertEqual(sent["model"], OPUS)
                self.assertIn(compaction, json.dumps(sent))
                self.assertIn(NOTE, json.dumps(sent))
                self.assertEqual(self.logged("switch")[-1]["why"], "compaction")
                self.assertNotIn('"tool_use_id": "t3"', json.dumps(sent))

    def test_typed_instruction_ends_stint_even_when_judge_would_keep_it(self):
        h = self.begin_stint()
        Gateway.back_at_end = False
        h += step(3)[:2]
        h[-1]["content"].append({"type": "text", "text": "Use the new API instead."})
        h += [sysmsg("typed")]
        sent = self.post(h)
        self.assertEqual(sent["model"], OPUS)
        self.assertIn("Use the new API instead.", json.dumps(sent))
        self.assertNotIn('"tool_use_id": "t3"', json.dumps(sent))

    def test_mixed_stop_hook_folds_into_note_on_later_requests(self):
        h = self.begin_stint()
        Gateway.back_at_end = False
        h += step(3)[:2]
        h[-1]["content"].append({"type": "text", "text": "Stop hook feedback: Do not stop. Check the output."})
        h += [sysmsg("hook")]
        self.assertEqual(self.post(h)["model"], CHEAP)
        Gateway.approve = True
        h += step(4)
        self.post(h)
        h += step(5)
        self.post(h)
        h += step(6)
        Gateway.approve = False
        sent = self.post(h)
        self.assertEqual(sent["model"], OPUS)
        self.assertNotIn("Check the output.", json.dumps(sent))
        for i in (7, 8):
            h += step(i)
            sent = self.post(h)
            self.assertEqual(sent["model"], OPUS)
            self.assertNotIn("Check the output.", json.dumps(sent))
            self.assertNotIn('"tool_use_id": "t3"', json.dumps(sent))

    def test_new_instruction_expires_pending_approval(self):
        h = START + step(1)
        self.post(START), self.post(h)
        Gateway.approve = False
        h += [{"role": "assistant", "content": "Ready."}, {"role": "user", "content": "Change the design."}, sysmsg("new")]
        self.assertEqual(self.post(h)["model"], OPUS)
        h += step(2)
        self.assertEqual(self.post(h)["model"], OPUS)

    def test_restart_expires_pending_approval(self):
        h = START + step(1)
        self.post(START), self.post(h)
        self.stop()
        self.start()
        Gateway.approve = False
        h += step(2)
        self.assertEqual(self.post(h)["model"], OPUS)

    def test_history_mismatch_keeps_matching_stints_and_hides_others(self):
        h = self.begin_stint()
        h += step(3)
        Gateway.approve = True
        self.post(h)
        h += step(4)
        Gateway.approve = False
        self.post(h)
        h += step(5)
        self.post(h)
        h[-1] = sysmsg("changed history tail")
        sent = self.post(h)
        self.assertIn(NOTE, json.dumps(sent))
        self.assertNotIn("think 3", json.dumps(sent))
        self.assertTrue(self.logged("history-mismatch"))
        h[8]["content"][0]["thinking"] = "changed cheap thinking"
        h[-1] = sysmsg("another changed tail")
        sent = self.post(h)
        self.assertNotIn("changed cheap thinking", json.dumps(sent))
        self.assertNotIn('"tool_use_id": "t3"', json.dumps(sent))
        self.assertIn("uncertain model steps omitted", json.dumps(sent))
        h += step(6)
        self.assertNotIn("changed cheap thinking", json.dumps(self.post(h)))

    def test_new_conversation_clears_proof_latch(self):
        Gateway.proofs = True
        self.post(START), self.post(START + step(1))
        Gateway.proofs = False
        h = [dict(FIRST, content="A new non-proof task."), START[1]]
        self.post(h)
        h += step(2)
        self.post(h)
        h += step(3)
        self.assertEqual(self.post(h)["model"], CHEAP)

    def test_session_metadata_resets_latch_for_identical_tasks(self):
        Gateway.proofs = True
        old = {"user_id": json.dumps({"session_id": "old"})}
        new = {"user_id": json.dumps({"session_id": "new"})}
        self.post(START, old), self.post(START + step(1), old)
        Gateway.proofs = False
        h = list(START)
        self.post(h, new)
        self.assertFalse(self.state()["proofs"])
        self.assertEqual(self.saved()["estimated_saved"], 0)
        h += step(2)
        self.post(h, new)
        h += step(3)
        self.assertEqual(self.post(h, new)["model"], CHEAP)

    def test_mixed_boundary_has_no_orphan_results_on_later_requests(self):
        h = self.begin_stint()
        h += step(3)[:2]
        h[-1]["content"].append({"type": "text", "text": "Stop hook feedback: Continue."})
        h += [sysmsg("hook")]
        for i in range(4, 7):
            sent = self.post(h)
            self.assertEqual(sent["model"], OPUS)
            self.assertIn("Stop hook feedback: Continue.", json.dumps(sent))
            self.assertNotIn('"tool_use_id": "t3"', json.dumps(sent))
            h += step(i)

    def test_auth_and_server_errors_fall_back_and_restart_on_opus(self):
        for status in (401, 403, 500, 503):
            with self.subTest(status=status):
                self.stop()
                if Path(self.log + ".state").exists():
                    Path(self.log + ".state").unlink()
                self.start()
                Gateway.approve, Gateway.reject_cheap = True, 0
                h = self.begin_stint()
                h += step(3)
                Gateway.reject_cheap = status
                sent = self.post(h)
                self.assertEqual(sent["model"], OPUS)
                self.assertIn(NOTE, json.dumps(sent))
                self.stop()
                self.start()
                Gateway.reject_cheap = 0
                h += step(4)
                self.assertEqual(self.post(h)["model"], OPUS)

    def test_failed_return_judge_gives_back_on_next_request(self):
        for failure in ("503", "malformed"):
            with self.subTest(failure=failure):
                self.stop()
                if Path(self.log + ".state").exists():
                    Path(self.log + ".state").unlink()
                self.start()
                Gateway.approve = True
                h = self.begin_stint()
                Gateway.fail_return = failure
                h += step(3)
                self.assertEqual(self.post(h)["model"], CHEAP)
                h += step(4)
                self.assertEqual(self.post(h)["model"], OPUS)
                if failure == "503":
                    self.assertIn("offline failure", [r for r in self.logged("side") if r["what"] == "handback"][-1].get("error_body", ""))
                Gateway.fail_return = None

    def test_waiting_rule_routes_mock_judgements_both_ways(self):
        # The deterministic judge implements the supplied waiting rule, not language-model reasoning.
        Gateway.waiting = True
        h = START + step(1)
        self.post(START), self.post(h)
        h += step(2)
        self.assertEqual(self.post(h)["model"], OPUS)
        Gateway.waiting = False
        h += step(3)
        self.post(h)
        h += step(4)
        self.assertEqual(self.post(h)["model"], CHEAP)
        Gateway.waiting = True
        h += step(5)
        self.post(h)
        h += step(6)
        self.assertEqual(self.post(h)["model"], OPUS)

    def test_bridge_logs_each_added_marker(self):
        self.post(START)
        sent = self.post(START + step(1))
        self.assertEqual(len(self.logged("bridge")), 1)
        rec = self.logged("bridge")[0]
        self.assertEqual((rec["message"], rec["block"], rec["model"]), (1, 0, OPUS))
        self.assertIn("cache_control", sent["messages"][1]["content"][0])

    def test_model_env_overrides_files_and_empty_judge_disables_handoff(self):
        self.stop()
        self.start(CCSAVE_CHEAP_MODEL="test-cheap", CCSAVE_JUDGE_MODEL="test-judge")
        h = START + step(1)
        self.post(START), self.post(h)
        h += step(2)
        self.assertEqual(self.post(h)["model"], "test-cheap")
        self.assertEqual(self.logged("side")[0]["model"], "test-judge")
        self.stop()
        self.start(CCSAVE_JUDGE_MODEL="")
        h += step(3)
        self.assertEqual(self.post(h), self.last_body)

    def test_mid_override_and_empty_mid_disables_implementation(self):
        self.stop()
        self.start(CCSAVE_MID_MODEL="test-mid")
        Gateway.kind = "implementation"
        h = START + step(1)
        self.post(START), self.post(h)
        h += step(2)
        self.assertEqual(self.post(h)["model"], "test-mid")
        self.stop()
        Path(self.log + ".state").unlink()
        self.start(CCSAVE_MID_MODEL="")
        self.post(START), self.post(START + step(1))
        self.assertEqual(self.post(START + step(1) + step(2))["model"], OPUS)

    def test_saved_file_accounts_for_cheap_work_judges_notes_and_restart(self):
        h = self.begin_stint()
        h += step(3)
        Gateway.approve = True
        self.post(h)
        h += step(4)
        Gateway.approve = False
        self.post(h)
        saved = json.loads(Path(self.log + ".saved.json").read_text())
        self.assertEqual(saved["current_model"], OPUS)
        self.assertAlmostEqual(saved["baseline_cost"], 2 * (100 * 4 + 10 * .2 + 5 * 20) / 1e6)
        self.assertAlmostEqual(saved["cheap_cost"], 2 * (100 * .1 + 10 * .01 + 5 * .5) / 1e6)
        self.assertAlmostEqual(saved["judge_note_cost"], 3 * (50 * .1 + 7 * .5) / 1e6)
        self.assertEqual(saved["ping_cost"], 0, "keep-warm is off in these tests")
        self.assertAlmostEqual(saved["estimated_saved"], saved["baseline_cost"] - saved["cheap_cost"] - saved["judge_note_cost"] - saved["ping_cost"])
        self.stop()
        self.start()
        h += step(5)
        self.post(h)
        resumed = json.loads(Path(self.log + ".saved.json").read_text())
        self.assertEqual(resumed["baseline_cost"], saved["baseline_cost"])
        result = subprocess.run([HERE + "/statusline.sh"], input="{}", text=True, capture_output=True,
                                env=dict(TEST_ENV, CCSAVE_SAVED_FILE=self.log + ".saved.json"), check=True)
        self.assertEqual(result.stdout, f"⚡ SoL-Pi · {OPUS} · ~${self.saved()['estimated_saved']:.2f} saved after $0.00 keep-warm\n")

    def test_price_and_saved_file_overrides(self):
        self.stop()
        savedfile = self.tmp.name + "/custom.json"
        prices = {OPUS: [10, 50, 1, 12.5, 20], CHEAP: [2, 10, .2, 2.5, 4]}
        self.start(CCSAVE_SAVED_FILE=savedfile, CCSAVE_PRICES=json.dumps(prices))
        self.begin_stint()
        saved = json.loads(Path(savedfile).read_text())
        self.assertAlmostEqual(saved["baseline_cost"], (100 * 10 + 10 + 5 * 50) / 1e6)
        self.assertEqual(saved["current_model"], CHEAP)

    def test_child_exit_stops_proxy_while_parent_is_alive(self):
        self.stop()
        child = subprocess.Popen([sys.executable, "-c", "import signal; signal.pause()"], env=TEST_ENV)
        self.addCleanup(lambda: child.poll() is None and child.kill())
        pidfile = self.tmp.name + "/child"
        Path(pidfile).write_text(str(child.pid))
        self.start(CCSAVE_CLIENT_PID_FILE=pidfile, CCSAVE_PING_S="0")  # keep-warm off: the client watcher still runs
        self.post(START)
        child.terminate()
        child.wait(timeout=3)
        self.assertEqual(self.shell.wait(timeout=8), 0)

    def test_parent_exit_stops_proxy(self):
        self.stop()
        portfile = self.tmp.name + "/parent-port"
        env = dict(TEST_ENV, CCSAVE_UPSTREAM=f"http://127.0.0.1:{self.gw.server_address[1]}",
                   CCSAVE_PORT_FILE=portfile, CCSAVE_PING_S="0.2", CCSAVE_LOG=self.log)
        parent = subprocess.Popen(["bash", "-c", '"$1" -B "$2" & wait', "bash", sys.executable, HERE + "/ccsave.py"], env=env)
        try:
            wait_for(lambda: Path(portfile).exists())
            self.port = int(Path(portfile).read_text())
            self.post(START)
            parent.kill()
            parent.wait(timeout=3)
            wait_for(lambda: not self.port_open(self.port))
            c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=1)
            try:
                with self.assertRaises(OSError):
                    c.connect()
            finally:
                c.close()
        finally:
            if parent.poll() is None:
                parent.kill()
            parent.wait(timeout=3)

    def test_launcher_passes_args_stdin_and_status_and_cleans_up(self):
        self.stop()
        stub = Path(self.tmp.name) / "claude"
        capture = self.tmp.name + "/launch.json"
        stub.write_text("#!" + sys.executable + "\n" + r'''
import http.client, json, os, sys, urllib.parse
u = urllib.parse.urlparse(os.environ["ANTHROPIC_BASE_URL"])
c = http.client.HTTPConnection(u.hostname, u.port)
c.request("POST", "/v1/messages", json.dumps({"model": "claude-opus-5-5", "messages": [{"role": "user", "content": "hello"}]}), {"content-type": "application/json"})
r = c.getresponse()
r.read()
c.close()
with open(os.environ["CAPTURE"], "w") as f:
    json.dump({"args": sys.argv[1:], "port": u.port, "stdin": sys.stdin.read(), "saved": os.environ["CCSAVE_SAVED_FILE"], "status": r.status}, f)
sys.exit(7)
''')
        stub.chmod(0o755)
        env = dict(TEST_ENV, PATH=self.tmp.name + os.pathsep + os.environ["PATH"], CAPTURE=capture,
                   CCSAVE_LOG=self.log, CCSAVE_UPSTREAM=f"http://127.0.0.1:{self.gw.server_address[1]}")
        result = subprocess.run([HERE + "/claude-solpi", "--continue", "two words", "literal $value"],
                                env=env, input="terminal input", text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 7, result.stderr)
        got = json.loads(Path(capture).read_text())
        self.assertEqual(got["args"], ["--continue", "two words", "literal $value"])
        self.assertEqual((got["stdin"], got["status"]), ("terminal input", 200))
        self.assertEqual(got["saved"], self.log + ".saved.json")
        c = http.client.HTTPConnection("127.0.0.1", got["port"], timeout=1)
        try:
            with self.assertRaises(OSError):
                c.connect()
        finally:
            c.close()

    def test_launcher_start_failure_and_signal_cleanup(self):
        self.stop()
        env = dict(TEST_ENV, CCSAVE_LOG=self.log, CCSAVE_UPSTREAM="invalid")
        result = subprocess.run([HERE + "/claude-solpi"], env=env, capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 1)
        self.assertIn(b"proxy failed to start", result.stderr)
        stub = Path(self.tmp.name) / "claude"
        capture = self.tmp.name + "/running.json"
        stub.write_text("#!" + sys.executable + "\n" +
                        "import json, os, signal\nwith open(os.environ['CAPTURE'], 'w') as f:\n" +
                        "    json.dump({'pid': os.getpid(), 'url': os.environ['ANTHROPIC_BASE_URL']}, f)\nsignal.pause()\n")
        stub.chmod(0o755)
        env.update(CCSAVE_UPSTREAM=f"http://127.0.0.1:{self.gw.server_address[1]}", CAPTURE=capture,
                   PATH=self.tmp.name + os.pathsep + os.environ["PATH"])
        launcher = subprocess.Popen([HERE + "/claude-solpi"], env=env, stdin=subprocess.DEVNULL)
        try:
            wait_for(lambda: Path(capture).exists() and Path(capture).stat().st_size)
            got = json.loads(Path(capture).read_text())
            launcher.terminate()
            self.assertEqual(launcher.wait(timeout=5), 143)
            with self.assertRaises(ProcessLookupError):
                os.kill(got["pid"], 0)
            port = int(got["url"].rsplit(":", 1)[-1])
            c = http.client.HTTPConnection("127.0.0.1", port, timeout=1)
            try:
                with self.assertRaises(OSError):
                    c.connect()
            finally:
                c.close()
        finally:
            if launcher.poll() is None:
                launcher.terminate()
            launcher.wait(timeout=5)

    def test_hook_plus_typed_text_ends_stint(self):
        h = self.begin_stint() + step(3)[:2]
        Gateway.back_at_end = False
        h[-1]["content"] += [{"type": "text", "text": "Stop hook feedback: Continue."},
                             {"type": "text", "text": "Stop testing and redesign the API."}]
        h += [sysmsg("typed")]
        sent = self.post(h)
        self.assertEqual(sent["model"], OPUS)
        self.assertIn(NOTE, json.dumps(sent))
        self.assertIn("redesign the API", json.dumps(sent))
        self.assertFalse(any(r["what"] == "extend" for r in self.logged("side")))

    def test_bare_continues_use_extension_judge(self):
        h = self.begin_stint()
        Gateway.back_at_end = False
        for text in ("Continue working.", " CONTINUE! ", "keep going...", "Go on?", "proceed", "continue…", "GO ON—", "Stop hook feedback: Continue."):
            h += [{"role": "assistant", "content": "done"}, {"role": "user", "content": text}, sysmsg("hook")]
            sent = self.post(h)
            self.assertEqual(sent["model"], CHEAP, text)
            self.assertEqual(bare(sent["messages"][2:]), bare(h[8:]))
        self.assertEqual(len(self.logged("extend")), 8)
        h += [{"role": "assistant", "content": "done"}, {"role": "user", "content": "Continue by redesigning the API."}, sysmsg("typed")]
        sent = self.post(h)
        self.assertEqual(sent["model"], OPUS)
        self.assertEqual(len(sent["messages"]), 10)
        self.assertNotIn("Continue working.", json.dumps(sent))
        self.assertIn("Continue by redesigning", json.dumps(sent))

    def test_opus_only_mixed_message_is_unchanged(self):
        h = START + step(1)
        h[-2]["content"].append({"type": "text", "text": "Also inspect the API."})
        self.assertEqual(self.post(h), self.last_body)

    def test_extended_hook_marker_moves_to_note(self):
        h = self.begin_stint() + step(3)[:2]
        Gateway.back_at_end = False
        h[-1]["content"].append({"type": "text", "text": "Stop hook feedback: Continue.", "cache_control": {"type": "ephemeral"}})
        self.post(h)
        Gateway.back_at_end = True
        h += [{"role": "assistant", "content": "done"}, {"role": "user", "content": "Stop hook feedback: done?"}, sysmsg("last")]
        sent = self.post(h)
        self.assertEqual(len(sent["messages"]), 10)
        self.assertIn("cache_control", sent["messages"][7]["content"][0])
        self.assertNotIn("Stop hook feedback: Continue.", json.dumps(sent))
        note = [b for b in SEEN if str(b.get("system", "")).startswith("You write a hand-off note")][-1]
        self.assertIn("Stop hook feedback: Continue.", json.dumps(note))

    def test_appended_compaction_preserves_boundary_and_note(self):
        for results in (True, False):
            with self.subTest(results=results):
                self.stop()
                if Path(self.log + ".state").exists():
                    Path(self.log + ".state").unlink()
                self.start()
                Gateway.approve, Gateway.back_at_end = True, False
                h = self.begin_stint()
                h += (step(3, "RESULT_SENTINEL")[:2] if results else
                      [{"role": "assistant", "content": "cheap report"},
                       {"role": "user", "content": [{"type": "text", "text": "Stop hook feedback: RESULT_SENTINEL"}]}])
                self.assertEqual(self.post(h)["model"], CHEAP)
                start = self.state()["start"]
                mismatches = len(self.logged("history-mismatch"))
                h[-1]["content"].append({"type": "text", "text": proxy.COMPACT_MARK + " Summarize."})
                sent = self.post(h)
                self.assertEqual(sent["model"], OPUS)
                self.assertIn(NOTE, json.dumps(sent))
                self.assertIn(proxy.COMPACT_MARK, json.dumps(sent))
                self.assertEqual(len(self.logged("history-mismatch")), mismatches)
                self.assertEqual(self.state()["stints"][-1]["a"], start)
                note = [b for b in SEEN if str(b.get("system", "")).startswith("You write a hand-off note")][-1]
                self.assertIn("RESULT_SENTINEL", json.dumps(note))
                self.assertNotIn(proxy.COMPACT_MARK, json.dumps(note))
                # Editing only the retained instruction must not invalidate the cheap part of the range.
                h[-1]["content"][-1]["text"] += " Preserve filenames."
                h += [sysmsg("changed tail")]
                sent = self.post(h)
                self.assertIn(NOTE, json.dumps(sent))
                self.assertIn("Preserve filenames.", json.dumps(sent))

    def test_mismatch_detection_ignores_older_edits_and_edits_past_the_tail_limit(self):
        Gateway.approve = False
        h = START + step(1)
        h[-1] = sysmsg("x" * 5000)
        self.post(h)
        h[2]["content"][0]["thinking"] = "edited older Opus thought"
        h[-1]["content"][0]["text"] += "edited after the tail limit"
        sent = self.post(h)
        self.assertIn("edited older Opus thought", json.dumps(sent))
        self.assertFalse(self.logged("history-mismatch"))

    def test_compaction_preserves_proofs_and_savings_across_restart(self):
        Gateway.proofs = True
        self.post(START), self.post(START + step(1))
        saved = self.saved()
        h = START + step(1)[:2]
        h[-1]["content"].append({"type": "text", "text": proxy.COMPACT_MARK})
        summary_text = "Summary of the same task: prove the lemma."
        def summarize(gw, body):
            if body.get("model") == OPUS:
                gw.reply(200, {"content": [{"type": "text", "text": summary_text}]})
                return True
        Gateway.respond = summarize
        self.post(h, transform=lambda body: body.update(stream=False))
        Gateway.respond = None
        summary = [{"role": "user", "content": [{"type": "text", "text": summary_text}]}]
        self.post(summary)
        self.assertTrue(self.state()["proofs"])
        self.assertEqual(self.saved()["estimated_saved"], saved["estimated_saved"])
        self.stop()
        self.start()
        self.post(summary + step(2))
        self.assertTrue(self.state()["proofs"])
        self.assertEqual(self.saved()["estimated_saved"], saved["estimated_saved"])

    def test_recognized_summary_retains_identity_without_session_metadata(self):
        Gateway.proofs = True
        self.post(START), self.post(START + step(1))
        saved = self.saved()["estimated_saved"]
        self.post([{ "role": "user", "content": [{"type": "text", "text":
                   "This session is being continued from a previous conversation that ran out of context. Summary: same proof task."}]}])
        self.assertTrue(self.state()["proofs"])
        self.assertEqual(self.saved()["estimated_saved"], saved)

    def test_new_session_keeps_its_own_opus_history(self):
        self.post(START, {"session_id": "old"})
        h = START + step(1)
        sent = self.post(h, {"session_id": "new"})
        self.assertEqual(sent, self.last_body)
        self.assertIn("think 1", json.dumps(sent))
        self.assertFalse(self.logged("history-mismatch"))

    def test_stream_error_missing_stop_and_reset_return_to_opus(self):
        for failure in ("error", "missing-stop", "reset"):
            for restart in (False, True):
                with self.subTest(failure=failure, restart=restart):
                    self.stop()
                    if Path(self.log + ".state").exists():
                        Path(self.log + ".state").unlink()
                    self.start()
                    Gateway.approve, Gateway.stream_failure = True, None
                    h = self.begin_stint() + step(3)
                    Gateway.stream_failure = failure
                    self.post(h, disconnect=(failure == "reset"))
                    if restart:
                        self.stop()
                        self.start()
                    Gateway.stream_failure = None
                    sent = self.post(h + step(4))
                    self.assertEqual(sent["model"], OPUS)
                    self.assertIn(NOTE, json.dumps(sent))

    def test_error_event_returns_to_opus_before_stream_closes(self):
        h = self.begin_stint() + step(3)
        entered, release = threading.Event(), threading.Event()
        def hold(body):
            if body.get("model") == CHEAP:
                entered.set()
                if not release.wait(5):
                    raise AssertionError("error stream gate timed out")
        Gateway.after_stream, Gateway.stream_failure = hold, "error"
        with concurrent.futures.ThreadPoolExecutor(1) as pool:
            pending = pool.submit(self.post, h, None, False)
            self.assertTrue(entered.wait(3))
            try:
                wait_for(lambda: self.state().get("want") == "handback", timeout=2)
                Gateway.after_stream, Gateway.stream_failure = None, None
                self.assertEqual(self.post(h + step(4))["model"], OPUS)
            finally:
                release.set()
            pending.result(timeout=3)

    def test_overlapping_requests_keep_individual_restart_protection(self):
        h = self.begin_stint() + step(3)
        entered = {name: threading.Event() for name in ("a", "b")}
        release = {name: threading.Event() for name in entered}
        def gate(body):
            lane = body.get("metadata", {}).get("lane")
            if body.get("stream") and body.get("model") == CHEAP and lane:
                entered[lane].set()
                if not release[lane].wait(8):
                    raise AssertionError("stream gate timed out")
        Gateway.on_request = gate
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            a = pool.submit(self.post, h, {"lane": "a"}, False)
            self.assertTrue(entered["a"].wait(3))
            b = pool.submit(self.post, h, {"lane": "b"}, False)
            try:
                self.assertTrue(entered["b"].wait(3))
                release["a"].set()
                a.result(timeout=3)
                pending = self.state().get("inflight") or []
                self.assertIsInstance(pending, list, "requests need individual restart protection")
                self.assertEqual(len(pending), 1)
                self.stop()
                self.start()
                Gateway.on_request = None
                sent = self.post(h + step(4))
                self.assertEqual(sent["model"], OPUS)
            finally:
                release["a"].set()
                release["b"].set()
                try:
                    b.result(timeout=3)
                except (OSError, http.client.HTTPException):
                    pass

    def test_old_failed_request_cannot_reuse_new_conversation_ranges(self):
        h = self.begin_stint() + step(3)
        entered, release = threading.Event(), threading.Event()
        def gate(body):
            if body.get("stream") and body.get("model") == CHEAP:
                entered.set()
                if not release.wait(5):
                    raise AssertionError("cheap request gate timed out")
        Gateway.on_request, Gateway.reject_cheap = gate, 503
        with concurrent.futures.ThreadPoolExecutor(1) as pool:
            pending = pool.submit(self.post, h, None, False)
            self.assertTrue(entered.wait(3))
            try:
                fresh = [dict(FIRST, content="Another conversation."), START[1]]
                self.post(fresh, wait_judges=False)
                saved = self.saved()["estimated_saved"]
            finally:
                release.set()
            sent = pending.result(timeout=4)
        self.assertEqual(sent["model"], OPUS)
        self.assertIn(NOTE, json.dumps(sent))
        self.assertNotIn("think 3", json.dumps(sent))
        self.assertEqual(self.saved()["estimated_saved"], saved)
        self.assertEqual(self.state()["n"], len(fresh))

    def test_routing_wait_serializes_history_recovery(self):
        h = self.begin_stint() + step(3)
        self.post(h)
        h += [{"role": "assistant", "content": "done"}, {"role": "user", "content": "Stop hook feedback: Continue."}, sysmsg("hook")]
        entered, release = threading.Event(), threading.Event()
        def gate(body):
            if "has just ended its turn" in json.dumps(body.get("messages")):
                entered.set()
                if not release.wait(5):
                    raise AssertionError("extend gate timed out")
        Gateway.on_request = gate
        changed = copy.deepcopy(h)
        changed.insert(1, {"role": "user", "content": "inserted earlier history"})
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            a = pool.submit(self.post, h, None, False)
            self.assertTrue(entered.wait(3))
            b = pool.submit(self.post, changed, None, False)
            # A broken proxy lets B finish while A is waiting; a serialized one waits here.
            try:
                b.result(timeout=.3)
            except concurrent.futures.TimeoutError:
                pass
            finally:
                release.set()
            for future in (a, b):
                sent = future.result(timeout=4)
                self.assertEqual(sent["model"], OPUS)
                self.assertNotIn("think 3", json.dumps(sent))
                self.assertNotIn('"tool_use_id": "t3"', json.dumps(sent))
        self.assertTrue(self.logged("history-mismatch"))

    def stale_judge(self, new_session):
        entered, release = threading.Event(), threading.Event()
        def gate(body):
            if str(body.get("system", "")).startswith("You decide when a coding agent may hand"):
                entered.set()
                if not release.wait(5):
                    raise AssertionError("handoff gate timed out")
        Gateway.on_request, Gateway.proofs = gate, True
        h = START + step(1)
        self.post(START)
        self.post(h, wait_judges=False)
        self.assertTrue(entered.wait(3))
        try:
            h = ([dict(FIRST, content="A different conversation."), START[1]] if new_session else
                 h + [{"role": "assistant", "content": "ready"}, {"role": "user", "content": "Redesign the API."}, sysmsg("instruction")])
            self.post(h, wait_judges=False)
            saved = self.saved()["estimated_saved"] if Path(self.log + ".saved.json").exists() else None
        finally:
            release.set()
        wait_for(lambda: self.logged("side"))
        Gateway.on_request, Gateway.approve, Gateway.proofs = None, False, False
        if saved is not None:
            self.assertEqual(self.saved()["estimated_saved"], saved)
        sent = self.post(h + step(9), wait_judges=False)
        self.assertEqual(sent["model"], OPUS)
        self.assertFalse(self.state()["proofs"])

    def test_stale_conversation_judge_cannot_route_or_charge(self):
        self.stale_judge(True)

    def test_stale_async_judge_cannot_apply_after_new_instruction(self):
        """An actual instruction invalidates a delayed judge response."""
        self.stale_judge(False)

    def test_preserved_instruction_does_not_duplicate_cache_marker(self):
        """A mixed boundary sent over HTTP, using only the proxy's request interface."""
        h = self.begin_stint() + step(3)[:2]
        h[-1]["content"].append({"type": "text", "text": "Use the new API instead."})
        sent = self.post(h, transform=lambda body: body["messages"][-1]["content"][-1].pop("cache_control"), validate=False)
        note = sent["messages"][-2]["content"][0]
        self.assertIn("cache_control", note, "the owned result's marker belongs on the note")
        self.assertNotIn("cache_control", sent["messages"][-1]["content"][-1])
        self.assertIsNone(rules_ok(sent))

    def test_side_text_is_logged_and_bridge_end_survives_history_mismatch(self):
        h = self.begin_stint() + step(3)
        self.post(h)
        h[-1] = sysmsg("mismatched tail")
        sent = self.post(h)
        self.assertIn("cache_control", sent["messages"][4]["content"][0])
        self.assertIn("text", self.logged("side")[0])
        self.assertTrue(self.logged("history-mismatch"))

    def test_delayed_mock_judges_use_bounded_waits(self):
        self.stop()
        self.start(CCSAVE_TEST_DELAY="1")
        def delay(body):
            if str(body.get("system", "")).startswith("You decide"):
                threading.Event().wait(.15)  # injected server latency, not a synchronization sleep
        Gateway.on_request = delay
        self.test_a_stint_is_judged_in_and_out_and_reaches_opus_only_as_its_note()

    def launcher_stub(self, code):
        self.stop()
        stub = Path(self.tmp.name) / "claude"
        stub.write_text("#!" + sys.executable + "\n" + code)
        stub.chmod(0o755)
        return dict(TEST_ENV, CCSAVE_LOG=self.log, CCSAVE_UPSTREAM=f"http://127.0.0.1:{self.gw.server_address[1]}",
                    PATH=self.tmp.name + os.pathsep + os.environ["PATH"], CAPTURE=self.tmp.name + "/capture",
                    TMPDIR=self.tmp.name)

    def test_sigint_belongs_to_claude_and_launcher_keeps_waiting(self):
        env = self.launcher_stub("""import os, signal
from pathlib import Path
path = os.environ['CAPTURE']
def interrupted(signum, frame):
    Path(path + '.int').write_text('handled')
signal.signal(signal.SIGINT, interrupted)
signal.signal(signal.SIGUSR1, lambda *args: exit(7))
Path(path).write_text(str(os.getpid()))
while True:
    signal.pause()
""")
        launcher = subprocess.Popen([HERE + "/claude-solpi"], env=env, stdin=subprocess.DEVNULL, start_new_session=True)
        try:
            capture = Path(env["CAPTURE"])
            wait_for(lambda: capture.exists() and capture.stat().st_size)
            pid = int(capture.read_text())
            os.killpg(launcher.pid, signal.SIGINT)
            wait_for(lambda: Path(str(capture) + ".int").exists())
            self.assertIsNone(launcher.poll())
            os.kill(pid, signal.SIGUSR1)
            self.assertEqual(launcher.wait(timeout=4), 7)
            self.assertFalse(list(Path(self.tmp.name).glob("claude-solpi.*")))
        finally:
            if launcher.poll() is None:
                os.killpg(launcher.pid, signal.SIGKILL)
            launcher.wait(timeout=3)

    def test_term_and_hup_cleanup_are_bounded(self):
        env = self.launcher_stub("""import json, os, signal
from pathlib import Path
path = os.environ['CAPTURE']
def ignored(signum, frame):
    Path(path + '.signal').write_text(str(signum))
signal.signal(signal.SIGTERM, ignored)
signal.signal(signal.SIGHUP, ignored)
Path(path).write_text(json.dumps({'pid': os.getpid(), 'url': os.environ['ANTHROPIC_BASE_URL']}))
while True:
    signal.pause()
""")
        def check(sig):
            directory = Path(self.tmp.name) / sig.name
            directory.mkdir()
            capture = directory / "capture"
            child_env = dict(env, TMPDIR=str(directory), CAPTURE=str(capture), CCSAVE_LOG=str(directory / "log"))
            launcher = subprocess.Popen([HERE + "/claude-solpi"], env=child_env, stdin=subprocess.DEVNULL, start_new_session=True)
            try:
                wait_for(lambda: capture.exists() and capture.stat().st_size)
                got = json.loads(capture.read_text())
                started = time.monotonic()
                launcher.send_signal(sig)
                try:
                    status = launcher.wait(timeout=12)
                except subprocess.TimeoutExpired:
                    self.fail("launcher did not finish cleanup within 12 seconds")
                self.assertEqual(status, 128 + sig)
                self.assertLess(time.monotonic() - started, 12)
                self.assertEqual(int(Path(str(capture) + ".signal").read_text()), sig)
                with self.assertRaises(ProcessLookupError):
                    os.kill(got["pid"], 0)
                self.assertFalse(self.port_open(int(got["url"].rsplit(":", 1)[-1])))
                self.assertFalse(list(directory.glob("claude-solpi.*")))
            finally:
                if launcher.poll() is None:
                    os.killpg(launcher.pid, signal.SIGKILL)
                launcher.wait(timeout=3)
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            list(pool.map(check, (signal.SIGTERM, signal.SIGHUP)))

    def test_early_setup_failure_cleans_temporary_directory(self):
        self.stop()
        blocker = Path(self.tmp.name) / "regular-file"
        blocker.write_text("not a directory")
        env = dict(TEST_ENV, CCSAVE_LOG=str(blocker / "log"), TMPDIR=self.tmp.name,
                   CCSAVE_UPSTREAM=f"http://127.0.0.1:{self.gw.server_address[1]}")
        result = subprocess.run([HERE + "/claude-solpi"], env=env, capture_output=True, timeout=3)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(list(Path(self.tmp.name).glob("claude-solpi.*")))

    def test_session_beats_reminder_edit(self):
        meta = {"session_id": "same"}
        h = copy.deepcopy(START) + step(1)
        self.post(START, meta), self.post(h, meta)
        Gateway.approve = False
        h += step(2)
        self.assertEqual(self.post(h, meta)["model"], CHEAP)
        h[0]["content"][0]["text"] = "<system-reminder>edited</system-reminder>"
        h += step(3)[:2]
        h[-1]["content"].append({"type": "text", "text": "Design a new API."})
        sent = self.post(h, meta)
        self.assertIn(NOTE, json.dumps(sent))
        self.assertNotIn("think 3", json.dumps(sent))

    def test_compaction_does_not_claim_next_task(self):
        Gateway.proofs = True
        self.post(START), self.post(START + step(1))
        self.post(START + step(1)[:2] + [{"role": "user", "content": [{"type": "text", "text": proxy.COMPACT_MARK}]}])
        self.stop(); self.start()
        fresh = [dict(FIRST, content="Design a different API."), START[1]] + step(2)
        self.assertEqual(self.post(fresh), self.last_body)
        self.assertFalse(self.state()["proofs"])
        self.assertEqual(self.saved()["estimated_saved"], 0)

    def test_mixed_boundary_replays_by_tool_id(self):
        h = self.begin_stint() + step(3)[:2]
        h[-1]["content"].append({"type": "text", "text": "Design a new API."})
        h += [sysmsg("same tail")]
        self.post(h)
        for count in (2, 1, 0):
            replay = copy.deepcopy(h)
            replay[-3]["content"] = [step(30+i)[0]["content"][1] for i in range(count)]
            replay[-2]["content"] = [{"type": "text", "text": "BEFORE"}] + [step(30+i)[1]["content"][0] for i in range(count)] + h[-2]["content"][1:]
            sent = self.post(replay)
            for text in (NOTE, "BEFORE", "Design a new API."):
                self.assertIn(text, json.dumps(sent))
            self.assertNotIn('"tool_result"', json.dumps(sent["messages"][-2]))

    def test_mismatch_preserves_opus_only_evidence(self):
        Gateway.proofs = True
        h = START + step(1)
        self.post(START), self.post(h)
        h[-1] = sysmsg("changed tail")
        sent = self.post(h + step(2, "ONLY_OPUS_KNOWS"))
        self.assertEqual(bare(sent["messages"]), bare(self.last_body["messages"]))

    def test_compaction_covers_reply_after_edited_user(self):
        for inside in (False, True):
            self.stop(); Path(self.log + ".state").unlink(missing_ok=True); self.start()
            Gateway.approve = True
            h = self.begin_stint()
            if inside:
                h += step(3)
                self.post(h)
            h[-2]["content"].append({"type": "text", "text": proxy.COMPACT_MARK})
            h += [{"role": "assistant", "content": [{"type": "thinking", "thinking": "RAW_CHEAP_THOUGHT"},
                                                      {"type": "text", "text": "FINAL_CHEAP_REPORT"}]}, sysmsg("summarize")]
            sent = self.post(h, transform=(lambda body: (body.pop("thinking"), body.pop("tools"))) if inside else None)
            self.assertIn(NOTE, json.dumps(sent))
            self.assertNotIn("RAW_CHEAP_THOUGHT", json.dumps(sent))
            self.assertIn(proxy.COMPACT_MARK, json.dumps(sent["messages"][-2]))
            note = next(b for b in reversed(SEEN) if str(b.get("system")).startswith("You write a hand-off note"))
            self.assertIn("FINAL_CHEAP_REPORT", json.dumps(note))
            self.assertNotIn(proxy.COMPACT_MARK, json.dumps(note))

    def test_deleted_stint_cannot_claim_known_opus_turn(self):
        prefix = self.begin_stint()
        h = prefix + step(3)
        Gateway.approve = True
        self.post(h)
        Gateway.approve = False
        h += step(4); self.post(h)
        opus = step(5, "ONLY_OPUS_KNOWS")
        self.post(h + opus)
        self.stop(); self.start()
        opus[0]["content"][0]["thinking"] = "edited Opus thought, same tool call"
        sent = self.post(prefix + opus)
        self.assertEqual(bare(sent["messages"]), bare(self.last_body["messages"]))

    def test_typed_append_precedes_handoff_and_extend(self):
        h = START + step(1)
        self.post(START), self.post(h)
        h[-2]["content"].append({"type": "text", "text": "Design a new API."})
        self.assertEqual(self.post(h)["model"], OPUS)
        h += step(2); self.post(h)
        h += step(3); self.assertEqual(self.post(h)["model"], CHEAP)
        Gateway.back_at_end = Gateway.approve = False
        h += [{"role": "assistant", "content": "Finished"}, {"role": "user", "content": [{"type": "text", "text": "Continue working."}]}, sysmsg("same")]
        self.assertEqual(self.post(h)["model"], CHEAP)
        h[-2]["content"].append({"type": "text", "text": "Redesign everything."})
        sent = self.post(h)
        for text in (NOTE, "Redesign everything."):
            self.assertIn(text, json.dumps(sent))
        self.assertEqual(sent["model"], OPUS)

    def test_tool_free_compaction_before_later_results(self):
        h = self.begin_stint() + step(3)
        self.post(h)
        h[-2]["content"].append({"type": "text", "text": proxy.COMPACT_MARK})
        h += step(4, "FINAL_RESULT")
        sent = self.post(h, transform=lambda body: (body.pop("thinking"), body.pop("tools")))
        self.assertIn(NOTE, json.dumps(sent))
        self.assertNotIn("think 4", json.dumps(sent))
        note = next(b for b in reversed(SEEN) if str(b.get("system")).startswith("You write a hand-off note"))
        self.assertIn("FINAL_RESULT", json.dumps(note))
        self.assertNotIn(proxy.COMPACT_MARK, json.dumps(note))

    def test_late_rejection_same_history_cannot_close_new_stint(self):
        h = self.begin_stint()
        entered, release = threading.Event(), threading.Event()
        def reject(gw, body):
            if body.get("metadata", {}).get("lane") == "held" and body["model"] == CHEAP:
                entered.set()
                if not release.wait(5):
                    raise AssertionError("late rejection gate timed out")
                gw.reply(503, {})
                return True
        Gateway.respond, Gateway.approve = reject, True
        with concurrent.futures.ThreadPoolExecutor(1) as pool:
            pending = pool.submit(self.post, h, {"lane": "held"}, False)
            try:
                self.assertTrue(entered.wait(3))
                wait_for(lambda: self.state()["want"] == "handback")
                self.assertEqual(self.post(h)["model"], OPUS)
                for _ in range(4):
                    if self.post(h)["model"] == CHEAP:
                        break
                self.assertTrue(self.state()["cheap"])
                before = self.saved()["judge_note_cost"]
            finally:
                release.set()
            self.assertEqual(pending.result(timeout=4)["model"], OPUS)
        self.assertTrue(self.state()["cheap"], "late 503 closed the replacement stint")
        self.assertAlmostEqual(self.saved()["judge_note_cost"] - before, proxy.cost(JUDGE, {"input_tokens":50,"output_tokens":7}))

    def test_late_success_billed_once_to_original_generation(self):
        h = self.begin_stint() + step(3)
        entered, release = threading.Event(), threading.Event()
        def hold(body):
            if body.get("metadata", {}).get("lane") == "held":
                entered.set(); release.wait(5)
        Gateway.after_stream = hold
        with concurrent.futures.ThreadPoolExecutor(1) as pool:
            pending = pool.submit(self.post, h, {"lane": "held"}, False)
            try:
                self.assertTrue(entered.wait(3))
                self.post(h[:-1] + [sysmsg("edited tail")])
                before = self.saved()["cheap_cost"]
            finally:
                release.set()
            pending.result(timeout=4)
        wait_for(lambda: len([r for r in self.logged("request") if r.get("routed")]) == 2)
        self.assertEqual(self.saved()["cheap_cost"], before)
        stale = [r for r in self.logged("request") if r.get("retired_generation_cost")]
        self.assertEqual(len(stale), 1)
        self.assertAlmostEqual(stale[0]["retired_generation_cost"], proxy.cost(CHEAP, stale[0]["usage"]))

    def test_snapshot_note_cost_in_same_conversation(self):
        h = self.begin_stint() + step(3)
        entered, release = threading.Event(), threading.Event()
        def reject(gw, body):
            if body.get("metadata", {}).get("lane") == "old" and body["model"] == CHEAP:
                entered.set(); release.wait(5); gw.reply(503, {})
                return True
        Gateway.respond = reject
        with concurrent.futures.ThreadPoolExecutor(1) as pool:
            pending = pool.submit(self.post, h, {"lane": "old"}, False)
            try:
                self.assertTrue(entered.wait(3))
                self.post(h + step(4))
                before = self.saved()["judge_note_cost"]
            finally:
                release.set()
            self.assertIn(NOTE, json.dumps(pending.result(timeout=4)))
        self.assertAlmostEqual(self.saved()["judge_note_cost"] - before, proxy.cost(JUDGE, {"input_tokens":50,"output_tokens":7}))

    def test_requested_stream_requires_terminal_stop(self):
        h = self.begin_stint() + step(3)
        def json_error(gw, body):
            if body["model"] == CHEAP and body.get("stream"):
                gw.reply(200, {"type": "error", "error": "overloaded"})
                return True
        Gateway.respond = json_error
        self.post(h)
        self.assertEqual(self.state()["want"], "handback")
        row = self.logged("request")[-1]
        self.assertEqual((row["status"], row["complete"], row["reason"]), (200, False, "missing-message-stop"))
        self.stop(); self.start(); self.assertEqual(self.post(h + step(4))["model"], OPUS)

    def test_short_error_falls_back_short_success_closes(self):
        h = self.begin_stint() + step(3)
        status = 503
        def short(gw, body):
            if body.get("stream") and (body["model"] == CHEAP or status == 200):
                gw.send_response(status); gw.send_header("content-length", "4096"); gw.end_headers()
                gw.wfile.write(b"bad"); gw.close_connection = True
                return True
        Gateway.respond = short
        self.assertEqual(self.post(h)["model"], OPUS)
        status = 200
        started = time.monotonic()
        self.post(h + step(4), disconnect=True)
        self.assertLess(time.monotonic()-started, 2)
        row = wait_for(lambda: next((r for r in self.logged("request") if r.get("reason") == "short-body"), None))
        self.assertEqual((row["status"], row["complete"]), (200, False))

    def test_proof_verdict_reaches_disk_on_the_next_routing_save(self):
        Gateway.proofs = True
        self.post(START), self.post(START + step(1))
        self.assertFalse(self.state()["proofs"], "a proof-only verdict reaches disk on the next routing save")
        self.post(START + step(1) + step(2))
        self.assertTrue(self.state()["proofs"])

    def test_non200_handoff_and_note_text_is_used(self):
        def non200(gw, body):
            system = str(body.get("system"))
            if system.startswith(("You decide when a coding agent may hand", "You write a hand-off note")):
                gw.reply(503, {"content": [{"type": "text", "text": NOTE if system.startswith("You write") else '{"handoff":true}'}]})
                return True
        Gateway.respond = non200
        h = self.begin_stint() + step(3)[:2]
        h[-1]["content"].append({"type": "text", "text": "New design."})
        self.assertIn(NOTE, json.dumps(self.post(h)))

    def test_default_sigint_child_exits_launcher_with_130(self):
        env = self.launcher_stub("import os\nfrom pathlib import Path\nPath(os.environ['CAPTURE']).touch()\nos.execl('/bin/sleep', 'sleep', '60')\n")
        proc = subprocess.Popen([HERE + "/claude-solpi"], env=env, start_new_session=True)
        try:
            wait_for(lambda: Path(env["CAPTURE"]).exists())
            os.killpg(proc.pid, signal.SIGINT)
            wait_for(lambda: proc.poll() is not None, timeout=2)
            self.assertEqual(proc.returncode, 130)
        finally:
            if proc.poll() is None:
                os.killpg(proc.pid, signal.SIGKILL)
            proc.wait()

    def test_records_are_private_and_child_umask_is_unchanged(self):
        env = self.launcher_stub("import os\nfrom pathlib import Path\nPath(os.environ['CAPTURE']).write_text(str(os.umask(0)))\nos.chdir('/')\nassert Path(os.environ['CCSAVE_SAVED_FILE']).is_absolute()")
        env.update(CCSAVE_LOG="records/log")
        result = subprocess.run(['bash', '-c', 'umask 022; exec "$1"', 'bash', HERE + '/claude-solpi'], env=env, cwd=self.tmp.name, timeout=4)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(Path(env["CAPTURE"]).read_text(), str(0o022))
        records = Path(self.tmp.name) / "records"
        for path in (records, records / "log.err"):
            self.assertEqual(path.stat().st_mode & 0o077, 0)
        self.start(); self.begin_stint()
        for suffix in ("", ".state", ".saved.json"):
            self.assertEqual(Path(self.log + suffix).stat().st_mode & 0o077, 0)

    def test_disabled_preserves_bytes_and_resets_identity(self):
        self.begin_stint()
        self.assertNotEqual(self.saved()["estimated_saved"], 0)
        self.stop(); self.start(CCSAVE_CHEAP_MODEL="")
        self.post([dict(FIRST, content="Different task"), START[1]], {"session_id": "other"})
        self.assertEqual(Gateway.raw, json.dumps(self.last_body, indent=2).encode())
        self.assertEqual(self.saved()["estimated_saved"], 0)

    def test_judge_counts_main_requests_without_tool_calls(self):
        self.stop(); self.start(CCSAVE_JUDGE_EVERY="5")
        for _ in range(5):
            self.post(START)
        self.assertEqual(self.state()["calls"], 5)
        self.assertEqual(self.state()["want"], "handoff")

    def test_records_ignore_planted_temps_and_log_appends_in_place(self):
        victim = Path(self.tmp.name) / 'unrelated'
        victim.write_text('untouched')
        for suffix in ('', '.saved.json', '.state'):
            Path(self.log + suffix + '.tmp').symlink_to(victim)
        self.post(START)
        self.assertEqual(victim.read_text(), 'untouched')
        with open(self.log) as previous:
            contents = previous.read()
            self.post(START + step(1))
            previous.seek(0)
            grown = previous.read()
        # the log grows in place: no copy of the whole file per record
        self.assertTrue(grown.startswith(contents) and len(grown) > len(contents))

    def test_symlinked_log_is_refused(self):
        victim = Path(self.tmp.name) / 'unrelated'
        victim.write_text('untouched')
        Path(self.log).symlink_to(victim)
        with patch.object(proxy, 'LOG', self.log):
            proxy.log({'kind': 'test'})
        self.assertEqual(victim.read_text(), 'untouched')

    def test_error_log_symlink_is_refused(self):
        victim = Path(self.tmp.name) / 'unrelated'
        victim.write_text('untouched')
        env = self.launcher_stub('raise SystemExit(0)')
        Path(self.log + '.err').symlink_to(victim)
        proc = subprocess.run([HERE + '/claude-solpi'], env=env, capture_output=True, timeout=4)
        self.assertNotEqual(proc.returncode, 0)
        self.assertEqual(victim.read_text(), 'untouched')

    def test_launcher_ignores_checkout_state_and_keys_private_directory(self):
        env = self.launcher_stub('''import json, os, urllib.request
from pathlib import Path
data = json.dumps({'model': 'opus', 'tools': [{}], 'thinking': {'type':'adaptive'}, 'messages':[{'role':'user','content':'MY TASK'}]}).encode()
urllib.request.urlopen(os.environ['ANTHROPIC_BASE_URL'] + '/v1/messages', data=data).read()
Path(os.environ['CAPTURE']).write_text(os.environ['CCSAVE_LOG'])''')
        env.pop('CCSAVE_LOG')
        root = Path(self.tmp.name) / 'private'
        env.update(XDG_STATE_HOME=str(root), HOME=self.tmp.name)
        locations = []
        for name in ('first', 'second'):
            project = Path(self.tmp.name) / name
            legacy = project / '.ccsave' / 'ccsave.jsonl.state'
            legacy.parent.mkdir(parents=True)
            (project / '.git').mkdir()
            legacy.write_text(json.dumps({'stints': [{'a': 0, 'b': 1, 'note': 'PLANTED'}]}))
            subprocess.run([HERE + '/claude-solpi'], cwd=project, env=env, check=True, timeout=5)
            self.assertIn('MY TASK', json.dumps(SEEN[-1]))
            self.assertNotIn('PLANTED', json.dumps(SEEN[-1]))
            location = Path(Path(env['CAPTURE']).read_text())
            self.assertEqual(location.parent.parent, root.resolve() / 'sol-pi-v2')
            self.assertFalse(location.parent.stat().st_mode & 0o077)
            self.assertEqual(list(legacy.parent.iterdir()), [legacy])
            locations.append(location)
        self.assertNotEqual(*locations)

    def test_state_directory_inside_checkout_is_not_adopted(self):
        env = self.launcher_stub('raise SystemExit(0)')
        env.pop('CCSAVE_LOG')
        project = Path(self.tmp.name) / 'checkout'
        subdir = project / 'sub'; subdir.mkdir(parents=True); (project / '.git').mkdir()
        env.update(XDG_STATE_HOME=str(project / 'planted'))
        proc = subprocess.run([HERE + '/claude-solpi'], env=env, cwd=subdir, capture_output=True, timeout=4)
        self.assertNotEqual(proc.returncode, 0)
        self.assertFalse((project / 'planted').exists())

    def test_compression_negotiation_keeps_successful_cheap_route(self):
        h = self.begin_stint()
        encodings = []
        def negotiate(gateway, body):
            if not body.get('stream') or body['model'] != CHEAP:
                return False
            values = gateway.headers.get_all('accept-encoding', [])
            encodings.append(values)
            data = b'data: {"type":"message_delta","usage":{"output_tokens":10}}\n\ndata: {"type":"message_stop"}\n\n'
            gateway.send_response(200)
            if 'gzip' in ','.join(values):
                data = gzip.compress(data)
                gateway.send_header('Content-Encoding', 'gzip')
            gateway.send_header('Content-Length', str(len(data)))
            gateway.end_headers()
            gateway.wfile.write(data)
            return True
        Gateway.respond = negotiate
        self.post(h + step(3), headers={'AcCePt-EnCoDiNg': 'gzip', 'ACCEPT-ENCODING': 'deflate'})
        sent = self.post(h + step(3) + step(4))
        self.assertEqual(sent['model'], CHEAP)
        self.assertEqual(encodings, [['identity'], ['identity']])
        self.assertEqual(self.logged('request')[-1]['usage']['output_tokens'], 10)

    def test_clean_exit_drains_and_resumes_cheap(self):
        h = self.begin_stint()
        before = self.saved()['baseline_cost']
        env = self.launcher_stub('''import os, urllib.request
from pathlib import Path
response = urllib.request.urlopen(os.environ['ANTHROPIC_BASE_URL'] + '/v1/messages', data=Path(os.environ['CAPTURE']).read_bytes())
assert b'message_stop' in response.read()''')
        env.update(CCSAVE_RETURN_EVERY='99')
        body = dict(self.last_body, messages=with_last_marker(h + step(3)))
        Path(env['CAPTURE']).write_text(json.dumps(body))
        install = Path(self.tmp.name) / 'installed proxy'
        install.mkdir()
        for name in ('ccsave.py', 'claude-solpi', 'cheap-model.txt', 'mid-model.txt', 'judge-model.txt'):
            shutil.copy2(Path(HERE) / name, install)
        script = install / 'ccsave.py'
        hook = '    def finish_cheap(self, state, request_id, complete):\n'
        script.write_text(script.read_text().replace(hook, hook + '        if complete: time.sleep(.4)\n'))
        proc = subprocess.run([str(install / 'claude-solpi')], env=env, timeout=4)
        self.assertEqual(proc.returncode, 0)
        self.assertFalse(self.state()['inflight'])
        self.assertGreater(self.saved()['baseline_cost'], before)
        self.start()
        self.assertEqual(self.post(h + step(3) + step(4))['model'], CHEAP)

    def test_inflight_write_failure_never_dispatches_cheap(self):
        h = self.begin_stint()
        state = Path(self.log + '.state')
        state.unlink(); state.mkdir()
        data = json.dumps(dict(self.last_body, messages=with_last_marker(h + step(3))))
        before = len(SEEN)
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=3)
        conn.request('POST', '/v1/messages', data)
        response = conn.getresponse(); response.read(); conn.close()
        self.assertEqual(response.status, 200)
        self.assertEqual([b['model'] for b in SEEN[before:] if b.get('stream')], [OPUS])
        self.assertTrue(self.logged('persistence-error'))

    def test_chunked_request_is_dechunked_when_disabled(self):
        self.stop(); self.start(CCSAVE_CHEAP_MODEL='')
        captured = []
        def echo(gateway):
            size = int(gateway.headers['Content-Length'])
            captured.append((size, gateway.rfile.read(size), gateway.headers.get('Transfer-Encoding')))
            gateway.reply(200, {})
        data = b'{ "model": "opus", "messages": [] }\n'
        with patch.object(Gateway, 'do_POST', echo):
            conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=3)
            conn.putrequest('POST', '/v1/messages'); conn.putheader('Transfer-Encoding', 'chunked'); conn.endheaders()
            for part in (data[:9], data[9:]):
                conn.send(b'%x;ext=1\r\n%s\r\n' % (len(part), part))
            conn.send(b'0\r\nX-Trailer: end\r\n\r\n'); conn.getresponse().read(); conn.close()
        self.assertEqual(captured, [(len(data), data, None)])

    def test_disabled_session_without_tools_resets_savings_and_passes_unchanged(self):
        h = self.begin_stint() + step(3)
        self.post(h, {'session_id': 'A'})
        self.assertNotEqual(self.saved()['estimated_saved'], 0)
        self.stop(); self.start(CCSAVE_JUDGE_MODEL='')
        self.post(h, {'user_id': json.dumps({'session_id': 'B'})}, transform=lambda b: b.update(tools=[]))
        self.assertEqual(self.saved()['estimated_saved'], 0)
        self.assertEqual(self.saved()['current_model'], OPUS)
        self.assertEqual(Gateway.raw, json.dumps(self.last_body, indent=2).encode())

    def test_shared_status_requires_matching_persisted_state(self):
        self.begin_stint()
        old = self.saved(); self.assertNotEqual(old['estimated_saved'], 0)
        self.stop(); Path(self.log + '.state').unlink(); self.start()
        self.post(START)
        self.assertEqual(self.saved()['estimated_saved'], 0)
        self.stop(); Path(self.log + '.saved.json').write_text(json.dumps(old)); self.start()
        self.post(START + step(1), wait_judges=False)
        self.assertEqual(self.saved()['baseline_cost'], 0)

    def test_text_suffix_expires_approval(self):
        h = copy.deepcopy(START)
        self.post(h, {'session_id': 'A'}); self.post(h, {'session_id': 'A'})
        self.assertEqual(self.state()['want'], 'handoff')
        h[0]['content'][-1]['text'] += ' Now design a new API.'
        self.assertEqual(self.post(h, {'session_id': 'A'})['model'], OPUS)

    def test_text_suffix_after_extension_returns_to_opus(self):
        h = self.begin_stint() + [{'role': 'assistant', 'content': 'done'}, {'role': 'user', 'content': 'Continue working.'}, sysmsg('hook')]
        Gateway.back_at_end = False
        self.assertEqual(self.post(h)['model'], CHEAP)
        h[-2]['content'] += ' Now design a new API.'
        sent = self.post(h)
        self.assertEqual(sent['model'], OPUS)
        self.assertIn('design a new API', json.dumps(sent)); self.assertIn(NOTE, json.dumps(sent))

    def test_disabling_freezes_stint_before_opus_work(self):
        h = self.begin_stint() + step(3, 'CHEAP_RESULT')
        self.stop(); self.start(CCSAVE_CHEAP_MODEL=''); self.post(h, transform=lambda b: b.update(tools=[]))
        h += step(4, 'OPUS_ONLY'); self.post(h)
        self.stop(); self.start()
        h += step(5, 'OPUS_ONLY') + [{'role': 'assistant', 'content': 'ready'}, {'role': 'user', 'content': 'New design'}, sysmsg('new')]
        sent = self.post(h)
        self.assertEqual(sent['model'], OPUS)
        self.assertIn('think 4', json.dumps(sent)); self.assertIn('OPUS_ONLY', json.dumps(sent))
        self.assertNotIn('think 3', json.dumps(sent))
        notes = [b for b in SEEN if str(b.get('system')).startswith('You write a hand-off note')]
        self.assertNotIn('OPUS_ONLY', json.dumps(notes))

    def test_signal_reaches_tool_tree(self):
        env = self.launcher_stub('''import os, signal, subprocess, sys
from pathlib import Path
leaf = "import os, signal; from pathlib import Path; signal.signal(signal.SIGTERM, signal.SIG_IGN); Path(os.environ['CAPTURE']).write_text(str(os.getpid())); signal.pause()"
subprocess.Popen([sys.executable, '-c', 'import subprocess,sys; subprocess.call([sys.executable,"-c",sys.argv[1]],start_new_session=True)', leaf]).wait()''')
        capture = Path(env['CAPTURE'])
        proc = subprocess.Popen([HERE + '/claude-solpi'], env=env, start_new_session=True)
        try:
            wait_for(lambda: capture.exists() and capture.stat().st_size)
            leaf = int(capture.read_text())
            proc.terminate(); self.assertEqual(proc.wait(timeout=12), 143)
            with self.assertRaises(ProcessLookupError):
                os.kill(leaf, 0)
        finally:
            if capture.exists():
                try: os.kill(int(capture.read_text()), signal.SIGKILL)
                except ProcessLookupError: pass
            if proc.poll() is None: proc.kill()
            proc.wait()

    def test_without_a_cheap_model_requests_pass_exactly_unchanged(self):
        self.stop()
        self.start(CCSAVE_CHEAP_MODEL="")
        h = START + step(1) + step(2) + step(3)
        for n in (2, 5, 8, 11):
            self.assertEqual(self.post(h[:n]), self.last_body)
        self.assertEqual(self.logged("side"), [])
        self.assertEqual(self.logged("bridge"), [])


class Configuration(unittest.TestCase):
    def test_state_and_savings_refuse_symlink_destinations(self):
        with tempfile.TemporaryDirectory() as temp:
            victim = Path(temp, 'unrelated'); victim.write_text('unchanged')
            for name, writer in [('STATE_FILE', proxy.save), ('SAVED_FILE', proxy.save_saving)]:
                record = Path(temp, name); record.symlink_to(victim)
                with patch.object(proxy, name, str(record)):
                    writer()
                self.assertTrue(record.is_symlink(), name)
                self.assertEqual(victim.read_text(), 'unchanged')

    def test_statusline_does_not_import_project_modules(self):
        with tempfile.TemporaryDirectory() as temp:
            Path(temp, 'json.py').write_text('open("EXECUTED", "w").close()')
            subprocess.run([HERE + '/statusline.sh'], cwd=temp, env=TEST_ENV, check=True, capture_output=True)
            self.assertFalse(Path(temp, 'EXECUTED').exists())

    def test_all_sse_line_endings_parse_across_reads(self):
        for eol in (b'\r', b'\r\n', b'\n'):
            stream = proxy.MessageStream(False)
            data = eol.join([b'data: {"type":', b'data: "message_stop"}', b'', b''])
            for byte in data:
                stream.feed(bytes([byte]))
            self.assertTrue(stream.stopped, eol); self.assertFalse(stream.failed, eol)

    def test_stint_owns_results_across_adjacent_user_messages(self):
        calls = [step(i)[0]['content'][-1] for i in (3, 4)]
        msgs = START + [{'role': 'assistant', 'content': calls}, step(3)[1], step(4)[1], sysmsg('tail')]
        msgs[-2]['content'].append({'type': 'text', 'text': 'Keep my instruction'})
        stint = dict(a=2, b=3, note=NOTE)
        sent = {'messages': view(msgs, [stint])}
        self.assertIsNone(rules_ok(sent)); self.assertIn('Keep my instruction', json.dumps(sent))
        steps = json.dumps(proxy.stint_steps(msgs, stint))
        self.assertIn('ok 4', steps); self.assertNotIn('Keep my instruction', steps)

    def test_dead_client_is_not_pinged(self):
        with patch.multiple(proxy.State, body={"thinking": {}, "messages": START}, headers={}, path="/", touched=0, heard=time.time()), \
                patch.object(proxy.time, "sleep", side_effect=[None, StopIteration]), \
                patch.object(proxy, "client_alive", return_value=False), patch.object(proxy, "upstream") as upstream:
            with self.assertRaises(StopIteration):
                proxy.pinger()
            upstream.assert_not_called()

    def test_bad_ports_never_publish_readiness(self):
        with tempfile.TemporaryDirectory() as directory:
            port = Path(directory) / "port"
            for invalid in ("bad", "65536", "0", ""):
                env = dict(TEST_ENV, CCSAVE_UPSTREAM="http://127.0.0.1:" + invalid, CCSAVE_PORT_FILE=str(port))
                with subprocess.Popen([sys.executable, "-B", HERE + "/ccsave.py"], env=env, stderr=subprocess.PIPE) as proc:
                    try:
                        wait_for(lambda: port.exists() or proc.poll() is not None)
                        self.assertFalse(port.exists(), invalid)
                        self.assertNotEqual(proc.returncode, 0)
                    finally:
                        proc.kill()

    def test_unchanged_opus_history_has_bounded_fingerprints(self):
        messages = START + sum((step(i) for i in range(100)), [])
        body = {"messages": messages, "model": OPUS}
        with patch.multiple(proxy.State, st=proxy.new_state()), patch.object(proxy, "save"), \
                patch.object(proxy, "fingerprint", wraps=proxy.fingerprint) as digest:
            proxy.route(body, {}, "/")
            digest.reset_mock()
            proxy.route(body, {}, "/")
            self.assertLess(digest.call_count, 6)
            self.assertLess(len(json.dumps(proxy.State.st)), 2000)

    def test_upstream_is_required_at_startup(self):
        env = dict(TEST_ENV)
        env.pop("CCSAVE_UPSTREAM", None)
        proc = subprocess.Popen([sys.executable, "-B", HERE + "/ccsave.py"], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            out, err = proc.communicate(timeout=.5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.communicate()
            self.fail("proxy started without CCSAVE_UPSTREAM")
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn(b"CCSAVE_UPSTREAM is required", err)

    def test_cache_write_prices_and_missing_prices_are_explicit(self):
        usage = {"input_tokens": 100, "output_tokens": 5, "cache_read_input_tokens": 10,
                 "cache_creation_input_tokens": 30, "cache_creation": {"ephemeral_1h_input_tokens": 10}}
        self.assertAlmostEqual(proxy.cost(OPUS, usage), (400 + 100 + 2 + 20 * 5 + 10 * 8) / 1e6)
        self.assertIsNone(proxy.cost("unpriced", usage))
        self.assertIn("unpriced", proxy.Saving.data["unpriced_models"])

    def test_keep_warm_polls_every_five_seconds_beyond_two_hours(self):
        body = {"model": OPUS, "thinking": {"type": "adaptive"}, "messages": START}
        for idle, pinged in ((3599, True), (3600, False)):  # seconds since Claude Code's last request; the default cap is 3600
            with self.subTest(idle=idle), \
                    patch.multiple(proxy.State, body=body, headers={}, path="/v1/messages", touched=0, heard=8000 - idle), \
                    patch.object(proxy.time, "time", return_value=8000), \
                    patch.object(proxy.time, "sleep", side_effect=[None, StopIteration]) as slept, \
                    patch.object(proxy, "upstream") as upstream, patch.object(proxy, "log") as logged:
                upstream.return_value.getresponse.return_value.status = 200
                upstream.return_value.getresponse.return_value.read.return_value = b'{}'
                with self.assertRaises(StopIteration):
                    proxy.pinger()
                self.assertEqual([c.args[0]["kind"] for c in logged.call_args_list], ["ping"] if pinged else [],
                                 "keep-warm continues after two hours while Claude Code sends requests, not after an idle hour")
                self.assertEqual(slept.call_args_list[0].args, (5,))

    def test_keep_warm_stops_after_an_idle_hour_and_resumes_with_the_next_request(self):
        body = {"model": OPUS, "thinking": {"type": "adaptive"}, "messages": START}
        clock = [0]
        def poll(seconds):
            clock[0] += seconds
            if clock[0] == 5000:
                proxy.State.heard = 4998  # Claude Code sends a request after more than an hour without one
            if clock[0] > 5300:
                raise StopIteration
        with patch.multiple(proxy.State, body=body, headers={}, path="/v1/messages", touched=0, heard=0), \
                patch.object(proxy.time, "time", side_effect=lambda: clock[0]), patch.object(proxy.time, "sleep", side_effect=poll), \
                patch.object(proxy, "upstream") as upstream, patch.object(proxy, "log") as logged:
            upstream.return_value.getresponse.return_value.status = 200
            upstream.return_value.getresponse.return_value.read.return_value = b'{}'
            with self.assertRaises(StopIteration):
                proxy.pinger()
        # Pings do not renew the window: the 13th, at 3510 s, is the last within the hour.
        self.assertEqual([c.args[0]["at"] for c in logged.call_args_list], [270 * k for k in range(1, 14)] + [5000, 5270])

    def test_zero_ping_interval_turns_keep_warm_off_and_the_idle_cap_is_configurable(self):
        script = "import ccsave; print(ccsave.PING_S, ccsave.PING_IDLE_CAP_S)"
        for env, expected in (({}, "270.0 3600.0"), ({"CCSAVE_PING_S": "0", "CCSAVE_PING_IDLE_CAP_S": "10800"}, "0.0 10800.0")):
            result = subprocess.run([sys.executable, "-B", "-c", script], cwd=HERE, env=dict(TEST_ENV, **env),
                                    capture_output=True, text=True, check=True)
            self.assertEqual(result.stdout.split(), expected.split())
        body = {"model": OPUS, "thinking": {"type": "adaptive"}, "messages": START}
        for interval, pings in ((0, 0), (270, 1)):
            with self.subTest(interval=interval), patch.object(proxy, "PING_S", interval), \
                    patch.multiple(proxy.State, body=body, headers={}, path="/v1/messages", touched=0, heard=time.time()), \
                    patch.object(proxy.time, "sleep", side_effect=[None, None, StopIteration]), \
                    patch.object(proxy, "upstream", side_effect=OSError) as upstream, patch.object(proxy, "log"):
                with self.assertRaises(StopIteration):
                    proxy.pinger()
                self.assertEqual(upstream.call_count, pings, f"CCSAVE_PING_S={interval}")

    def test_keep_warm_cost_is_subtracted_and_an_unknown_cost_marks_the_estimate_partial(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp, "saved.json")
            data = {"current_model": OPUS, "baseline_cost": 0.5, "cheap_cost": 0.1, "judge_note_cost": 0.01, "ping_cost": 0.0,
                    "estimated_saved": 0.39, "unpriced_models": [], "unpriced_pings": 0}
            status = lambda: subprocess.run([HERE + "/statusline.sh"], env=dict(TEST_ENV, CCSAVE_SAVED_FILE=str(path)),
                                            capture_output=True, text=True, check=True).stdout
            with patch.object(proxy.Saving, "data", data), patch.object(proxy, "SAVED_FILE", str(path)):
                proxy.account({"kind": "ping", "status": 200, "model": OPUS,
                               "usage": {"input_tokens": 3, "cache_read_input_tokens": 200000, "output_tokens": 2}})
                ping = (3 * 4 + 200000 * .2 + 2 * 20) / 1e6  # about $0.04: a cache read of a 200k-token context
                self.assertAlmostEqual(data["ping_cost"], ping)
                self.assertAlmostEqual(data["estimated_saved"], 0.5 - 0.1 - 0.01 - ping)
                proxy.account({"kind": "ping", "status": 429})  # an error answer has no usage and is not charged
                self.assertEqual(data["unpriced_pings"], 0)
                self.assertEqual(status(), f"⚡ SoL-Pi · {OPUS} · ~$0.35 saved after $0.04 keep-warm\n")
                for sent in ({"kind": "ping", "status": 200}, {"kind": "ping", "error": "TimeoutError"}):
                    proxy.account(sent)  # possibly billed, but no usage came back
                self.assertEqual(data["unpriced_pings"], 2)
                self.assertAlmostEqual(data["ping_cost"], ping)
                self.assertEqual(status(), f"⚡ SoL-Pi · {OPUS} · ~$0.35 saved after $0.04 keep-warm (partial estimate)\n")

    def test_a_late_ping_is_charged_to_its_own_conversation(self):
        body = {"model": OPUS, "thinking": {"type": "adaptive"}, "messages": START}
        reply = json.dumps({"usage": {"input_tokens": 50, "output_tokens": 7}, "model": OPUS}).encode()
        for same in (True, False):  # a new generation of the same conversation, or another conversation, while the ping is out
            own = dict(proxy.Saving.data, ledger_id="a", ping_cost=0.0, unpriced_models=[])
            newer = dict(own, ledger_id="a" if same else "b", unpriced_models=[])
            def answer():
                proxy.Saving.data = newer
                return reply
            with self.subTest(same=same), patch.object(proxy.Saving, "data", own), patch.object(proxy, "SAVED_FILE", ""), \
                    patch.multiple(proxy.State, body=body, headers={}, path="/v1/messages", touched=0, heard=time.time()), \
                    patch.object(proxy.time, "sleep", side_effect=[None, StopIteration]), patch.object(proxy, "upstream") as upstream:
                upstream.return_value.getresponse.return_value.status = 200
                upstream.return_value.getresponse.return_value.read.side_effect = answer
                with self.assertRaises(StopIteration):
                    proxy.pinger()
                charged, spared = (newer, own) if same else (own, newer)
                self.assertAlmostEqual(charged["ping_cost"], proxy.cost(OPUS, {"input_tokens": 50, "output_tokens": 7}))
                self.assertEqual(spared["ping_cost"], 0)

    def test_haiku_is_priced_by_prompt_length(self):
        haiku = "claude-haiku-5-5"
        usage = {"input_tokens": 40000, "cache_read_input_tokens": 40000, "cache_creation_input_tokens": 20000,
                 "cache_creation": {"ephemeral_1h_input_tokens": 5000}, "output_tokens": 200000}  # a 100,000-token prompt
        self.assertAlmostEqual(proxy.cost(haiku, usage), (40000 * .1 + 200000 * .5 + 40000 * .01 + 15000 * .125 + 5000 * .2) / 1e6)
        longer = dict(usage, input_tokens=40001)  # 100,001 tokens: the whole request at the second row
        self.assertAlmostEqual(proxy.cost(haiku, longer), (40001 * .5 + 200000 * 2.5 + 40000 * .05 + 15000 * .625 + 5000 * 1) / 1e6)
        self.assertAlmostEqual(proxy.cost(OPUS, longer), (40001 * 4 + 200000 * 20 + 40000 * .2 + 15000 * 5 + 5000 * 8) / 1e6)
        self.assertAlmostEqual(proxy.cost("claude-sonnet-5-5", longer), (40001 * 2 + 200000 * 10 + 40000 * .1 + 15000 * 2.5 + 5000 * 4) / 1e6)

    def test_price_overrides_take_one_row_or_two(self):
        code = "import ccsave; print(ccsave.cost('claude-haiku-5-5', {'input_tokens': 100001}))"
        def run(prices):
            return subprocess.run([sys.executable, "-B", "-c", code], cwd=HERE, capture_output=True, text=True,
                                  env=dict(TEST_ENV, CCSAVE_PRICES=json.dumps({"claude-haiku-5-5": prices})))
        row = [1, 5, .1, 1.25, 2]
        self.assertEqual(run(row).stdout, "0.100001\n", "one row prices every prompt length")
        self.assertEqual(run([row, [2, 10, .2, 2.5, 4]]).stdout, "0.200002\n")
        for bad in (row[:4], [row], [row] * 3, [row, row[:4]], [row, [1, 5, .1, 1.25, True]], [row, [1, 5, -.1, 1.25, 2]], [[row, row], row]):
            result = run(bad)
            self.assertNotEqual(result.returncode, 0, bad)
            self.assertIn("CCSAVE_PRICES must map model ids to five non-negative, finite token prices, or to two such lists", result.stderr)



if __name__ == "__main__":
    unittest.main()
