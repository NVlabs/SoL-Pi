# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: MIT
"""Offline Responses proxy tests. Run: python3 test_proxy.py"""
import concurrent.futures
from contextlib import closing
import copy
import gzip
import http.client
import http.server
import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock
import ccsave
import savings
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from ccsave import GUIDELINES, BRIEF, RETURN_INSTRUCTIONS, reason_of, CHEAP_NOTE, NOTE_HEAD, decision, task_of, text_of, transcript, view  # noqa: E402

CHEAP = "gpt-6-luna"  # explicit offline fixture; never inherit the production environment


def wait_for(check, timeout=10):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        threading.Event().wait(0.01)
    raise AssertionError("timed out waiting for expected state")


TOOLS = {"type": "additional_tools", "role": "developer", "tools": [{"type": "custom", "name": "exec"}]}
DEV = {"type": "message", "role": "developer", "content": [{"type": "input_text", "text": "You are Codex."}]}
def user(t): return {"type": "message", "role": "user", "content": [{"type": "input_text", "text": t}]}
def step(i, out="ok"):
    return [{"type": "reasoning", "encrypted_content": f"r{i}"},
            {"type": "custom_tool_call", "call_id": f"c{i}", "name": "exec", "input": f"await tools.exec_command({{cmd: 'step {i}'}})"},
            {"type": "custom_tool_call_output", "call_id": f"c{i}", "output": [{"type": "input_text", "text": f"Script completed\nOutput:\n{out} {i}"}]}]
START = [TOOLS, DEV, user("<environment_context>cwd</environment_context>"), user("Make the tests pass.")]
REASON = "The tests pass; run the planned parameter sweep and report the best setting."
NOTE = "Done: ran the tests, 3 passed."
SEEN = []


