"""Offline launcher lifecycle and exit-estimate tests. Run: python3 test_launcher.py"""
import fcntl
import hashlib
import http.server
import json
import os
from pathlib import Path
import pty
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import termios
import threading
import time
import unittest
from unittest import mock

import savings
import test_proxy as proxy

HERE = Path(__file__).resolve().parent
STUB = '''import http.client, json, os, pathlib, signal, subprocess, sys, time, urllib.parse
args = sys.argv[1:]
options = args[:args.index('--')] if '--' in args else args
levels = [[]]
pos = 0
while pos < len(options):
    if options[pos] == '-c':
        levels[-1].append(options[pos + 1]); pos += 2
    else:
        if options[pos] in ('exec', 'e', 'resume', 'review'):
            levels.append([])
        pos += 1
options = next(level for level in reversed(levels) if level)
base = next(a.split('=', 1)[1].strip('"') for a in options if '.base_url=' in a)
p = urllib.parse.urlparse(base)
child = None
if os.environ.get('STUB_CAPTURE_SIGNAL'):
    def capture(sig, frame):
        pathlib.Path(os.environ['STUB_SIGNAL']).write_text(str(sig))
        sys.exit(0)
    for sig in (signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, capture)
if os.environ.get('STUB_IGNORE_TERM'):
    def ignore(sig, frame):
        pathlib.Path(os.environ['STUB_SIGNAL']).write_text(str(sig))
    signal.signal(signal.SIGTERM, ignore)
    child = subprocess.Popen([sys.executable, '-I', '-c', 'import time; time.sleep(120)'], start_new_session=True)
pathlib.Path(os.environ['STUB_RECORD']).write_text(json.dumps({'args': args, 'config': dict(a.split('=', 1) for a in options), 'log': os.environ['CCSAVE_LOG'], 'base_url': base, 'pid': os.getpid(), 'group': os.getpgrp(), 'child': child.pid if child else None}))
if os.environ.get('STUB_READ_STDIN'):
    print(input())
for items in json.loads(pathlib.Path(os.environ['STUB_INPUT']).read_text()):
    c = http.client.HTTPConnection(p.hostname, p.port, timeout=5)
    body = {'model': 'gpt-6.1-sol', 'prompt_cache_key': 'stub', 'stream': True, 'input': items}
    c.request('POST', p.path + '/responses', json.dumps(body), {'content-type': 'application/json'})
    r = c.getresponse()
    assert r.status == 200
    r.read()
    c.close()
    state_path = pathlib.Path(os.environ['CCSAVE_LOG'] + '.state')
    state = json.loads(state_path.read_text())['stub']
    if state['calls'] == state['judged'] and not state['cheap']:
        deadline = time.monotonic() + 5
        while json.loads(state_path.read_text())['stub']['want'] != 'handoff':
            assert time.monotonic() < deadline, 'handoff judge did not finish'
            time.sleep(0.01)
pathlib.Path(os.environ['STUB_READY']).touch()
if os.environ.get('STUB_GATE'):
    deadline = time.monotonic() + 30
    while not pathlib.Path(os.environ['STUB_GATE']).exists():
        assert time.monotonic() < deadline, 'stub gate did not open'
        time.sleep(0.01)
sys.exit(int(os.environ.get('STUB_EXIT', '0')))
'''


