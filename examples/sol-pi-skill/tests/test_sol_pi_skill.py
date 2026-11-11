"""Tests for the SoL-Pi skill example: hook parsing, session export, config, pricing. No model calls.

  python3 -m unittest discover -s examples/sol-pi-skill/tests -v
"""
import importlib.machinery
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
BIN = HERE.parent / 'bin'
REPO = HERE.parent.parent.parent


def load(name):
    loader = importlib.machinery.SourceFileLoader(name.replace('-', '_'), str(BIN / name))
    return loader.load_module()


run = load('sol-pi-run')
context = load('sol-pi-context')


def jsonl(path, rows):
    path.write_text(''.join(json.dumps(r) + '\n' for r in rows))
    return path


class HookParsing(unittest.TestCase):
    def test_ordinary_prompts_pass_through(self):
        for event in (
            {'hook_event_name': 'UserPromptSubmit', 'prompt': 'fix the tests'},
            {'hook_event_name': 'UserPromptSubmit', 'prompt': 'please run $sol-pi later'},
            {'hook_event_name': 'UserPromptSubmit', 'prompt': '/sol-pi-other x'},
            {'hook_event_name': 'UserPromptExpansion', 'command_name': 'review', 'command_args': 'x'},
            {'hook_event_name': 'PreToolUse'},
        ):
            self.assertIsNone(run.hook_request(event), event)

    def test_hand_offs_are_recognised(self):
        self.assertEqual(run.hook_request({'hook_event_name': 'UserPromptExpansion',
                                           'command_name': 'sol-pi:sol-pi', 'command_args': ' -m openai/gpt-5 go '}),
                         ('claude', '-m openai/gpt-5 go'))
        self.assertEqual(run.hook_request({'hook_event_name': 'UserPromptSubmit', 'turn_id': 't1',
                                           'prompt': '$sol-pi -t low fix it'}), ('codex', '-t low fix it'))
        self.assertEqual(run.hook_request({'hook_event_name': 'UserPromptSubmit', 'prompt': '/sol-pi go'}),
                         ('claude', 'go'))

    def test_only_leading_options_are_parsed(self):
        self.assertEqual(run.split_options('-m openai/gpt-5 -t low fix the tests'), ('openai/gpt-5', 'low', 'fix the tests'))
        self.assertEqual(run.split_options('fix -m inside the text'), ('default', 'high', 'fix -m inside the text'))
        self.assertEqual(run.split_options('-t xhigh  two\nlines'), ('default', 'xhigh', 'two\nlines'))

    def test_empty_task_is_blocked_with_usage(self):
        event = {'hook_event_name': 'UserPromptExpansion', 'command_name': 'sol-pi', 'command_args': '-m openai/gpt-5',
                 'prompt_id': 'p-empty', 'cwd': '/tmp'}
        with tempfile.TemporaryDirectory() as home:
            out = subprocess.run([sys.executable, str(BIN / 'sol-pi-run'), 'hook', 'submit'],
                                 input=json.dumps(event), capture_output=True, text=True,
                                 env={**os.environ, 'SOL_PI_HOME': home})
        reply = json.loads(out.stdout)
        self.assertEqual(reply['decision'], 'block')
        self.assertIn('no task given', reply['reason'])

    def test_non_hand_off_prints_nothing(self):
        out = subprocess.run([sys.executable, str(BIN / 'sol-pi-run'), 'hook', 'submit'],
                             input=json.dumps({'hook_event_name': 'UserPromptSubmit', 'prompt': 'hello'}),
                             capture_output=True, text=True)
        self.assertEqual((out.returncode, out.stdout), (0, ''))


