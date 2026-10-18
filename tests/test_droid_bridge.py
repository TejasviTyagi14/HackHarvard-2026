"""Tests for tools/droid_bridge.py, run with `python3 -m unittest discover tests`.

A fake `droid` stands in for the real one. One live test talks to the real Droid; it runs only
when FACTORY_API_KEY is set and node is on the PATH.
"""
import json
import os
import shutil
import stat
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'tools'))
import droid_bridge as bridge  # noqa: E402

SCHEMA = {'parameters': {'maxItems': {'type': 'integer', 'min': 1, 'max': 10, 'default': 4}}, 'presets': {}}
CURRENT = {'maxItems': 4}


class FakeDroid:
    """Writes an executable that records its argv, what is in its cwd and its stdin, then prints `stdout`."""

    def __init__(self, stdout='', exit_code=0, sleep=0):
        self.dir = Path(tempfile.mkdtemp())
        self.log = self.dir / 'calls.json'
        script = self.dir / 'droid'
        script.write_text(textwrap.dedent(f'''\
            #!{sys.executable}
            import json, os, sys, time
            json.dump({{'argv': sys.argv[1:], 'cwd_files': os.listdir('.'), 'stdin': sys.stdin.read()}}, open({str(self.log)!r}, 'w'))
            time.sleep({sleep})
            sys.stdout.write({stdout!r})
            sys.exit({exit_code})
        '''))
        script.chmod(script.stat().st_mode | stat.S_IEXEC)
        self.env = mock.patch.dict(os.environ, {'DROID_BIN': str(script), 'DROID_TIMEOUT': '5'})

    def __enter__(self):
        self.env.start()
        return self

    def __exit__(self, *exc):
        self.env.stop()
        shutil.rmtree(self.dir)

    def call(self):
        return json.loads(self.log.read_text())


def droid_result(result, is_error=False):
    return json.dumps({'type': 'result', 'subtype': 'failure' if is_error else 'success', 'is_error': is_error,
                       'duration_ms': 1200, 'num_turns': 1, 'result': result, 'session_id': 's1',
                       'usage': {'input_tokens': 900, 'output_tokens': 40}})


class BridgeTest(unittest.TestCase):
    def test_returns_droids_update(self):
        update = {'preset': None, 'set': {'maxItems': 6}, 'reply': 'More detail.'}
        with FakeDroid(droid_result(json.dumps(update))):
            status, body = bridge.handle_detail({'request': 'more detail', 'current': CURRENT, 'schema': SCHEMA})
        self.assertEqual(status, 200)
        self.assertEqual(body['update'], update)
        self.assertEqual(body['droid']['session_id'], 's1')

    def test_runs_droid_read_only_without_tools_in_an_empty_dir(self):
        with FakeDroid(droid_result('{"set": {}}')) as fake:
            bridge.handle_detail({'request': 'shorter please', 'current': CURRENT, 'schema': SCHEMA})
            call = fake.call()
        argv = call['argv']
        self.assertEqual(argv[0], 'exec')
        self.assertNotIn('--auto', argv)
        self.assertNotIn('--skip-permissions-unsafe', argv)
        self.assertEqual(argv[argv.index('--only-tools') + 1], 'TodoWrite')
        self.assertEqual(argv[argv.index('--output-format') + 1], 'json')
        self.assertEqual(Path(argv[argv.index('--append-system-prompt-file') + 1]), bridge.PROMPT_FILE)
        self.assertEqual(call['cwd_files'], [])
        self.assertIn('"shorter please"', call['stdin'])
        self.assertIn('"maxItems"', call['stdin'])

    def test_tolerates_a_code_fence_around_the_json(self):
        with FakeDroid(droid_result('Here you go:\n```json\n{"preset": "brief", "set": {}, "reply": "OK."}\n```')):
            status, body = bridge.handle_detail({'request': 'brief', 'current': CURRENT, 'schema': SCHEMA})
        self.assertEqual(status, 200)
        self.assertEqual(body['update']['preset'], 'brief')

    def test_reports_droid_failures(self):
        cases = [
            (FakeDroid(droid_result('Authentication failed.', is_error=True)), 'Authentication failed'),
            (FakeDroid(droid_result('I would rather not.')), 'JSON object'),
            (FakeDroid('crash', exit_code=1), 'exit 1'),
            (FakeDroid(droid_result('{}'), sleep=3), 'longer than'),
        ]
        for fake, why in cases:
            with self.subTest(why=why), fake, mock.patch.dict(os.environ, {'DROID_TIMEOUT': '1'}):
                status, body = bridge.handle_detail({'request': 'more', 'current': CURRENT, 'schema': SCHEMA})
                self.assertEqual(status, 502)
                self.assertIn(why, body['error'])

    def test_missing_droid(self):
        with mock.patch.dict(os.environ, {'DROID_BIN': '/nonexistent/droid'}):
            status, body = bridge.handle_detail({'request': 'more', 'current': CURRENT, 'schema': SCHEMA})
        self.assertEqual(status, 502)
        self.assertIn('not installed', body['error'])

    def test_rejects_bad_bodies_without_calling_droid(self):
        with FakeDroid(droid_result('{}')) as fake:
            for payload in [None, [], {'request': ''}, {'request': 'x' * 501, 'current': {}, 'schema': {}},
                            {'request': 'more', 'current': 'x', 'schema': {}}]:
                status, _ = bridge.handle_detail(payload)
                self.assertEqual(status, 400)
            self.assertFalse(fake.log.exists())


@unittest.skipUnless(os.environ.get('FACTORY_API_KEY') and shutil.which('node'), 'needs FACTORY_API_KEY and node')
class LiveDroidTest(unittest.TestCase):
    def test_brief_request_lowers_detail(self):
        d = bridge.default_schema()
        status, body = bridge.handle_detail({'request': 'just give me the basics, keep it short', **d})
        self.assertEqual(status, 200, body)
        update = body['update']
        new_max = update.get('set', {}).get('maxItems', d['schema']['presets'].get(update.get('preset') or '', {}).get('maxItems'))
        self.assertIsNotNone(new_max, update)
        self.assertLess(new_max, d['current']['maxItems'])


if __name__ == '__main__':
    unittest.main()