class Launcher(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name) / 'project'
        self.dir.mkdir()
        stub = self.dir / 'codex'
        stub.write_text('#!' + sys.executable + ' -I\n' + STUB)
        stub.chmod(0o755)
        proxy.SEEN.clear()
        proxy.Gateway.approve = True
        proxy.Gateway.errors = {}
        proxy.Gateway.hold = None
        proxy.Gateway.holds = {}
        proxy.Gateway.side_delay = 0
        proxy.Gateway.stream_gate = None
        self.gw = http.server.ThreadingHTTPServer(('127.0.0.1', 0), proxy.Gateway)
        threading.Thread(target=self.gw.serve_forever, daemon=True).start()
        self.children = []

    def tearDown(self):
        for p in self.children:
            if p.poll() is None:
                p.terminate()
            p.communicate(timeout=15)
        self.gw.shutdown()
        self.gw.server_close()
        self.tmp.cleanup()

    def launch(self, name='one', args=(), terminal=None, executable=HERE / 'codex-solpi', preexec=None, **extra):
        env = {k: v for k, v in os.environ.items() if not k.startswith(('CCSAVE_', 'STUB_'))}
        inp = self.dir / (name + '.input')
        inp.write_text(json.dumps([proxy.START]))
        env.update(PATH=str(self.dir) + os.pathsep + env['PATH'], HOME=self.tmp.name, XDG_STATE_HOME=str(self.dir.parent / 'state'),
                   CCSAVE_UPSTREAM=f'http://127.0.0.1:{self.gw.server_address[1]}',
                   CCSAVE_CHEAP_MODEL=proxy.CHEAP, CCSAVE_JUDGE_EVERY='2', CCSAVE_PING_S='600',
                   STUB_RECORD=str(self.dir / (name + '.record')), STUB_INPUT=str(inp), TMPDIR=str(self.dir),
                   STUB_SIGNAL=str(self.dir / (name + '.signal')), STUB_READY=str(self.dir / (name + '.ready')))
        env.update(extra)
        if env['CCSAVE_UPSTREAM'] == 'unset':
            del env['CCSAVE_UPSTREAM']
        def prepare():
            os.umask(0o022)
            if terminal is not None:
                os.setsid()
                fcntl.ioctl(terminal, termios.TIOCSCTTY, 0)
            if preexec:
                preexec()
        p = subprocess.Popen([str(executable), *args], cwd=self.dir, env=env,
                             stdin=terminal if terminal is not None else subprocess.PIPE,
                             preexec_fn=prepare, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.children.append(p)
        return p

    def record(self, name='one'):
        path = self.dir / (name + '.record')
        proxy.wait_for(path.exists)
        return json.loads(path.read_text())

    def assert_stopped(self, record):
        port = int(record['base_url'].split(':')[-1].split('/')[0])
        with self.assertRaises(OSError):
            socket.create_connection(('127.0.0.1', port), timeout=0.2)

    def test_r4_overrides_in_effect_at_innermost_command(self):
        for index, chain in enumerate(([], ['exec'], ['e'], ['exec', 'resume'], ['exec', 'review'], ['resume'], ['review'])):
            with self.subTest(chain=chain):
                tail = (['--last'] if 'resume' in chain else []) + ['-c', 'model_reasoning_effort="low"', '--', '-literal']
                name = str(index)
                proc = self.launch(name, args=chain + tail)
                _, err = proc.communicate(timeout=5)
                self.assertEqual(proc.returncode, 0, err)
                record = self.record(name)
                self.assertEqual(record['args'][:len(chain) + 1], chain + ['-c'])
                self.assertEqual(record['args'][-len(tail):], tail)
                self.assertEqual(record['config']['model_provider'], '"solpi"')
                self.assertEqual(record['config']['model_reasoning_effort'], '"low"')

    def test_r4_private_records_outside_checkout_xdg_and_home(self):
        sentinel = self.dir / 'shared'
        sentinel.mkdir()
        (self.dir / '.ccsave').symlink_to(sentinel)
        for name, base in [('xdg', self.dir.parent / 'state'), ('home', self.dir.parent / '.local/state')]:
            proc = self.launch(name, XDG_STATE_HOME=str(base) if name == 'xdg' else '')
            _, err = proc.communicate(timeout=5)
            self.assertEqual(proc.returncode, 0, err)
            folder = base / 'sol-pi-v2' / hashlib.sha256(os.fsencode(self.dir.resolve())).hexdigest()
            self.assertEqual(Path(self.record(name)['log']).resolve().parent, folder.resolve())
            for directory in (folder, folder.parent):
                self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
            self.assertEqual(list(sentinel.iterdir()), [])

    def test_r4_unsafe_paths_refused_without_changing_target(self):
        victim = self.dir / 'victim'
        victim.write_text('unchanged')
        victim.chmod(0o755)
        folder = self.dir.parent / 'records'
        folder.mkdir()
        for kind in ('log-link', 'state-link', 'ancestor-link', 'records-link', 'records-file', 'log-fifo', 'state-fifo'):
            with self.subTest(kind=kind):
                log = folder / kind
                xdg = self.dir.parent / ('state-' + kind)
                if kind.startswith('records'):
                    xdg.mkdir()
                    if kind == 'records-link':
                        (xdg / 'sol-pi-v2').symlink_to(folder)
                    else:
                        (xdg / 'sol-pi-v2').touch()
                elif kind == 'ancestor-link':
                    (self.dir / 'link').symlink_to(folder)
                    log = self.dir / 'link/log'
                else:
                    target = log if kind.startswith('log') else Path(str(log) + '.state')
                    if kind.endswith('fifo'):
                        os.mkfifo(target)
                    else:
                        target.symlink_to(victim)
                proc = self.launch(kind, CCSAVE_LOG='' if kind.startswith('records') else str(log), XDG_STATE_HOME=str(xdg))
                try:
                    proc.communicate(timeout=2)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.communicate()
                    self.fail('blocked on unsafe path: ' + kind)
                self.assertNotEqual(proc.returncode, 0)
                self.assertFalse((self.dir / (kind + '.record')).exists())
                self.assertEqual(victim.read_text(), 'unchanged')
                self.assertEqual(victim.stat().st_mode & 0o777, 0o755)

    def test_explicit_log_under_a_group_writable_project_tree(self):
        """Cluster project trees are group-writable and setgid; an explicit log below one must still work."""
        shared = self.dir / 'project'
        shared.mkdir()
        shared.chmod(0o2775)
        runs = shared / 'runs'
        runs.mkdir(mode=0o755)
        log = runs / 'ccsave.jsonl'
        proc = self.launch('shared', CCSAVE_LOG=str(log))
        _, err = proc.communicate(timeout=5)
        self.assertEqual(proc.returncode, 0, err)
        self.assertIn('stub', json.loads(Path(str(log) + '.state').read_text()))

    def test_r4_explicit_log_preserves_mode_and_ignores_planted_state_tmp(self):
        log = self.dir / 'stable'
        log.touch(mode=0o644)
        victim = self.dir / 'sentinel'
        victim.write_text('unchanged')
        Path(str(log) + '.state.tmp').symlink_to(victim)
        proc = self.launch(CCSAVE_LOG=str(log))
        _, err = proc.communicate(timeout=5)
        self.assertEqual(proc.returncode, 0, err)
        self.assertEqual(victim.read_text(), 'unchanged')
        self.assertEqual(log.stat().st_mode & 0o777, 0o644)
        self.assertIn('stub', json.loads(Path(str(log) + '.state').read_text()))

    def test_r4_side_debit_printed_with_http_eof_held(self):
        proxy.Gateway.errors['handoff'] = ['side-held']
        proxy.Gateway.stream_gate = threading.Event()
        try:
            proc = self.launch(CCSAVE_JUDGE_EVERY='1')
            _, err = proc.communicate(timeout=2)
            self.assertEqual(proc.returncode, 0, err)
            self.assertIn('$-0.000008', err)
        finally:
            proxy.Gateway.stream_gate.set()

    def test_r4_foreground_interrupt_exactly_once_and_direct_pid_still_works(self):
        (self.dir / 'codex').write_text('#!' + sys.executable + ' -I\n' + '''import pathlib, signal, time
count = 0
def interrupt(*args):
    global count
    count += 1
signal.signal(signal.SIGINT, interrupt)
pathlib.Path('ready').touch()
while not count: time.sleep(.01)
time.sleep(.3)
pathlib.Path('count').write_text(str(count))
''')
        for direct in (False, True):
            master, slave = pty.openpty()
            try:
                attrs = termios.tcgetattr(slave)
                attrs[3] &= ~termios.ECHO
                termios.tcsetattr(slave, termios.TCSANOW, attrs)
                proc = self.launch(terminal=slave)
                proxy.wait_for((self.dir / 'ready').exists)
                if direct:
                    proc.send_signal(signal.SIGINT)
                else:
                    os.write(master, b'\x03')
                proc.communicate(timeout=4)
                self.assertEqual(proc.returncode, 130)
                self.assertEqual((self.dir / 'count').read_text(), '1')
                (self.dir / 'ready').unlink()
                (self.dir / 'count').unlink()
            finally:
                os.close(master)
                os.close(slave)

    def test_r4_nohup_remains_ignored(self):
        gate = self.dir / 'gate'
        proc = self.launch(STUB_GATE=str(gate), preexec=lambda: (os.setsid(), signal.signal(signal.SIGHUP, signal.SIG_IGN)))
        proxy.wait_for((self.dir / 'one.ready').exists)
        os.killpg(proc.pid, signal.SIGHUP)
        gate.touch()
        proc.communicate(timeout=5)
        self.assertEqual(proc.returncode, 0)

    def test_r4_signal_during_cleanup_controls_exit_status(self):
        for name in ('codex-solpi', 'savings.py', 'records.py'):
            if (HERE / name).exists():
                shutil.copy2(HERE / name, self.dir / name)
        (self.dir / 'ccsave.py').write_text('import os, pathlib, signal, time\n'
                'signal.signal(signal.SIGTERM, lambda *_: pathlib.Path("cleanup").touch())\n'
                'pathlib.Path(os.environ["CCSAVE_PORT_FILE"]).write_text("12345")\ntime.sleep(10)\n')
        (self.dir / 'codex').write_text('#!/bin/sh\nexit 0\n')
        proc = self.launch(executable=self.dir / 'codex-solpi')
        proxy.wait_for((self.dir / 'cleanup').exists)
        proc.terminate()
        proc.communicate(timeout=3)
        self.assertEqual(proc.returncode, 143)

    def test_r4_cleanup_discovers_child_of_surviving_helper(self):
        (self.dir / 'helper.py').write_text('''import os, pathlib, signal, subprocess, sys, time
def spawn(*args):
    child = subprocess.Popen([sys.executable, '-I', '-c', 'import time; time.sleep(20)'], start_new_session=True,
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    pathlib.Path('grandchild').write_text(str(child.pid))
signal.signal(signal.SIGTERM, spawn)
pathlib.Path('helper-ready').touch()
time.sleep(20)
''')
        (self.dir / 'codex').write_text('#!' + sys.executable + ' -I\nimport subprocess, sys, time\n'
                                        'subprocess.Popen([sys.executable, "-I", "helper.py"])\ntime.sleep(20)\n')
        proc = self.launch()
        proxy.wait_for((self.dir / 'helper-ready').exists)
        proc.terminate()
        proc.communicate(timeout=4)
        grandchild = int((self.dir / 'grandchild').read_text())
        try:
            os.kill(grandchild, signal.SIGKILL)
        except ProcessLookupError:
            pass
        else:
            self.fail('discoverable grandchild survived')

    def test_B1_project_python_modules_never_run(self):
        (self.dir / 'signal.py').write_text('open("imported", "w").close(); raise RuntimeError("project module")')
        proc = self.launch()
        _, err = proc.communicate(timeout=5)
        self.assertFalse((self.dir / 'imported').exists())
        self.assertEqual(proc.returncode, 0, err)

    def test_B9_only_proxy_files_inherit_private_umask(self):
        proc = self.launch()
        _, err = proc.communicate(timeout=5)
        self.assertEqual(proc.returncode, 0, err)
        self.assertEqual((self.dir / 'one.record').stat().st_mode & 0o777, 0o644)
        for path in Path(self.record()['log']).parent.iterdir():
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_B6_foreground_codex_stays_in_callers_terminal_group(self):
        master, slave = pty.openpty()
        try:
            proc = self.launch(terminal=slave, STUB_GATE=str(self.dir / 'gate'))
            record = self.record()
            self.assertEqual(record['group'], os.getpgid(proc.pid))
            self.assertEqual(record['group'], proc.pid)
            (self.dir / 'gate').touch()
            proc.communicate(timeout=5)
        finally:
            os.close(master)
            os.close(slave)

    def test_A17_B7_direct_interrupt_works_even_when_inherited_ignored(self):
        proc = self.launch(preexec=lambda: signal.signal(signal.SIGINT, signal.SIG_IGN), STUB_CAPTURE_SIGNAL='1',
                           STUB_GATE=str(self.dir / 'never'))
        proxy.wait_for(lambda: (self.dir / 'one.ready').exists())
        proc.send_signal(signal.SIGINT)
        proc.communicate(timeout=5)
        self.assertEqual(proc.returncode, 130)
        self.assertEqual(int((self.dir / 'one.signal').read_text()), signal.SIGINT)

    def test_B6_background_launcher_never_takes_foreground_terminal(self):
        supervisor = self.dir / 'foreground'
        supervisor.write_text('#!' + sys.executable + ' -I\n' + '''import os, pathlib, subprocess, sys, time
child = subprocess.Popen(sys.argv[1:], preexec_fn=os.setpgrp)
try:
    deadline = time.monotonic() + 4
    while not pathlib.Path(os.environ['STUB_READY']).exists():
        assert time.monotonic() < deadline
        time.sleep(0.01)
    assert os.tcgetpgrp(0) == os.getpgrp(), 'background launcher took the terminal'
finally:
    pathlib.Path(os.environ['STUB_GATE']).touch()
    child.wait(timeout=5)
''')
        supervisor.chmod(0o755)
        master, slave = pty.openpty()
        try:
            proc = self.launch(terminal=slave, executable=supervisor, args=[HERE / 'codex-solpi'], STUB_GATE=str(self.dir / 'gate'))
            _, err = proc.communicate(timeout=10)
            self.assertEqual(proc.returncode, 0, err)
        finally:
            os.close(master)
            os.close(slave)

    def test_B8_cleanup_kills_a_term_ignoring_proxy(self):
        for name in ('codex-solpi', 'savings.py', 'records.py'):
            shutil.copy2(HERE / name, self.dir / name)
        (self.dir / 'ccsave.py').write_text('import os, pathlib, signal, time\n'
                'signal.signal(signal.SIGTERM, signal.SIG_IGN)\n'
                'pathlib.Path("stub-proxy.pid").write_text(str(os.getpid()))\n'
                'pathlib.Path(os.environ["CCSAVE_PORT_FILE"]).write_text("12345")\n'
                'time.sleep(60)\n')
        inp = self.dir / 'empty'
        inp.write_text('[]')
        proc = self.launch(executable=self.dir / 'codex-solpi', STUB_INPUT=str(inp))
        try:
            proc.communicate(timeout=4)
            self.assertEqual(proc.returncode, 0)
            self.assertFalse(list(self.dir.glob('codex-solpi.*')))
        finally:
            pid = int((self.dir / 'stub-proxy.pid').read_text())
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            else:
                self.fail('proxy still alive')

    def test_issue11_arguments_provider_exit_code_and_cleanup(self):
        args = ['exec', '--json', 'a task with spaces; $(literal) and "quotes"\nnext line']
        p = self.launch(args=args, STUB_EXIT='7')
        out, err = p.communicate(timeout=10)
        record = self.record()
        self.assertEqual(p.returncode, 7)
        self.assertEqual([record['args'][0]] + record['args'][-2:], args)
        self.assertIn('model_provider="solpi"', record['args'])
        self.assertIn('model_providers.solpi.env_key="OPENAI_API_KEY"', record['args'])
        self.assertEqual(out, '')
        self.assertEqual(err.count('SoL-Pi estimated saving:'), 1)
        self.assertTrue(proxy.SEEN, 'stub reached mock gateway through proxy')
        self.assert_stopped(record)

    def test_issue11_each_process_has_its_own_proxy_and_signal_cleanup(self):
        gate = str(self.dir / 'gate')
        first = self.launch('one', STUB_GATE=gate)
        second = self.launch('two', STUB_GATE=gate)
        a, b = self.record('one'), self.record('two')
        self.assertNotEqual(a['base_url'], b['base_url'])
        first.send_signal(signal.SIGTERM)
        _, err = first.communicate(timeout=5)
        self.assertEqual(first.returncode, 143)
        self.assertEqual(err.count('SoL-Pi estimated saving:'), 1)
        self.assert_stopped(a)
        with self.assertRaises(ProcessLookupError):
            os.kill(a['pid'], 0)
        Path(gate).touch()
        second.communicate(timeout=5)
        self.assertEqual(second.returncode, 0)
        self.assert_stopped(b)

    def test_issue11_failed_proxy_start_does_not_run_codex(self):
        p = self.launch(CCSAVE_UPSTREAM='unset')
        _, err = p.communicate(timeout=5)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn('CCSAVE_UPSTREAM is required', err)
        self.assertFalse((self.dir / 'one.record').exists())

    def test_issue12_launcher_reports_only_its_own_session(self):
        log = self.dir / 'reused.jsonl'
        log.write_text('{"kind":"side","status":200,"model":"unknown","usage":{}}\n')
        inp = self.dir / 'stint.input'
        h = proxy.START + proxy.step(1)
        inp.write_text(json.dumps([proxy.START, h, h + proxy.step(2), h + proxy.step(2) + proxy.step(3) + [proxy.user('Continue.')]]))
        rates = {'gpt-6.1-sol': [2, 0.1, 10], proxy.CHEAP: [0.2, 0.02, 0.75]}
        p = self.launch(CCSAVE_LOG=str(log), CCSAVE_PRICES=json.dumps(rates), STUB_INPUT=str(inp))
        _, err = p.communicate(timeout=10)
        # Luna: 100 input + 5 output; two side calls: 50 input + 7 output each.
        expected = (100 * 2 + 5 * 10 - 100 * 0.2 - 5 * 0.75 - 2 * (50 * 0.2 + 7 * 0.75)) / 1e6
        self.assertEqual(p.returncode, 0)
        self.assertIn(f'estimated saving: ${expected:.6f}', err)
        self.assertEqual(err.count('SoL-Pi estimated saving:'), 1)

    def test_item10_A6_B1_options_precede_literal_prompt_terminator(self):
        args = ['exec', '--', '-literal prompt']
        p = self.launch(args=args)
        p.communicate(timeout=10)
        self.assertEqual(p.returncode, 0)
        record = self.record()
        self.assertEqual([record['args'][0]] + record['args'][-2:], args)
        self.assertTrue(all(record['args'].index(a) < record['args'].index('--') for a in record['args'] if '.base_url=' in a))

    def test_item10_B2_sigterm_ignoring_codex_is_killed_and_cleaned_up(self):
        p = self.launch(STUB_IGNORE_TERM='1', STUB_GATE=str(self.dir / 'never'))
        record = self.record()
        proxy.wait_for(lambda: (self.dir / 'one.ready').exists())
        start = time.monotonic()
        p.send_signal(signal.SIGTERM)
        proxy.wait_for(lambda: (self.dir / 'one.signal').exists())
        self.assertEqual(int((self.dir / 'one.signal').read_text()), signal.SIGTERM)
        def proxy_stopped():
            try:
                c = socket.create_connection(('127.0.0.1', int(record['base_url'].split(':')[-1].split('/')[0])), timeout=0.1)
                c.close()
                return False
            except OSError:
                return True
        proxy.wait_for(proxy_stopped, timeout=2)
        p.communicate(timeout=13)
        self.assertLess(time.monotonic() - start, 13)
        self.assertEqual(p.returncode, 143)
        self.assert_stopped(record)
        for pid in (record['pid'], record['child']):
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)
        self.assertFalse(list(self.dir.glob('codex-solpi.*')))

    def test_item10_signals_are_forwarded_and_terminal_input_still_works(self):
        for sig, status in ((signal.SIGINT, 130), (signal.SIGHUP, 129)):
            name = str(sig)
            p = self.launch(name, STUB_CAPTURE_SIGNAL='1', STUB_GATE=str(self.dir / 'never'))
            record = self.record(name)
            proxy.wait_for(lambda: (self.dir / (name + '.ready')).exists())
            p.send_signal(sig)
            p.communicate(timeout=5)
            self.assertEqual(p.returncode, status)
            self.assertEqual(int((self.dir / (name + '.signal')).read_text()), sig)
            self.assert_stopped(record)
        master, slave = pty.openpty()
        attrs = termios.tcgetattr(slave)
        attrs[3] &= ~termios.ECHO
        termios.tcsetattr(slave, termios.TCSANOW, attrs)
        try:
            p = self.launch('terminal', terminal=slave, STUB_READ_STDIN='1')
            self.record('terminal')
            os.write(master, b'prompt from terminal\n')
            out, err = p.communicate(timeout=5)
            self.assertEqual(p.returncode, 0, err)
            self.assertEqual(out, 'prompt from terminal\n')
        finally:
            os.close(master)
            os.close(slave)

    def test_item12_B4_mock_model_ignores_empty_environment_setting(self):
        env = dict(os.environ, CCSAVE_CHEAP_MODEL='')
        p = subprocess.run([sys.executable, '-m', 'unittest', 'test_proxy.Cadence.test_a_script_counts_its_tool_calls'],
                           cwd=HERE, env=env, capture_output=True, text=True, timeout=15)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)