class SessionExport(unittest.TestCase):
    def test_claude_export_starts_at_last_compaction_and_drops_hand_off(self):
        with tempfile.TemporaryDirectory() as d:
            path = jsonl(Path(d) / 'session.jsonl', [
                {'type': 'user', 'message': {'role': 'user', 'content': 'old turn before compaction'}},
                {'type': 'user', 'isCompactSummary': True, 'message': {'role': 'user', 'content': 'SUMMARY'}},
                {'type': 'user', 'cwd': '/w', 'message': {'role': 'user', 'content': 'keep "# marker" in mind'}},
                {'type': 'assistant', 'message': {'role': 'assistant', 'content': [
                    {'type': 'thinking', 'thinking': 'hidden'},
                    {'type': 'tool_use', 'name': 'Bash', 'input': {'command': 'ls'}},
                    {'type': 'text', 'text': 'OK'}]}},
                {'type': 'user', 'message': {'role': 'user', 'content': [
                    {'type': 'tool_result', 'content': 'x' * 5000}]}},
                {'type': 'user', 'isMeta': True, 'message': {'role': 'user', 'content': 'expanded skill body'}},
                {'type': 'user', 'message': {'role': 'user', 'content': '/sol-pi fix it'}},
            ])
            meta, events = context.claude_events(path, tool_chars=200)
            events = context.drop_handoff(events)
            text = context.render(meta, events, 100_000)
        self.assertNotIn('old turn', text)
        self.assertIn('SUMMARY', text)
        self.assertIn('# marker', text)
        self.assertIn('`Bash`: `ls`', text)
        self.assertNotIn('hidden', text)
        self.assertNotIn('expanded skill body', text)
        self.assertNotIn('/sol-pi fix it', text)
        self.assertIn('characters omitted', text)

    def test_codex_export_uses_replacement_history_and_drops_skill_injection(self):
        with tempfile.TemporaryDirectory() as d:
            path = jsonl(Path(d) / 'rollout-x-abc.jsonl', [
                {'type': 'session_meta', 'payload': {'id': 'abc', 'cwd': '/w'}},
                {'type': 'response_item', 'payload': {'type': 'message', 'role': 'user',
                                                      'content': [{'type': 'input_text', 'text': 'stale'}]}},
                {'type': 'compacted', 'payload': {'replacement_history': [
                    {'type': 'message', 'role': 'user', 'content': [{'type': 'input_text', 'text': 'kept history'}]}]}},
                {'type': 'response_item', 'payload': {'type': 'message', 'role': 'user', 'content': [
                    {'type': 'input_text', 'text': '<environment_context>noise</environment_context>'}]}},
                {'type': 'response_item', 'payload': {'type': 'function_call', 'name': 'exec_command',
                                                      'arguments': json.dumps({'cmd': 'git diff'})}},
                {'type': 'response_item', 'payload': {'type': 'message', 'role': 'user', 'content': [
                    {'type': 'input_text', 'text': '$sol-pi do it'}]}},
                {'type': 'response_item', 'payload': {'type': 'message', 'role': 'user', 'content': [
                    {'type': 'input_text', 'text': '<skill>\n<name>sol-pi</name>body</skill>'}]}},
            ])
            meta, events = context.codex_events(path, tool_chars=200)
            text = context.render(meta, context.drop_handoff(events), 100_000)
        self.assertNotIn('stale', text)
        self.assertIn('kept history', text)
        self.assertIn('git diff', text)
        self.assertNotIn('environment_context', text)
        self.assertNotIn('$sol-pi do it', text)
        self.assertNotIn('<skill>', text)

    def test_budget_keeps_the_most_recent_blocks(self):
        events = [('user', f'turn {i} ' + 'y' * 100) for i in range(50)]
        text = context.render({'host': 'Codex', 'session': 's', 'cwd': '/w', 'transcript': 't'}, events, 1000)
        self.assertIn('turn 49', text)
        self.assertNotIn('turn 0 ', text)
        self.assertIn('earlier blocks omitted', text)