class Gateway(http.server.BaseHTTPRequestHandler):
    """Streams the agent's requests; answers judges with an approval and note requests with NOTE."""
    protocol_version = "HTTP/1.1"
    approve = True
    errors = {}
    hold = None
    holds = {}
    stream_gate = None
    side_delay = 0
    answers = {}
    encodings = []

    def log_message(self, *a):
        pass

    def do_POST(self):
        self.close_connection = True
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        SEEN.append(body)
        Gateway.encodings.append(self.headers.get("accept-encoding"))
        ask = next((text_of(it) for it in body["input"] if it.get("type") == "message" and it.get("role") == "developer"), "")
        kind = ("handoff" if ask.startswith("You decide when a coding agent may hand") else
                "handback" if ask.startswith("You decide when a coding agent should give") else
                "note" if ask.startswith("You write a hand-off note") else "cheap" if body.get("model") == CHEAP else "request")
        failures = Gateway.errors.get(kind, [])
        failure = failures.pop(0) if failures else None
        if kind in ("handoff", "handback"):
            Gateway.answers.setdefault(kind, []).append(Gateway.approve if failure is None else kind == "handback")
        if kind == "handoff" and Gateway.hold is not None:
            Gateway.hold.wait(10)
        if kind in Gateway.holds:
            entered, release = Gateway.holds.pop(kind)
            entered.set()
            release.wait(10)
        if kind in ("handoff", "handback", "note") and Gateway.side_delay:
            threading.Event().wait(Gateway.side_delay)
        if failure == "disconnect":
            self.close_connection = True
            return
        if failure == "broken-stream":
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.send_header("transfer-encoding", "chunked")
            self.end_headers()
            self.wfile.write(b"20\r\npartial")
            self.wfile.flush()
            self.close_connection = True
            return
        if failure in ('held-503', 'held-408'):
            self.send_response(int(failure[-3:]))
            self.send_header("content-length", "100")
            self.end_headers()
            Gateway.stream_gate.wait(5)
            return
        if isinstance(failure, int):
            out = json.dumps({"output": [{"type": "message", "content": [{"text": '{"handoff": true, "handback": false}'}]}], "usage": {"input_tokens": 1000, "input_tokens_details": {"cached_tokens": 600}, "output_tokens": 20}}).encode()
            self.send_response(failure)
            self.send_header("content-length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)
            return
        if body.get("stream") and failure != "json-failed":
            done = {"type": "response.completed", "response": {"model": body["model"], "usage": {"input_tokens": 100, "output_tokens": 5}}}
            if failure in ("response.failed", "error"):
                done["type"] = failure
            if failure == "delta-broken":
                done = {"type": "response.output_text.delta", "delta": "first bytes"}
            parts = []
            if failure == "no-final-usage":
                parts.append(b'data: {"type":"response.in_progress","response":{"usage":{"input_tokens":99}}}\n\n')
                done["response"]["usage"] = None
            parts.append(b"event: " + done["type"].encode() + b"\ndata: " + json.dumps(done).encode() + b"\n\n")
            if failure == 'cr-only':
                parts = [part.replace(b'\n', b'\r') for part in parts]
            self.send_response(201 if failure == 'created-201' else 200)
            self.send_header("content-type", "text/event-stream")
            if failure in ('gzip', 'gzip-members'):
                self.send_header("content-encoding", "gzip")
                parts = [gzip.compress(b"".join(parts))]
                if failure == 'gzip-members':
                    member = gzip.compress(b'data: {"type":"response.created"}\r\n\r\n')
                    parts = [member[:-2], member[-2:] + parts[0][:5], parts[0][5:]]
            if failure == "keepalive":
                self.close_connection = False
            self.send_header("transfer-encoding", "chunked")
            self.end_headers()
            for part in parts:
                self.wfile.write(b"%x\r\n%s\r\n" % (len(part), part))
            self.wfile.flush()
            if failure == "complete-held":
                Gateway.stream_gate.wait(10)
            if failure in ("delta-broken", "complete-broken"):
                self.close_connection = True
                return
            self.wfile.write(b"0\r\n\r\n")
            if failure == "keepalive":
                if not self.rfile.read(1):
                    Gateway.stream_gate.set()
                self.close_connection = True
            return
        ask = next((text_of(it) for it in body["input"] if it.get("type") == "message" and it.get("role") == "developer"), "")
        text = (json.dumps({"handoff": Gateway.approve, "reason": REASON}) if ask.startswith("You decide when a coding agent may hand") else
                json.dumps({"handback": Gateway.approve}) if ask.startswith("You decide when a coding agent should give") else
                NOTE if ask.startswith("You write a hand-off note") else "ok")
        if failure in ("invalid", "empty"):
            text = "not a judgement" if failure == "invalid" else ""
        status = "failed" if failure == "json-failed" else "incomplete" if failure == "incomplete" else "completed"
        out = json.dumps({"status": status, "output": [{"type": "message", "content": [{"type": "output_text", "text": text}]}],
                          "usage": {"input_tokens": 50, "output_tokens": 7}}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        if failure == 'side-held':
            self.send_header('transfer-encoding', 'chunked')
            self.end_headers()
            for part in (out[:20], out[20:]):
                self.wfile.write(b'%x\r\n%s\r\n' % (len(part), part))
            self.wfile.flush()
            Gateway.stream_gate.wait(5)
            return
        self.send_header("content-length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


class Rules(unittest.TestCase):
    def test_transcript_task_view_and_decision(self):
        items = START + step(1, "x" * 5000) + [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Done."}]}]
        t = transcript(items, 40000)
        self.assertIn("=== T1 ===\n[tool call exec]", t)
        self.assertIn("chars omitted", t, "a long result is clipped")
        self.assertIn("[assistant]\nDone.", t)
        self.assertNotIn("r1", t, "encrypted reasoning is left out")
        self.assertLessEqual(len(transcript(items * 20, 3000)), 3100, "the head and tail of a long range")
        self.assertEqual(task_of(items), "Make the tests pass.", "the task, not Codex's environment context")
        st = [{"a": 4, "b": 7, "note": "N"}, {"a": 7, "b": 10, "note": None}]
        items = START + step(1) + step(2) + step(3)
        prefix = ccsave.marks(items)
        st[0]['content'] = ccsave.digest(prefix[4:7])
        v = view(items, st, prefix)
        self.assertEqual(v[:4], START)
        self.assertEqual(v[4]["content"][0]["text"], f"{NOTE_HEAD}\n\nN")
        self.assertEqual(v[5:], step(2) + step(3), "a stint without a note goes as it is")
        self.assertTrue(decision('Sure: {"handoff": true, "reason": "x"}', "handoff"))
        self.assertIsNone(decision("no json", "handoff"))
        self.assertIsNone(decision('{"handoff": "yes"}', "handoff"))


class ProxyCase(unittest.TestCase):
    every = 2
    def start(self):
        portfile = self.log + ".port"
        if os.path.exists(portfile):
            os.remove(portfile)
        env = dict({k: v for k, v in os.environ.items() if not k.startswith("CCSAVE_")}, CCSAVE_UPSTREAM=f"http://127.0.0.1:{self.gw.server_address[1]}", CCSAVE_PORT_FILE=portfile,
                   CCSAVE_LOG=self.log, CCSAVE_CHEAP_MODEL=CHEAP, CCSAVE_JUDGE_EVERY=str(self.every), CCSAVE_PING_S="1")
        env.update(getattr(self, "extra_env", {}))
        self.shell = subprocess.Popen([sys.executable, "-I", HERE + "/ccsave.py"], env=env)
        wait_for(lambda: os.path.exists(portfile))
        self.port = int(Path(portfile).read_text())

    def setUp(self):
        SEEN.clear()
        Gateway.approve = True
        Gateway.errors = {}
        Gateway.answers = {}
        Gateway.hold = None
        Gateway.holds = {}
        Gateway.stream_gate = None
        Gateway.side_delay = 0
        self.gw = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Gateway)
        threading.Thread(target=self.gw.serve_forever, daemon=True).start()
        self.tmp = tempfile.TemporaryDirectory()
        self.log = self.tmp.name + "/ccsave.jsonl"
        self.start()

    def tearDown(self):
        self.shell.terminate()
        self.shell.wait(timeout=5)
        self.gw.shutdown()
        self.gw.server_close()
        self.tmp.cleanup()

    def state(self):
        path = Path(self.log + ".state")
        return json.loads(path.read_text()) if path.exists() else {}

    def post(self, items, key="k", **kw):
        before = self.state().get(key, {})
        counts = {kind: len([r for r in self.logged("side") if r["what"] == kind]) for kind in ("handoff", "handback")}
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        data = json.dumps(dict({"model": "sol", "prompt_cache_key": key, "stream": True, "tool_choice": "auto", "input": items}, **kw)).encode()
        c.request("POST", "/v1/responses", body=data, headers={"content-type": "application/json"})
        r = c.getresponse()
        self.assertEqual(r.status, 200)
        r.read()
        c.close()
        st = self.state().get(key, {})
        kind = "handback" if st.get("cheap") else "handoff"
        count, judged = ("back_calls", "back_judged") if kind == "handback" else ("calls", "judged")
        if (Gateway.hold is None and st.get(judged) is not None and st.get(count) == st[judged]
                and (st[judged] != before.get(judged) or st.get("generation") != before.get("generation"))):
            wait_for(lambda: [r for r in self.logged("side") if r["what"] == kind][counts[kind]:])
            if Gateway.answers[kind][-1]:
                wait_for(lambda: self.state()[key].get("want") == kind)
        sent = [b for b in SEEN if b.get("stream")][-1]
        return dict(sent, input=[it for it in sent["input"] if it != GUIDELINES])

    def logged(self, kind):
        path = Path(self.log)
        lines = path.read_text().splitlines(keepends=True) if path.exists() else []
        return [r for r in (json.loads(line) for line in lines if line.endswith("\n")) if r.get("kind") == kind]

class Through(ProxyCase):
    def test_a_stint_is_judged_in_and_out_and_its_note_replaces_it_for_both_models(self):
        h = START + step(1)
        self.assertEqual(self.post(START)["model"], "sol")
        self.assertEqual(self.post(h)["model"], "sol", "the judge approves now; the switch comes at the next request")
        h += step(2)
        sent = self.post(h)
        self.assertEqual(sent["model"], CHEAP)
        self.assertEqual(sent["input"][:3], [TOOLS, DEV, CHEAP_NOTE], "the cheap model's note after Codex's instructions")
        a = len(h)
        h += step(3)
        self.assertEqual(self.post(h)["model"], CHEAP, "its second request: the return judge approves")
        h += step(4)
        b = len(h)
        sent = self.post(h)
        self.assertEqual(sent["model"], "sol")
        self.assertEqual(sent["input"][:a], h[:a], "the configured model's own context unchanged")
        self.assertEqual(sent["input"][a:], [user(f"{NOTE_HEAD}\n\n{NOTE}")], "the stint goes as its note")
        h += step(5)
        Gateway.approve = False  # the next hand-off judge (the configured model's 4th request) says no
        self.assertEqual(self.post(h)["input"][a + 1:], h[b:], "later requests carry the note too")
        sides = self.logged("side")
        self.assertEqual([s["what"] for s in sides], ["handoff", "handback", "note", "handoff"])
        self.assertTrue(all(s["usage"] == {"input_tokens": 50, "output_tokens": 7} and s["model"] == CHEAP for s in sides))
        note_req = [x for x in SEEN if not x.get("stream") and text_of(x["input"][0]).startswith("You write a hand-off note")][-1]
        self.assertIn("step 3", note_req["input"][1]["content"][0]["text"], "the note is written from the stint's steps")
        self.assertNotIn("step 2", note_req["input"][1]["content"][0]["text"])
        # A compaction (Codex leaves out the tool item) runs on the configured model with the note in place of the stint.
        sent = self.post(h[1:] + [user("You are performing a CONTEXT CHECKPOINT COMPACTION.")])
        self.assertEqual((sent["model"], sent["tool_choice"], sent["input"][0]), ("sol", "none", TOOLS))
        self.assertEqual(sent["input"][a], user(f"{NOTE_HEAD}\n\n{NOTE}"))
        # The compacted history is new: nothing is replaced in it.
        new = [TOOLS, DEV, user("Make the tests pass."), user("summary")]
        self.assertEqual(self.post(new)["input"], new)

    def test_a_message_ends_the_stint_and_the_state_survives_a_restart(self):
        h = START + step(1)
        self.post(START), self.post(h)
        h += step(2)
        Gateway.approve = False  # the return judge keeps the cheap model
        self.assertEqual(self.post(h)["model"], CHEAP)
        a = len(h)
        h += [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "All done."}]}]
        k = len(h)
        h += [user("<hook_prompt>Do not stop.</hook_prompt>")]
        sent = self.post(h)
        self.assertEqual(sent["model"], "sol", "the cheap model ended its turn")
        self.assertEqual(sent["input"][a:], [user(f"{NOTE_HEAD}\n\n{NOTE}"), h[k]])
        self.assertEqual([s["why"] for s in self.logged("switch") if "why" in s], ["message"])
        self.shell.terminate()
        self.shell.wait(timeout=5)
        self.start()  # Codex restarted: a new proxy, maybe a new key
        h += step(6)
        sent = self.post(h, key="k2")
        self.assertEqual((sent["model"], sent["input"][a]), ("sol", user(f"{NOTE_HEAD}\n\n{NOTE}")))

    def test_the_configured_model_is_kept_warm_while_the_cheap_model_works(self):
        h = START + step(1)
        self.post(START), self.post(h)
        Gateway.approve = False
        h += step(2)
        self.post(h)  # on the cheap model now
        pings = wait_for(lambda: self.logged("ping"))
        self.assertTrue(pings and all(p["model"] == "sol" and p["status"] == 200 for p in pings))
        ping = [x for x in SEEN if not x.get("stream") and x["input"][-1].get("type") == "configuration_update"][-1]
        self.assertEqual((ping["model"], ping["tool_choice"], [it for it in ping["input"] if it != GUIDELINES][:len(START) + 3]), ("sol", "none", START + step(1)))


def script(i, n): return [{"type": "custom_tool_call", "call_id": f"c{i}", "name": "exec", "input": " ".join(f"text(await tools.exec_command({{cmd:'cat f{k}'}}));" for k in range(n))},
                          {"type": "custom_tool_call_output", "call_id": f"c{i}", "output": [{"type": "input_text", "text": "Script completed\nOutput:\nok"}]}]


class Cadence(ProxyCase):
    every = 4

    def test_tool_free_requests_each_count_once(self):
        for _ in range(self.every):
            self.post(START)
        state = self.state()["k"]
        self.assertEqual((state["calls"], state["judged"], state["want"]), (self.every, self.every, "handoff"))

    def test_a_script_counts_its_tool_calls(self):
        self.post(START)  # 1
        self.assertEqual(self.logged("side"), [], "1 of 4")
        self.post(START + script(1, 3))  # 1 + 3 tool calls: the judge looks now
        self.assertEqual([s["what"] for s in self.logged("side")], ["handoff"])