class Savings(unittest.TestCase):
    def test_issue12_cached_input_is_counted_once_and_side_costs_subtracted(self):
        table = {'sol': [[2, 0.1, 10]] * 2, 'luna': [[0.2, 0.02, 0.75]] * 2}
        usage = {'input_tokens': 1000, 'input_tokens_details': {'cached_tokens': 600}, 'output_tokens': 20}
        records = [{'kind': 'request', 'cheap': True, 'status': 200, 'completed': True, 'model': 'luna', 'strong_model': 'sol', 'usage': usage},
                   {'kind': 'side', 'what': 'note', 'status': 200, 'model': 'luna', 'usage': usage},
                   {'kind': 'side', 'what': 'handoff', 'status': 200, 'model': 'luna', 'usage': usage}]
        self.assertAlmostEqual(savings.estimate(records, table), (400 * 2 + 600 * 0.1 + 20 * 10 - 3 * (400 * 0.2 + 600 * 0.02 + 20 * 0.75)) / 1e6)
        records[0]['cheap'] = False
        self.assertLess(savings.estimate(records, table), 0, 'judge overhead may exceed savings')

    def test_issue12_price_override_long_context_and_missing_prices(self):
        with mock.patch.dict(os.environ, CCSAVE_PRICES='{"gpt-6-luna": [1, 0.5, 2]}'):
            table = savings.prices()
            self.assertAlmostEqual(savings.cost('gpt-6-luna', {'input_tokens': 300000, 'output_tokens': 10}, table), 0.300020)
        table = savings.PRICES
        self.assertAlmostEqual(savings.cost('gpt-6.1-sol', {'input_tokens': 300000, 'output_tokens': 10}, table), 1.200150)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'log'
            for model, usage in [('unknown', {'input_tokens': 1, 'output_tokens': 1}), ('gpt-6-luna', None)]:
                path.write_text(json.dumps({'kind': 'side', 'status': 200, 'completed': True, 'model': model, 'usage': usage}) + '\n')
                self.assertIn('unavailable', savings.summary(path))

    def test_item11_A7_B3_failed_usage_is_billed_without_counterfactual_credit(self):
        table = {'worker': [[0.2, 0.02, 0.75]] * 2, 'planner': [[2, 0.1, 10]] * 2}
        usage = {'input_tokens': 1000, 'input_tokens_details': {'cached_tokens': 600}, 'output_tokens': 20}
        for kind in ('side', 'request'):
            for status, error in ((503, None), (200, 'response.failed'), (200, None)):
                rec = {'kind': kind, 'cheap': kind == 'request', 'model': 'worker', 'strong_model': 'planner',
                       'status': status, 'error': error, 'usage': usage}
                self.assertAlmostEqual(savings.estimate([rec], table), -0.000107)
        rec['usage'] = None
        self.assertEqual(savings.estimate([rec], table), 0)

    def test_item11_B6_label_names_configured_models(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, CCSAVE_PRICES='{"worker":[0.2,0.02,0.75],"planner":[2,0.1,10]}'):
            path = Path(tmp) / 'log'
            path.write_text(json.dumps({'kind': 'request', 'cheap': True, 'model': 'worker', 'strong_model': 'planner',
                                        'status': 200, 'usage': {'input_tokens': 1000, 'output_tokens': 20}}) + '\n')
            summary = savings.summary(path)
            self.assertIn('worker work at planner prices minus worker', summary)
            self.assertNotIn('Luna', summary)
            self.assertNotIn('Sol prices', summary)



if __name__ == '__main__':
    unittest.main()
