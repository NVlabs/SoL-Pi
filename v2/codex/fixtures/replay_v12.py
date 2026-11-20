"""Compare the review's 31-request offline trace with the measured Git revision."""
import copy
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import patch

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
import test_proxy as mock_gateway


def replay(source):
    case = mock_gateway.ProxyCase()
    case.every = 4
    case.extra_env = {'CCSAVE_PING_S': '9999'}
    with patch.object(mock_gateway, 'HERE', str(source)):
        case.setUp()
        try:
            history = list(mock_gateway.START)
            for index in range(31):
                if index:
                    history += mock_gateway.step(index)
                if index in (9, 21):
                    history.append(mock_gateway.user('Continue.'))
                case.post(history, reasoning={'effort': 'xhigh'})
            return copy.deepcopy(mock_gateway.SEEN)
        finally:
            case.tearDown()


def compare():
    with tempfile.TemporaryDirectory() as tmp:
        source = Path(tmp)
        try:
            (source / 'ccsave.py').write_bytes(subprocess.check_output(
                ['git', 'show', 'f391b4b:experiments/sol-pi-v2-codex/ccsave.py'], cwd=HERE, stderr=subprocess.DEVNULL))
        except (subprocess.CalledProcessError, FileNotFoundError):
            print("skipped: the replay needs commit f391b4b of the team's internal repository")
            return
        old = replay(source)
    current = replay(HERE)
    before, after = ([row for row in rows if row.get('stream')] for rows in (old, current))
    removed = 0
    for row in before:
        if row['input'][-1] == {'type': 'configuration_update', 'reasoning': {'effort': 'high'}}:
            row['input'].pop()
            removed += 1
    assert before == after and len(after) == 31 and removed == 28
    assert sum(row['model'] == mock_gateway.CHEAP for row in after) == 19
    before, after = ([row for row in rows if not row.get('stream')] for rows in (old, current))
    for row in after:
        if mock_gateway.text_of(row['input'][0]) == mock_gateway.RETURN_INSTRUCTIONS:
            block = row['input'][1]['content'][0]
            brief = 'STINT BRIEF:\n' + mock_gateway.REASON + '\n\n'
            assert block['text'].count(brief) == 1
            block['text'] = block['text'].replace(brief, '')
    assert before == after and len(after) == 13
    print('31/31 routed requests (12 Sol, 19 Luna); 13/13 side calls match v12.')


if __name__ == '__main__':
    compare()