class QuickLook(ProxyCase):
    every = 4

    def test_the_judge_looks_after_the_first_call_back(self):
        h = START + script(1, 4)
        self.post(START)
        self.post(h)  # 4 calls: the judge looks and approves
        self.assertEqual([s["what"] for s in self.logged("side")], ["handoff"])
        h += script(2, 1)
        self.assertEqual(self.post(h)["model"], CHEAP, "the stint begins")
        h += script(3, 1) + [user("Continue working on the task.")]  # the cheap model ended its turn; the stop hook answers
        self.assertEqual(self.post(h)["model"], "sol", "the work comes back")
        looks = len([s for s in self.logged("side") if s["what"] == "handoff"])
        h += script(4, 1)
        self.post(h)  # the strong model's first call after the return: the judge looks now, not after 4 more
        self.assertEqual(len([s for s in self.logged("side") if s["what"] == "handoff"]), looks + 1)


class Brief(ProxyCase):
    def post(self, *args, **kw):
        super().post(*args, **kw)
        return [b for b in SEEN if b.get("stream")][-1]

    def test_reason_parsing_and_return_prompt_contract(self):
        self.assertEqual(reason_of('{"handoff": true, "reason": " run it "}'), "run it")
        self.assertIsNone(reason_of('{"handoff": true}'))
        self.assertIsNone(reason_of("no json"))
        self.assertIn("Look again only at what your next decision depends on", NOTE_HEAD)
        self.assertIn("the steps it took over are done", RETURN_INSTRUCTIONS)
        self.assertIn("End your turn with a short report", CHEAP_NOTE["content"][0]["text"])

    def test_the_cheap_model_gets_the_judges_reason_where_its_stint_begins(self):
        h = START + step(1)
        self.post(START)
        self.post(h)  # the judge approves, with its reason
        h += step(2)
        a = len(h)
        sent = self.post(h)
        brief = {"type": "message", "role": "developer", "content": [{"type": "input_text", "text": BRIEF.format(REASON)}]}
        self.assertEqual(sent["model"], CHEAP)
        self.assertEqual(sent["input"][:3], [TOOLS, DEV, CHEAP_NOTE])
        self.assertEqual(sent["input"][a + 2], brief, "the brief where the stint begins (the guidelines and the cheap note come first)")
        h += step(3)
        again = self.post(h)
        self.assertEqual(again["input"][:a + 3], sent["input"][:a + 3], "the same prefix through the stint")
        self.assertEqual(again["input"][a + 3:], step(3), "the stint's own steps after the brief")
        h += step(4)
        back = self.post(h)  # the mock return judge approves: the work goes back with the note
        self.assertEqual(back["model"], "sol")
        self.assertEqual(back["input"][a + 1:], [user(f"{NOTE_HEAD}\n\n{NOTE}")], "no brief in the strong model's view (after the guidelines)")
        state = json.loads(Path(self.log + ".state").read_text())
        self.assertIsNone(next(iter(state.values())).get("brief"), "the stint's end clears the brief")


class Review(ProxyCase):
    def stint(self):
        self.post(START)
        h = START + step(1)
        self.post(h)
        h += step(2)
        self.assertEqual(self.post(h)["model"], CHEAP)
        return h

    def test_new_user_or_developer_message_drops_approval(self):
        for role in ("user", "developer"):
            with self.subTest(role=role):
                key = role
                self.post(START, key=key)
                h = START + step(1)
                self.post(h, key=key)
                instruction = dict(user("Change the approach."), role=role)
                self.assertEqual(self.post(h + step(2) + [instruction], key=key)["model"], "sol")

    def test_delayed_approval_cannot_cross_new_instruction(self):
        Gateway.hold = hold = threading.Event()
        self.post(START)
        self.post(START + step(1))
        h = START + step(1) + [user("Use a different approach.")]
        self.assertEqual(self.post(h)["model"], "sol")
        hold.set()
        wait_for(lambda: self.logged("side"))
        self.assertEqual(self.post(h + step(2))["model"], "sol")

    def test_pre_response_failures_fall_back_and_retries_stay_on_sol(self):
        for failure in (401, 403, 429, 500, 503, "disconnect"):
            with self.subTest(failure=failure):
                key = str(failure)
                self.post(START, key=key)
                h = START + step(1)
                self.post(h, key=key)
                h += step(2)
                self.assertEqual(self.post(h, key=key)["model"], CHEAP)
                a = len(h)
                h += step(3)
                Gateway.errors["cheap"] = [failure]
                sent = self.post(h, key=key)
                self.assertEqual(sent["model"], "sol")
                self.assertEqual(sent["input"][a:], [user(f"{NOTE_HEAD}\n\n{NOTE}")])
                if isinstance(failure, int):
                    billed = wait_for(lambda: [r for r in self.logged("request") if r.get("cheap") and r.get("status") == failure])
                    self.assertEqual(billed[-1]["usage"]["input_tokens"], 1000)
                cheap_count = len([b for b in SEEN if b.get("stream") and b["model"] == CHEAP])
                for _ in range(3):
                    self.assertEqual(self.post(h, key=key)["model"], "sol")
                self.assertEqual(len([b for b in SEEN if b.get("stream") and b["model"] == CHEAP]), cheap_count)

    def test_failed_note_retries_later_and_survives_restart(self):
        h = self.stint()
        a = len(h)
        h += step(3) + [user("Please continue.")]
        Gateway.errors["note"] = [503]
        sent = self.post(h)
        self.assertEqual(sent["input"][a:], h[a:], "raw stint stays until a note exists")
        self.assertEqual(len([s for s in self.logged("side") if s["what"] == "note"]), 1)
        self.shell.terminate()
        self.shell.wait(timeout=5)
        self.start()
        Gateway.approve = False
        sent = self.post(h + step(4))
        self.assertEqual(sent["input"][a], user(f"{NOTE_HEAD}\n\n{NOTE}"))
        self.assertEqual(sent["input"][a + 1:], h[-1:] + step(4))
        self.assertEqual(len([s for s in self.logged("side") if s["what"] == "note"]), 2)

    def test_failed_notes_stop_after_three_attempts(self):
        h = self.stint()
        a = len(h)
        h += step(3) + [user("Please continue.")]
        Gateway.errors["note"] = [503] * 10
        Gateway.approve = False
        for _ in range(5):
            self.assertEqual(self.post(h)["input"][a:], h[a:])
        self.assertEqual(len([s for s in self.logged("side") if s["what"] == "note"]), 3)

    def test_return_judge_receives_stint_brief(self):
        h = self.stint()
        self.post(h + step(3))
        request = [b for b in SEEN if not b.get("stream") and text_of(b["input"][0]).startswith("You decide when a coding agent should give")][-1]
        self.assertIn(REASON, text_of(request["input"][1]))

    def test_failed_return_judge_returns_on_next_request(self):
        for failure in ("invalid", "empty", 503, "disconnect"):
            with self.subTest(failure=failure):
                key = str(failure)
                self.post(START, key=key)
                h = START + step(1)
                self.post(h, key=key)
                h += step(2)
                self.assertEqual(self.post(h, key=key)["model"], CHEAP)
                Gateway.errors["handback"] = [failure]
                h += step(3)
                self.assertEqual(self.post(h, key=key)["model"], CHEAP)
                self.assertEqual(self.post(h + step(4), key=key)["model"], "sol")

    def test_failed_handoff_judge_changes_nothing(self):
        for failure in ("invalid", "empty", 503, "disconnect"):
            with self.subTest(failure=failure):
                key = str(failure)
                self.post(START, key=key)
                Gateway.errors["handoff"] = [failure]
                self.post(START + step(1), key=key)
                self.assertEqual(self.post(START + step(1) + step(2), key=key)["model"], "sol")