class ConfigAndPricing(unittest.TestCase):
    def check_config(self, cfg):
        checker = REPO / 'scripts' / 'check-sol-pi-config.mjs'
        if not checker.exists():
            self.skipTest('not inside a SoL-Pi checkout')
        with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as f:
            json.dump(cfg, f)
        try:
            out = subprocess.run(['node', str(checker), '--config', f.name, '--require-all-enabled'],
                                 capture_output=True, text=True)
        finally:
            os.unlink(f.name)
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
        return out.stdout

    def test_all_four_mechanisms_enabled_and_valid(self):
        cfg = run.sol_pi_config()
        for key in ('actionFusion', 'observationPack', 'evidencePreservingReducer', 'onlineContextCompact'):
            self.assertTrue(cfg[key], key)
        self.assertNotIn('evidencePreservingReducerProvider', cfg)  # SoL-Pi's built-in reducer
        self.assertIsNotNone(run.effective_reducer(self.check_config(cfg)))

    def test_reducer_route_is_split_into_provider_and_model(self):
        cfg = run.sol_pi_config('my-provider/vendor/model-1')
        self.assertEqual((cfg['evidencePreservingReducerProvider'], cfg['evidencePreservingReducerModel']),
                         ('my-provider', 'vendor/model-1'))
        self.assertEqual(run.effective_reducer(self.check_config(cfg)), 'my-provider/vendor/model-1')

    def test_default_model_comes_from_user_pi_settings(self):
        with tempfile.TemporaryDirectory() as d:
            env = {'SOL_PI_USER_PI_DIR': d, 'SOL_PI_MODEL': ''}
            saved = {k: os.environ.get(k) for k in env}
            os.environ.update(env)
            try:
                self.assertIsNone(run.resolve_route('default'))
                Path(d, 'settings.json').write_text(json.dumps({'defaultProvider': 'p', 'defaultModel': 'm/x'}))
                self.assertEqual(run.resolve_route('default'), 'p/m/x')
                self.assertEqual(run.resolve_route('other/model'), 'other/model')
                os.environ['SOL_PI_MODEL'] = 'env/model'
                self.assertEqual(run.resolve_route(None), 'env/model')
            finally:
                for k, v in saved.items():
                    if v is None:
                        os.environ.pop(k, None)
                    else:
                        os.environ[k] = v

    def test_user_pi_files_are_linked_not_copied(self):
        with tempfile.TemporaryDirectory() as d:
            user, agent = Path(d, 'user'), Path(d, 'agent')
            user.mkdir()
            agent.mkdir()
            (user / 'models.json').write_text('{"providers": {}}')
            (agent / 'auth.json').write_text('{}')  # placeholder from `pi install`
            saved_agent, saved_env = run.AGENT_DIR, os.environ.get('SOL_PI_USER_PI_DIR')
            run.AGENT_DIR, os.environ['SOL_PI_USER_PI_DIR'] = agent, str(user)
            try:
                run.link_user_pi_files()
                self.assertTrue((agent / 'models.json').is_symlink())
                self.assertFalse((agent / 'auth.json').exists())  # placeholder dropped, nothing to link
                (user / 'auth.json').write_text('{"x": {}}')
                run.link_user_pi_files()
                self.assertEqual((agent / 'auth.json').resolve(), (user / 'auth.json').resolve())
            finally:
                run.AGENT_DIR = saved_agent
                if saved_env is None:
                    os.environ.pop('SOL_PI_USER_PI_DIR', None)
                else:
                    os.environ['SOL_PI_USER_PI_DIR'] = saved_env

    def test_only_this_checkout_stays_registered(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            other = root / 'other-sol-pi'
            other.mkdir()
            (other / 'package.json').write_text(json.dumps({'name': 'sol-pi'}))
            unrelated = root / 'some-extension'
            unrelated.mkdir()
            (unrelated / 'package.json').write_text(json.dumps({'name': 'pi-something'}))
            agent = root / 'agent'
            agent.mkdir()
            saved = run.AGENT_DIR
            run.AGENT_DIR = agent
            try:
                self.assertTrue(run.is_other_sol_pi(str(other)))
                self.assertTrue(run.is_other_sol_pi('../other-sol-pi'))
                self.assertFalse(run.is_other_sol_pi(str(unrelated)))
                self.assertFalse(run.is_other_sol_pi(str(run.SRC)))
                self.assertFalse(run.is_other_sol_pi('npm:@scope/pkg'))
                self.assertFalse(run.is_other_sol_pi(str(root / 'missing')))
            finally:
                run.AGENT_DIR = saved

    def test_price_uses_pi_model_cost_and_long_context_tier(self):
        cost = {'input': 2, 'cacheRead': 0.1, 'cacheWrite': 2.5, 'output': 10,
                'tiers': [{'inputTokensAbove': 272_000, 'input': 4, 'cacheRead': 0.2, 'cacheWrite': 5, 'output': 15}]}
        usage = {'input': 100_000, 'cacheRead': 100_000, 'cacheWrite': 0, 'output': 1_000}
        self.assertAlmostEqual(run.price(cost, usage), (100_000 * 2 + 100_000 * 0.1 + 1_000 * 10) / 1e6)
        self.assertAlmostEqual(run.price(cost, {**usage, 'cacheRead': 300_000}),
                               (100_000 * 4 + 300_000 * 0.2 + 1_000 * 15) / 1e6)
        self.assertEqual(run.price(None, usage), 0)

    def test_reducer_calls_are_priced_from_the_recorded_prices(self):
        with tempfile.TemporaryDirectory() as d:
            session = jsonl(Path(d) / 'session.jsonl', [
                {'type': 'custom', 'customType': 'sol-pi-skill-reducer-price',
                 'data': {'route': 'p/m', 'cost': {'input': 1, 'cacheRead': 0, 'cacheWrite': 0, 'output': 2}}},
                {'type': 'custom', 'customType': 'sol-pi-evidence-preserving-reducer-v1',
                 'data': {'kind': 'provider_response', 'model': 'm',
                          'usage': {'input': 1_000_000, 'output': 500_000, 'cacheRead': 0, 'cacheWrite': 0}}},
                {'type': 'custom', 'customType': 'sol-pi-evidence-preserving-reducer-v1', 'data': {'kind': 'applied'}},
            ])
            events = jsonl(Path(d) / 'events.jsonl', [
                {'type': 'message_end', 'message': {'role': 'assistant', 'provider': 'p', 'model': 'main',
                                                    'stopReason': 'stop', 'content': [{'type': 'text', 'text': 'done'}],
                                                    'usage': {'input': 10, 'output': 5, 'cost': {'total': 0.5}}}},
            ])
            result = run.summarize(events, session, 0, 'r', '/w', run.used_model(events), 0)
        self.assertEqual(result['model'], 'p/main')
        self.assertEqual(result['reducer_cost_usd'], 2.0)
        self.assertEqual(result['cost_usd'], 2.5)
        self.assertEqual(result['sol_pi']['reducer_applied'], 1)


if __name__ == '__main__':
    unittest.main()