class ConversationIdentity(unittest.TestCase):
    def state(self, prefix):
        items = prefix + step(1)
        return dict(ccsave.new_conv(), n=len(items), history=ccsave.digest(ccsave.marks(items)), top=ccsave.digest(None))

    def test_shared_tail_requires_task_match(self):
        other = START[:-1] + [user("A different task.")]
        a, b = self.state(START), self.state(other)
        with mock.patch.dict(ccsave.State.convs, {"a": a, "b": b}, clear=True):
            self.assertIs(adopt("new", other + step(1) + step(2)), b)
            self.assertNotIn("b", ccsave.State.convs, "adoption moves the state, no stale alias")

    def test_ambiguous_continuations_start_fresh(self):
        a, b = self.state(START), self.state(START)
        with mock.patch.dict(ccsave.State.convs, {"a": a, "b": b}, clear=True):
            new = adopt("new", START + step(1) + step(2))
            self.assertIsNot(new, a)
            self.assertIsNot(new, b)
            self.assertEqual(new["n"], 0)

    def test_long_tasks_with_shared_prefix_stay_separate(self):
        first = START[:-1] + [user("x" * 5000 + " first task")]
        second = START[:-1] + [user("x" * 5000 + " second task")]
        a = self.state(first)
        with mock.patch.dict(ccsave.State.convs, {"a": a}, clear=True):
            self.assertIsNot(adopt("new", second + step(1)), a)


class Configuration(ProxyCase):
    def test_suppressed_text_waits_until_approval_is_visible(self):
        self.shell.terminate()
        self.shell.wait(timeout=5)
        self.extra_env = {"CCSAVE_LOG_TEXT": "0"}
        self.start()
        self.post(START)
        read = self.state
        observations = []
        def delayed():
            snapshot = read()
            if snapshot["k"]["judged"] is not None:
                observations.append(True)
                if len(observations) <= 2:
                    snapshot["k"]["want"] = None
            return snapshot
        with mock.patch.object(self, "state", delayed):
            self.post(START + step(1))
        self.assertGreater(len(observations), 2)

    def test_log_has_judge_answers_and_note_text(self):
        h = Review.stint(self)
        self.post(h + step(3) + [user("Continue.")])
        sides = self.logged("side")
        self.assertTrue(any(REASON in r.get("text", "") for r in sides))
        self.assertTrue(any(r.get("text") == NOTE for r in sides))
        self.assertNotIn("Bearer", Path(self.log).read_text())

    def test_log_text_zero_omits_text_but_keeps_usage(self):
        self.shell.terminate()
        self.shell.wait(timeout=5)
        self.extra_env = {"CCSAVE_LOG_TEXT": "0"}
        self.start()
        h = Review.stint(self)
        self.post(h + step(3) + [user("Continue.")])
        sides = self.logged("side")
        self.assertEqual({r["what"] for r in sides}, {"handoff", "note"})
        self.assertTrue(all("text" not in r and "usage" in r for r in sides))
        self.assertNotIn(NOTE, Path(self.log).read_text())
        self.assertIn(NOTE, Path(self.log + ".state").read_text(), "state still needs the note")

    def test_empty_cheap_model_setting_disables_handoff(self):
        self.shell.terminate()
        self.shell.wait(timeout=5)
        self.extra_env = {"CCSAVE_CHEAP_MODEL": ""}
        self.start()
        for i in range(4):
            self.assertEqual(self.post(START + step(i))["model"], "sol")
        self.assertEqual(self.logged("side"), [])


class Startup(unittest.TestCase):
    def test_invalid_ports_never_publish_readiness(self):
        with tempfile.TemporaryDirectory() as tmp:
            for port in ("xyz", "65536", "0", ""):
                env = dict(os.environ, CCSAVE_UPSTREAM="http://127.0.0.1:" + port, CCSAVE_PORT_FILE=tmp + "/port")
                with self.subTest(port=port):
                    proc = subprocess.run([sys.executable, "-I", HERE + "/ccsave.py"], capture_output=True, env=env, timeout=2)
                    self.assertNotEqual(proc.returncode, 0)
                    self.assertFalse(Path(env["CCSAVE_PORT_FILE"]).exists())

    def test_cheap_model_setting_wins_over_file(self):
        env = dict(os.environ, CCSAVE_CHEAP_MODEL="custom-model", PYTHONDONTWRITEBYTECODE="1")
        r = subprocess.run([sys.executable, "-c", "import ccsave; print(ccsave.CHEAP)"], cwd=HERE, env=env,
                           capture_output=True, text=True, check=True)
        self.assertEqual(r.stdout.strip(), "custom-model")

    def test_upstream_required_before_listening(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = {k: v for k, v in os.environ.items() if not k.startswith("CCSAVE_")}
            env["CCSAVE_PORT_FILE"] = tmp + "/port"
            p = subprocess.Popen([sys.executable, "-I", HERE + "/ccsave.py"], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                out, err = p.communicate(timeout=2)
            except subprocess.TimeoutExpired:
                p.kill()
                p.communicate()
                self.fail("proxy must fail at startup when CCSAVE_UPSTREAM is unset")
            self.assertNotEqual(p.returncode, 0)
            self.assertIn("CCSAVE_UPSTREAM is required", err)
            self.assertFalse(Path(env["CCSAVE_PORT_FILE"]).exists())


def request(items, key="k"):
    return {"model": "sol", "prompt_cache_key": key, "stream": True, "input": items}


def adopt(key, items, top=None):
    return ccsave.conv_of(key, ccsave.marks(items), ccsave.digest(top))


class Routing(unittest.TestCase):
    def setUp(self):
        for name, value in (("convs", {}), ("mains", {}), ("routing", {}), ("judging", set()), ("accepted", {})):
            patch = mock.patch.object(ccsave.State, name, value, create=True)
            patch.start()
            self.addCleanup(patch.stop)
        for name, value in (("CHEAP", CHEAP), ("JUDGE_EVERY", 1000), ("STATE_FILE", ""), ("LOG", "")):
            patch = mock.patch.object(ccsave, name, value)
            patch.start()
            self.addCleanup(patch.stop)
        self.side = mock.patch.object(ccsave, "side", return_value=NOTE).start()
        self.addCleanup(mock.patch.stopall)

    def route(self, items, key="k", compact=False):
        return ccsave.route(key, request(items, key), {}, "/v1/responses", compact)[0]

    def approve(self, items=START):
        self.route(items)
        st = ccsave.State.convs["k"]
        st.update(want="handoff", approved_instructions=st.get("instructions", ""), brief="Run the tests.")
        return st

    def stint(self):
        st = self.approve()
        h = START + step(1)
        self.assertEqual(self.route(h)["model"], CHEAP)
        return st, h

    def test_matches_full_task_branch_and_top_level_instructions(self):
        items = START[:-1] + [user("<task>First</task>")] + step(1) + step(2)
        st = self.approve(items)
        for idx, replacement in ((3, user("<task>Other</task>")), (5, step(97)[1])):
            changed = list(items)
            changed[idx] = replacement
            self.route(changed, str(idx))
            self.assertIsNot(ccsave.State.convs[str(idx)], st)
        ccsave.route("top", dict(request(items, "top"), instructions="another system prompt"), {}, "/responses", False)
        self.assertIsNot(ccsave.State.convs["top"], st)
        for field, values in (("action", [{"command": "ls"}, {"command": "pwd"}]),
                              ("output", [[{"stdout": "one"}], [{"stdout": "two"}]])):
            tool = {"type": "shell_call" if field == "action" else "shell_call_output"}
            self.assertNotEqual(ccsave.mark(dict(tool, **{field: values[0]})), ccsave.mark(dict(tool, **{field: values[1]})))

    def test_corrected_note_range_is_raw_even_after_failed_note(self):
        for answer in (NOTE, None):
            with self.subTest(answer=answer):
                ccsave.State.convs.clear()
                self.side.return_value = answer
                _, start = self.stint()
                history = start + step(2) + [user('Continue')]
                self.route(history)
                self.side.return_value = 'wrong note'
                changed = start + step(2, 'corrected result') + [history[-1]]
                out = self.route(changed)
                self.assertIn(changed[-2], out['input'])
                self.assertNotIn(NOTE_HEAD, str(out))
                if answer:
                    self.assertIn(NOTE, str(self.route(history)))

    def test_changed_opaque_items_and_reference_targets_do_not_adopt(self):
        for item, field in (({'type': 'compaction'}, 'encrypted_content'), ({'type': 'reasoning'}, 'encrypted_content'),
                            ({'type': 'reasoning'}, 'summary'), ({'type': 'item_reference'}, 'id')):
            with self.subTest(item=item, field=field):
                ccsave.State.convs.clear()
                _, start = self.stint()
                history = start + [dict(item, **{field: 'one'})] + step(2) + [user('Continue')]
                self.assertIn(NOTE, str(self.route(history)))
                history[len(start)][field] = 'two'
                self.assertNotIn(NOTE, str(self.route(history, 'other')))
        ccsave.State.convs.clear()
        first, second = dict(user('one'), id='a'), dict(user('two'), id='b')
        start = START + [first, second]
        self.approve(start)
        self.route(start + step(1))
        history = start + step(1) + [{'type': 'item_reference', 'id': 'a'}] + step(2) + [user('Continue')]
        self.assertIn(NOTE, str(self.route(history)))
        first['id'], second['id'] = 'b', 'a'
        self.assertNotIn(NOTE, str(self.route(history, 'moved-target')))

    def test_parallel_call_pairing_survives_rename_but_not_swap(self):
        _, start = self.stint()
        work = [step(2)[1], step(3)[1], step(2, 'passed')[2], step(3, 'failed')[2]]
        end = [user('Continue')]
        self.route(start + work + end)
        renamed = [dict(it, call_id='new-' + it['call_id']) for it in work]
        self.assertIn(NOTE, str(self.route(start + renamed + end, 'renamed')))
        renamed[-1]['call_id'], renamed[-2]['call_id'] = renamed[-2]['call_id'], renamed[-1]['call_id']
        self.assertNotIn(NOTE, str(self.route(start + renamed + end, 'swapped')))

    def test_call_retained_when_result_follows_instruction(self):
        _, start = self.stint()
        _, call, result = step(2)
        history = start + [call, {'role': 'developer', 'content': 'new instructions'}, result]
        for items in (history, history + step(3)):
            out = self.route(items)['input']
            self.assertIn(NOTE_HEAD, str(out))
            self.assertEqual([it for it in out if it.get('call_id') == call['call_id']], [call, result])

    def test_fallback_status_reserves_before_reading_error_body(self):
        for status in (401, 403, 429, 500, 599):
            with self.subTest(status=status):
                ccsave.State.convs.clear()
                st, start = self.stint()
                items = start + step(2)
                handler = object.__new__(ccsave.Handler)
                raw = json.dumps(request(items)).encode()
                handler.command, handler.path, handler.headers = 'POST', '/responses', {'content-length': len(raw)}
                handler.rfile, handler.relay = io.BytesIO(raw), mock.Mock()
                def read(*args):
                    self.assertTrue(st['retries'])
                    self.assertEqual(self.route(items)['model'], 'sol')
                    return {}
                with mock.patch.object(ccsave, 'upstream') as upstream, mock.patch.object(ccsave, 'read_object', read):
                    error, success = mock.MagicMock(), mock.MagicMock()
                    error.__enter__.return_value.status = status
                    success.__enter__.return_value.status = 200
                    upstream.return_value.getresponse.side_effect = [error, success]
                    handler.forward()
                self.assertEqual(handler.relay.call_count, 1)

    def test_failure_retry_does_not_queue_behind_an_ordinary_note(self):
        _, start = self.stint()
        items = start + step(2)
        binding, req = [], request(items)
        ccsave.route('k', req, {}, '/responses', False, binding)
        entered, release = threading.Event(), threading.Event()
        def write(*args):
            entered.set()
            release.wait(5)
            return NOTE
        self.side.side_effect = write
        with concurrent.futures.ThreadPoolExecutor() as pool:
            ordinary = pool.submit(self.route, items + [user('Continue.')])
            try:
                self.assertTrue(entered.wait(2))
                out = pool.submit(ccsave.handback_now, binding, req, {}, '/responses', 'http-503').result(timeout=1)
                self.assertIn(step(2)[1], out['input'])
                self.assertEqual(pool.submit(self.route, items).result(timeout=1), out)
            finally:
                release.set()
            self.assertIn(NOTE, str(ordinary.result()))

    def test_untyped_user_and_developer_messages_end_or_cancel_handoff(self):
        for role in ("developer", "user"):
            self.approve()
            msg = {"role": role, "content": "Change the plan"}
            self.assertEqual(self.route(START + [msg])["model"], "sol")
            _, items = self.stint()
            self.assertEqual(self.route(items + [msg])["model"], "sol")

    def test_replacement_instruction_remains_visible_after_note(self):
        for role in ("developer", "user"):
            msg = dict(user("Changed instructions"), role=role)
            st, items = self.stint()
            items += step(2)
            self.route(items)
            items[-2] = msg
            out = self.route(items)
            self.assertEqual(out["model"], "sol")
            self.assertIn(msg, out["input"])
            self.assertNotIn(text_of(msg), self.side.call_args.args[2])
            self.assertIn(msg, self.route(items + step(3))["input"])
            self.assertTrue(st["stints"][-1]["note"])

    def test_pending_judge_follows_state_across_key_move(self):
        entered, release = threading.Event(), threading.Event()
        def answer(*args):
            entered.set()
            release.wait(5)
            return '{"handoff":true}'
        self.side.side_effect = answer
        ccsave.JUDGE_EVERY = 1
        self.route(START)
        self.assertTrue(entered.wait(5))
        items = START + [user("continue")]
        try:
            self.route(items, "new")
        finally:
            ccsave.JUDGE_EVERY = 1000
            release.set()
        wait_for(lambda: not ccsave.State.judging)
        self.assertEqual(self.side.call_count, 1)
        self.assertEqual(self.route(items + step(1), "new")["model"], CHEAP)

    def test_compaction_arms_next_judge_and_keeps_handback_reason(self):
        st, items = self.stint()
        st.update(calls=3, judged=3, want="handback")
        ccsave.JUDGE_EVERY = 3
        self.route(items + step(2), compact=True)
        self.assertEqual(st["stints"][-1]["why"], "handback")
        self.side.return_value = '{"handoff":true}'
        self.route(items + step(2) + step(3))
        wait_for(lambda: st["want"] == "handoff")

    def test_failure_is_reserved_before_socket_exposes_event(self):
        st, items = self.stint()
        items += step(2)
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.status = 200
        response.getheader.side_effect = {"content-type": "text/event-stream"}.get
        response.length = None
        response.read1.side_effect = [b'data: {"type":"response.failed"}\n\n', b'']
        handler = object.__new__(ccsave.Handler)
        raw = json.dumps(request(items)).encode()
        handler.command, handler.path, handler.headers = "POST", "/v1/responses", {"content-length": str(len(raw))}
        handler.rfile, handler.wfile = io.BytesIO(raw), mock.Mock()
        handler.send_response_only = handler.send_header = handler.end_headers = mock.Mock()
        def write(data):
            if b"response.failed" in data:
                self.assertFalse(st["cheap"])
                self.assertEqual(self.route(items)["model"], "sol")
        handler.wfile.write.side_effect = write
        with mock.patch.object(ccsave, "upstream") as upstream:
            upstream.return_value.getresponse.return_value = response
            handler.forward()
        self.assertTrue(handler.wfile.write.called)

    def test_late_failure_notes_accepted_history_and_reserves_only_its_prefix(self):
        for already_closed in (True, False):
            ccsave.State.convs.clear()
            st, items = self.stint()
            items += step(2)
            binding = []
            req = request(items)
            ccsave.route("k", req, {}, "/responses", False, binding)
            longer = items + step(3)
            self.side.side_effect = lambda kind, prompt, text, *args: "LATER" if "step 3" in text else "EARLIER"
            self.route(longer, "migrated")
            if already_closed:
                self.route(longer, "migrated", compact=True)
                st.update(want="handoff", approved_instructions=st["instructions"])
                self.route(longer, "migrated")
            out = ccsave.handback_now(binding, req, {}, "/responses", "503")
            self.assertIn("EARLIER", json.dumps(out))
            self.assertNotIn("LATER", json.dumps(out))
            self.assertNotIn(step(2)[1], out["input"])
            self.assertEqual(st["stints"][0]["b"], len(longer))
            self.assertEqual(st["stints"][0]["note"], "LATER")
            before = copy.deepcopy(st)
            self.route([user("Unrelated task under the abandoned key")], "k")
            unrelated = copy.deepcopy(ccsave.State.convs["k"])
            for key in ("migrated", "k"):
                self.assertEqual(self.route(items, key), dict(out, prompt_cache_key=key))
            self.assertEqual(st, before)
            self.assertEqual(ccsave.State.convs["k"], unrelated)

    def test_identical_retry_does_not_change_new_generation_even_after_restart(self):
        st, items = self.stint()
        req, binding = request(items), []
        ccsave.route("k", req, {}, "/responses", False, binding)
        self.route(items, compact=True)
        self.approve(items)
        self.assertEqual(self.route(items)["model"], CHEAP)
        ccsave.handback_now(binding, req, {}, "/responses", "503")
        before = copy.deepcopy(st)
        self.assertEqual(self.route(items)["model"], "sol")
        self.assertEqual(st, before)
        ccsave.State.convs = ccsave.load_state(io.StringIO(json.dumps(ccsave.State.convs)))
        self.assertEqual(self.route(items)["model"], "sol")
        self.assertEqual(ccsave.State.convs["k"], before)

    def test_no_pending_note_retry_does_not_save(self):
        with mock.patch.object(ccsave, "save") as save:
            self.route(START)
            self.assertEqual(save.call_count, 2)

    def test_adoption_moves_routing_lock(self):
        self.route(START)
        lock = ccsave.State.routing["k"]
        for key in ("new", "newer", "newest"):
            self.route(START, key)
            self.assertEqual(ccsave.State.routing, {key: lock})
        self.route([user("Different task")])
        self.assertIsNot(ccsave.State.routing["k"], lock)

    def test_images_and_files_separate_conversations_and_approvals(self):
        for field, first, second in (("image_url", "https://fixture.invalid/a", "https://fixture.invalid/b"),
                                     ("file_id", "file-a", "file-b"), ("file_data", "YWJj", "ZGVm")):
            with self.subTest(field=field):
                ccsave.State.convs.clear()
                a = copy.deepcopy(START)
                a[-1]["content"].append({"type": "input_image" if field == "image_url" else "input_file", field: first})
                b = copy.deepcopy(a)
                b[-1]["content"][-1][field] = second
                st = self.approve(a + step(1))
                self.assertIsNot(adopt("different", b + step(1)), st)
                self.assertEqual(self.route(b + step(1) + step(2))["model"], "sol")
                self.assertFalse(st["cheap"])

    def test_changed_image_drops_approval_even_with_continue_text(self):
        image = user("continue")
        image["content"].append({"type": "input_image", "image_url": "https://fixture.invalid/a"})
        h = START + [image] + step(1)
        self.approve(h)
        changed = copy.deepcopy(h)
        changed[len(START)]["content"][-1]["image_url"] = "https://fixture.invalid/b"
        self.assertEqual(self.route(changed + step(2))["model"], "sol")

    def test_appended_bare_continue_consumes_approval_and_ends_stint(self):
        for text in ("continue", "  CoNtInUe...  ", " CoN tInUe… ", "continue   working!", "keep going?", "go on.", "proceed;"):
            with self.subTest(text=text):
                ccsave.State.convs.clear()
                self.approve()
                h = START + step(1) + [user(text)]
                self.assertEqual(self.route(h)["model"], CHEAP, "an appended bare continue may consume the pending approval")
                out = self.route(h + step(2) + [user(text)])
                self.assertEqual(out["model"], "sol", "an appended bare continue still ends an active stint")
                self.assertIn(NOTE, json.dumps(out))
                self.assertEqual(out["input"][-1], user(text))

    def test_other_user_or_developer_text_returns_with_note(self):
        for role in ("user", "developer"):
            ccsave.State.convs.clear()
            st, h = self.stint()
            instruction = dict(user("Continue, but use a new approach."), role=role)
            out = self.route(h + step(2) + [instruction])
            self.assertEqual(out["model"], "sol")
            self.assertEqual(out["input"][-1], instruction)
            self.assertIn(NOTE, json.dumps(out))
            self.assertFalse(st["cheap"])

    def test_compaction_during_stint_returns_with_note(self):
        st, h = self.stint()
        out = self.route(h + step(2), compact=True)
        self.assertEqual(out["model"], "sol")
        self.assertEqual(st["stints"][-1]["why"], "compaction")
        self.assertIn(NOTE, json.dumps(out))
        self.assertNotIn(step(2)[1], out["input"])

    def test_edited_first_developer_message_keeps_notes_and_hides_raw_steps(self):
        st, h = self.stint()
        h = h + step(2)
        h[1] = dict(user("New developer instructions."), role="developer")
        out = self.route(h)
        self.assertIs(ccsave.State.convs["k"], st)
        self.assertEqual(out["model"], "sol")
        self.assertIn(NOTE, json.dumps(out))
        self.assertNotIn(step(2)[1], out["input"])
        self.assertEqual(out["input"][1], h[1])
        later = copy.deepcopy(h) + step(3)
        later[1] = DEV
        self.assertNotIn(step(2)[1], self.route(later)["input"])

    def test_strong_context_computed_once(self):
        with mock.patch.object(ccsave, "view", wraps=ccsave.view) as view, mock.patch.object(ccsave, "with_guidelines", wraps=ccsave.with_guidelines) as guidelines:
            self.route(START)
        self.assertEqual((view.call_count, guidelines.call_count), (1, 1))

    def test_compaction_alone_preserves_pending_approval(self):
        self.approve()
        self.assertEqual(self.route(START, compact=True)["model"], "sol")
        self.assertEqual(self.route(START + step(1))["model"], CHEAP)

    def test_key_adoption_stops_old_keep_warm_pings(self):
        st, h = self.stint()
        ccsave.State.mains["k"]["touched"] -= 300
        out = self.route(h + step(2) + [user("Switch tasks.")], "new")
        self.assertEqual(out["model"], "sol")
        self.assertIs(ccsave.State.convs["new"], st)
        with mock.patch.object(ccsave, "PING_S", 270), mock.patch.object(ccsave, "upstream") as upstream:
            ccsave.ping_mains()
            upstream.assert_not_called()
        self.assertNotIn("k", ccsave.State.mains)

    def test_keep_warm_skips_missing_or_strong_conversation(self):
        st, _ = self.stint()
        main = ccsave.State.mains["k"]
        main["touched"] -= 300
        ccsave.State.mains["missing"] = dict(main)
        st["cheap"] = False
        with mock.patch.object(ccsave, "PING_S", 270), mock.patch.object(ccsave, "upstream") as upstream:
            ccsave.ping_mains()
            upstream.assert_not_called()

    def test_stalled_return_note_leaves_raw_steps_until_ready(self):
        st, h = self.stint()
        items = h + step(2) + [user("Switch tasks.")]
        entered, release = threading.Event(), threading.Event()
        def side(*args):
            entered.set()
            release.wait()
            return NOTE
        self.side.side_effect = side
        with mock.patch.object(ccsave, "NOTE_WAIT_S", 0.05, create=True), concurrent.futures.ThreadPoolExecutor(1) as pool:
            first = pool.submit(self.route, items)
            try:
                self.assertTrue(entered.wait(2))
                out = first.result(timeout=0.5)
                self.assertEqual(out["model"], "sol")
                self.assertEqual(out["input"][-4:], items[-4:])
            finally:
                release.set()
        wait_for(lambda: st["stints"][-1]["note"] == NOTE)
        later = self.route(items + step(3))
        self.assertIn(NOTE, json.dumps(later["input"]))
        self.assertNotIn(step(2)[1], later["input"])

    def test_zero_ping_interval_turns_keep_warm_off(self):
        self.stint()
        ccsave.State.mains["k"]["touched"] -= 300
        with mock.patch.object(ccsave, "upstream", side_effect=OSError) as upstream:
            for interval, pings in ((0, 0), (270, 1)):
                with mock.patch.object(ccsave, "PING_S", interval):
                    ccsave.ping_mains()
                self.assertEqual(upstream.call_count, pings, f"CCSAVE_PING_S={interval}")

    def test_duplicate_requests_wait_for_return_note(self):
        ccsave.JUDGE_EVERY = 2
        entered, release = threading.Event(), threading.Event()
        def side(kind, *args):
            if kind == "note":
                entered.set()
                self.assertTrue(release.wait(5))
                return NOTE
            return '{"handoff": true, "handback": false}'
        self.side.side_effect = side
        self.route(START)
        h = START + step(1)
        self.route(h)
        wait_for(lambda: ccsave.State.convs["k"]["want"] == "handoff")
        h += step(2)
        self.assertEqual(self.route(h)["model"], CHEAP)
        h += step(3) + [user("Switch to the new task.")]
        with concurrent.futures.ThreadPoolExecutor(4) as pool:
            first = pool.submit(self.route, h)
            self.assertTrue(entered.wait(5))
            duplicates = [pool.submit(self.route, h) for _ in range(3)]
            try:
                with self.assertRaises(concurrent.futures.TimeoutError):
                    duplicates[0].result(timeout=0.2)
            finally:
                release.set()
            self.assertEqual(first.result(timeout=5)["model"], "sol")
            for duplicate in duplicates:
                duplicate.result(timeout=5)
        wait_for(lambda: not ccsave.State.judging)


class Streams(ProxyCase):
    def test_successful_cr_and_multimember_gzip_stay_on_luna(self):
        history = Review.stint(self)
        Gateway.approve = False
        for failure in ('cr-only', 'gzip-members', 'created-201'):
            with self.subTest(failure=failure):
                history += step(len(history))
                Gateway.errors['cheap'] = [failure]
                status, raw = self.raw(history)
                self.assertIn(b'response.completed', gzip.decompress(raw) if failure == 'gzip-members' else raw)
                self.assertEqual(status, 201 if failure == 'created-201' else 200)
                self.assertTrue(self.state()['k']['cheap'])
                self.assertEqual(self.logged('request')[-1]['usage']['input_tokens'], 100)

    def test_sse_mixed_line_endings_at_every_boundary(self):
        frame = b'\xef\xbb\xbfevent: error\r\n\r\nevent: response.completed\rdata: {"response":\r\n' + b'data: {"usage":{"output_tokens":5}}}\r\r'
        for cut in range(len(frame) + 1):
            parser = ccsave.Events()
            result = [parser.feed(chunk) for chunk in (frame[:cut], frame[cut:])]
            self.assertIn('response.completed', result, cut)
            self.assertEqual(parser.usage, {'output_tokens': 5})

    def test_retry_after_408_headers_before_body(self):
        history = Review.stint(self) + step(3)
        Gateway.approve = False
        Gateway.errors['cheap'] = ['held-408']
        Gateway.stream_gate = threading.Event()
        try:
            with closing(http.client.HTTPConnection('127.0.0.1', self.port, timeout=2)) as conn:
                conn.request('POST', '/responses', json.dumps(request(history)))
                response = conn.getresponse()
                self.assertEqual(response.status, 408)
                self.assertIn(b'"model": "sol"', self.raw(history)[1])
                response.close()
        finally:
            Gateway.stream_gate.set()

    def test_stalled_failure_note_allows_raw_then_noted_retry(self):
        history = Review.stint(self) + step(3)
        Gateway.errors['cheap'] = [503]
        entered, release = threading.Event(), threading.Event()
        Gateway.holds['note'] = entered, release
        with concurrent.futures.ThreadPoolExecutor() as pool:
            try:
                fallback = pool.submit(self.raw, history)
                self.assertTrue(entered.wait(2))
                self.assertIn(b'"model": "sol"', fallback.result(timeout=2)[1])
                self.assertIn(step(3)[1], [r for r in SEEN if r.get('stream')][-1]['input'])
                self.assertIn(step(3)[1], self.post(history)['input'])
            finally:
                release.set()
        wait_for(lambda: self.state()['k']['stints'][-1]['note'])
        self.assertIn(NOTE, str(self.post(history)))
        self.assertEqual(len([r for r in self.logged('side') if r['what'] == 'note']), 1)

    def restart(self, **extra):
        self.shell.terminate()
        self.shell.wait(timeout=5)
        self.extra_env = extra
        self.start()

    def test_metadata_only_restart_continues_stint_with_note(self):
        items = Review.stint(self) + step(3)
        items.append(dict(user("Report"), role="assistant"))
        Gateway.approve = False
        self.post(items)
        self.restart()
        replay = copy.deepcopy(items)
        for it in replay:
            it.update(id="new-id", status="completed")
            if "call_id" in it:
                it["call_id"] = "replayed-link"
        replay[-1].pop("type")
        replay[-1]["content"][0]["annotations"] = []
        out = self.post(replay + [user("Continue")], "resumed")
        self.assertEqual(out["model"], "sol")
        self.assertIn(NOTE, json.dumps(out))
        self.assertNotIn(step(3)[1]["input"], str(out))
        self.assertNotIn("k", self.state())

    def test_restart_compaction_restores_tools_reason_and_quick_judge(self):
        self.every = 3
        self.restart()
        items = START
        for idx in range(3):
            self.post(items)
            items = items + step(idx)
        for idx in range(3, 6):
            self.assertEqual(self.post(items)["model"], CHEAP)
            items = items + step(idx)
        self.restart()
        out = self.post(items[1:], "resumed")
        self.assertEqual((out["model"], out["tool_choice"], out["input"][0]), ("sol", "none", TOOLS))
        self.assertNotIn(step(4)[1], out["input"])
        self.assertIn(NOTE, json.dumps(out))
        self.assertEqual(self.state()["resumed"]["stints"][-1]["why"], "handback")
        self.post(items + step(6), "resumed")
        self.assertEqual(self.state()["resumed"]["want"], "handoff")

    def test_disabled_restart_renders_notes_and_excludes_intervening_sol_work(self):
        items = Review.stint(self) + step(3) + [user("Continue")]
        self.post(items)
        items += step(4)
        self.post(items)
        items += step(5)
        self.assertEqual(self.post(items)["model"], CHEAP)
        self.restart(CCSAVE_CHEAP_MODEL="")
        items += step(6)
        sides = len(self.logged("side"))
        self.assertIn(NOTE, json.dumps(self.post(items)))
        self.assertFalse(self.state()["k"]["cheap"])
        items += step(7)
        self.assertIn(step(7)[1], self.post(items)["input"])
        self.assertEqual(len(self.logged("side")), sides)
        self.restart()
        out = self.post(items + step(8))
        self.assertIn(step(7)[1], out["input"])
        writer = [b for b in SEEN if text_of(b["input"][0]).startswith("You write a hand-off note")][-1]
        self.assertIn("step 6", text_of(writer["input"][1]))
        self.assertNotIn("step 7", text_of(writer["input"][1]))

    def test_compressed_completion_preserves_wire_bytes_usage_and_stint(self):
        items = Review.stint(self) + step(3)
        Gateway.errors["cheap"] = ["gzip"]
        with closing(http.client.HTTPConnection("127.0.0.1", self.port)) as conn:
            conn.request("POST", "/responses", json.dumps(request(items)), {"Accept-Encoding": "gzip"})
            response = conn.getresponse()
            self.assertEqual(response.getheader("content-encoding"), "gzip")
            self.assertIn(b"response.completed", gzip.decompress(response.read()))
        self.assertEqual(Gateway.encodings[-1], "identity")
        self.assertTrue(self.state()["k"]["cheap"])
        rec = self.logged("request")[-1]
        self.assertNotIn("error", rec)
        self.assertEqual(rec["usage"]["input_tokens"], 100)

    def test_broken_framing_is_visible_even_after_completion(self):
        Gateway.errors["request"] = ["delta-broken"]
        with self.assertRaises(http.client.IncompleteRead):
            self.raw([user("standalone Sol request")], "sol-only")
        items = Review.stint(self) + step(3)
        Gateway.errors["cheap"] = ["complete-broken"]
        before = len(self.logged("request"))
        with self.assertRaises(http.client.IncompleteRead):
            self.raw(items)
        records = self.logged("request")[before:]
        self.assertEqual(len(records), 1)
        self.assertNotIn("error", records[0])
        self.assertTrue(self.state()["k"]["cheap"])

    def test_interim_usage_does_not_price_a_completed_response(self):
        items = Review.stint(self) + step(3)
        Gateway.errors["cheap"] = ["no-final-usage"]
        self.raw(items)
        rec = self.logged("request")[-1]
        self.assertNotIn("error", rec)
        self.assertIsNone(rec["usage"])

    def test_failed_json_main_is_billed_without_credit(self):
        items = Review.stint(self) + step(3)
        Gateway.errors["cheap"] = ["json-failed"]
        self.assertEqual(json.loads(self.raw(items)[1])["status"], "failed")
        rec = self.logged("request")[-1]
        table = dict(savings.PRICES, sol=savings.PRICES["gpt-6.1-sol"])
        self.assertAlmostEqual(savings.estimate([rec], table), -(50 * 0.1 + 7 * 0.5) / 1e6)
        self.assertFalse(self.state()["k"]["cheap"])
        self.assertEqual(self.post(items)["model"], "sol")

    def test_incomplete_judges_and_notes_do_not_apply_partial_answers(self):
        self.post(START)
        Gateway.errors["handoff"] = ["incomplete"]
        items = START + step(1)
        self.post(items)
        for idx in (2, 3):
            items += step(idx)
            self.assertEqual(self.post(items)["model"], "sol")
        items += step(4)
        self.assertEqual(self.post(items)["model"], CHEAP)
        Gateway.approve = False
        Gateway.errors.update(handback=["incomplete"], note=["incomplete"])
        items += step(5)
        self.post(items)
        out = self.post(items + step(6))
        self.assertEqual(out["model"], "sol")
        self.assertIn(step(5)[1], out["input"])
        self.assertIsNone(self.state()["k"]["stints"][-1]["note"])

    def test_fallback_does_not_wait_for_stalled_503_body(self):
        items = Review.stint(self) + step(3)
        Gateway.stream_gate = threading.Event()
        Gateway.errors["cheap"] = ["held-503"]
        with concurrent.futures.ThreadPoolExecutor() as pool:
            try:
                status, raw = pool.submit(self.raw, items).result(timeout=2)
                self.assertEqual(status, 200)
                self.assertIn(b'"model": "sol"', raw)
            finally:
                Gateway.stream_gate.set()

    def test_idle_downstream_does_not_keep_upstream_open(self):
        Gateway.stream_gate = threading.Event()
        Gateway.errors["request"] = ["keepalive"]
        with closing(http.client.HTTPConnection("127.0.0.1", self.port)) as conn:
            conn.request("POST", "/responses", json.dumps(request(START)))
            conn.getresponse().read()
            self.assertTrue(Gateway.stream_gate.wait(1))

    def raw(self, items, key="k"):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            c.request("POST", "/v1/responses", json.dumps(request(items, key)), {"content-type": "application/json"})
            r = c.getresponse()
            return r.status, r.read()
        finally:
            c.close()

    def test_completion_is_billed_once_before_http_eof(self):
        h = Review.stint(self) + step(3)
        Gateway.approve = False
        Gateway.errors["cheap"] = ["complete-held"]
        Gateway.stream_gate = threading.Event()
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=2)
        r = None
        before = len([rec for rec in self.logged("request") if rec.get("cheap")])
        try:
            c.request("POST", "/v1/responses", json.dumps(request(h)), {"content-type": "application/json"})
            r = c.getresponse()
            self.assertIn(b"response.completed", r.read1(65536))
            billed = [rec for rec in self.logged("request") if rec.get("cheap")][before:]
            self.assertEqual([rec["usage"]["input_tokens"] for rec in billed], [100])
        finally:
            Gateway.stream_gate.set()
            if r is not None:
                r.read()
            c.close()
        self.assertEqual(len([rec for rec in self.logged("request") if rec.get("cheap")]), before + 1)
        self.assertTrue(self.state()["k"]["cheap"])

    def test_relayed_failures_end_stint_and_retry_goes_to_sol(self):
        for failure in ("delta-broken", "response.failed", "error", "broken-stream"):
            with self.subTest(failure=failure):
                key = failure
                Gateway.approve = True
                self.post(START, key)
                h = START + step(1)
                self.post(h, key)
                h += step(2)
                self.assertEqual(self.post(h, key)["model"], CHEAP)
                Gateway.approve = False
                h += step(3)
                Gateway.errors["cheap"] = [failure]
                before = len([r for r in SEEN if r.get("stream")])
                if failure in ("broken-stream", "delta-broken"):
                    with self.assertRaises(http.client.IncompleteRead):
                        self.raw(h, key)
                else:
                    self.assertEqual(self.raw(h, key)[0], 200)
                self.assertEqual(len([r for r in SEEN if r.get("stream")]), before + 1, "no same-request fallback after relay")
                sent = self.post(h, key)
                self.assertEqual(sent["model"], "sol")
                self.assertIn(NOTE, json.dumps(sent))
                self.assertNotIn(step(3)[1], sent["input"])
                if failure in ("response.failed", "error"):
                    billed = wait_for(lambda: [r for r in self.logged("request") if r.get("error") == failure])
                    self.assertEqual(billed[-1]["usage"]["input_tokens"], 100)

    def test_late_failure_after_key_migration_uses_bound_state(self):
        h = Review.stint(self) + step(3)
        Gateway.approve = False
        entered, release = threading.Event(), threading.Event()
        Gateway.holds["cheap"] = (entered, release)
        Gateway.errors["cheap"] = [429]
        with concurrent.futures.ThreadPoolExecutor() as pool:
            old = pool.submit(self.raw, h)
            self.assertTrue(entered.wait(5))
            try:
                self.assertEqual(self.post(h + step(4), "new")["model"], CHEAP)
                self.assertNotIn("k", self.state())
            finally:
                release.set()
            status, raw = old.result(timeout=5)
        self.assertEqual(status, 200)
        self.assertIn(b'"model": "sol"', raw)
        self.assertFalse(self.state()["new"]["cheap"])
        self.assertTrue(self.state()["new"]["stints"][-1]["note"])

    def test_late_failure_never_closes_a_newer_stint(self):
        h = Review.stint(self) + step(3)
        Gateway.approve = False
        entered, release = threading.Event(), threading.Event()
        Gateway.holds["cheap"] = (entered, release)
        Gateway.errors["cheap"] = [429]
        with concurrent.futures.ThreadPoolExecutor() as pool:
            old = pool.submit(self.raw, h)
            self.assertTrue(entered.wait(5))
            try:
                h += [user("Use the new approach.")]
                self.assertEqual(self.post(h)["model"], "sol")
                Gateway.approve = True
                h += step(4)
                self.assertEqual(self.post(h)["model"], "sol")
                h += step(5)
                self.assertEqual(self.post(h)["model"], CHEAP)
                before = self.state()["k"]
            finally:
                release.set()
            status, raw = old.result(timeout=5)
        self.assertEqual(status, 200)
        self.assertIn(b'"model": "sol"', raw)
        after = self.state()["k"]
        self.assertTrue(after["cheap"])
        self.assertEqual((after["start"], after["generation"], after["stints"]), (before["start"], before["generation"], before["stints"]))
        self.assertTrue(all(s["a"] <= s["b"] for s in after["stints"]))

    def test_bare_continue_after_restart_consumes_approval_and_ends_stint(self):
        self.post(START)
        h = START + step(1)
        self.post(h)
        self.shell.terminate()
        self.shell.wait(timeout=5)
        self.start()
        h += [user("CONTINUE!")]
        self.assertEqual(self.post(h, "resumed")["model"], CHEAP)
        h += step(2) + [user("keep going.")]
        out = self.post(h, "resumed")
        self.assertEqual(out["model"], "sol")
        self.assertIn(NOTE, json.dumps(out))

    def test_older_state_file_starts_fresh(self):
        self.shell.terminate()
        self.shell.wait(timeout=5)
        # This sample is in the state format of the measured revision, saved offline with that revision's
        # new_conv()/mark()/save() (no server or API request) for the history START + step(1) under key "k", with
        # calls=876, judged=875, an active stint starting at index 4 and an old note for [4, 7). It has no newer head
        # or instruction fingerprint.
        Path(self.log + ".state").write_bytes(
            rb'{"k": {"n": 7, "tail": "[\"custom_tool_call_output\", null, \"c1\", '
            rb'[{\"type\": \"input_text\", \"text\": \"Script completed\\nOutput:\\nok 1\"}]]", '
            rb'"cheap": true, "start": 4, "want": null, "stints": [{"a": 4, "b": 7, "note": "OLD NOTE", "why": "message"}], '
            rb'"calls": 876, "judged": 875, "back_calls": 0, "back_judged": null}}')
        self.start()
        h = START + step(1)
        self.assertEqual(self.post(h)["model"], "sol")
        st = self.state()["k"]
        self.assertEqual((st["calls"], st["judged"], st["stints"]), (1, None, []))

    def test_log_main_field_error_body_and_text_suppression(self):
        Gateway.errors["handoff"] = [503]
        self.post(START)
        self.post(START + step(1))
        sides = self.logged("side")
        self.assertIn("error_body", sides[-1])
        self.assertTrue(all(r.get("main") is False for r in self.logged("request")))
        self.assertTrue(all(r.get("strong_model") == "sol" for r in self.logged("request")))
        self.shell.terminate()
        self.shell.wait(timeout=5)
        self.extra_env = {"CCSAVE_LOG_TEXT": "0"}
        self.start()
        Gateway.errors["handoff"] = [503]
        self.post(START, "other")
        self.post(START + step(1), "other")
        last = self.logged("side")[-1]
        self.assertNotIn("text", last)
        self.assertNotIn("error_body", last)
        self.assertEqual(last["usage"]["input_tokens"], 1000)

    def test_delayed_judge_uses_bounded_state_wait(self):
        Gateway.side_delay = 0.6
        Review.stint(self)


if __name__ == "__main__":
    unittest.main()
