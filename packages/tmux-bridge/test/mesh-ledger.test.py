#!/usr/bin/env python3
"""Exercise adapter boundaries and consumer isolation with a synthetic ledger."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / 'bin/mesh-ledger.py'
ADAPTER = ROOT / 'test/fixtures/ledger-adapter.mjs'

class LedgerCLI(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.items = self.root / 'items'
        self.items.mkdir()
        self.config = self.root / 'config.json'
        self.env = {**os.environ, 'MESH_LEDGERS_FILE': str(self.config), 'XDG_STATE_HOME': str(self.root / 'state'), 'FIXTURE_LEDGER_ROOT': str(self.items)}
        self.configure()

    def configure(self, timeout=5000, command=None):
        self.config.write_text(json.dumps({'schemaVersion': 1, 'adapters': [{'scheme': 'work', 'command': command or ['node', str(ADAPTER)], 'timeoutMs': timeout}]}))

    def write(self, status='open', **fields):
        value = {'ref': 'work:A', 'title': 'A synthetic item', 'status': status, 'updatedAt': '2026-09-01T10:00:00Z', **fields}
        (self.items / 'A.json').write_text(json.dumps(value))
        return value

    def run_cli(self, *args, code=0, mode=None):
        env = {**self.env, **({'FIXTURE_LEDGER_MODE': mode} if mode else {})}
        done = subprocess.run([sys.executable, '-B', str(CLI), *args], env=env, capture_output=True, text=True, timeout=10)
        self.assertEqual(done.returncode, code, done.stdout + done.stderr)
        self.assertEqual(done.stderr, '')
        return json.loads(done.stdout)

    def changes(self, consumer='beat', **kwargs):
        return self.run_cli('changes', '--scheme', 'work', '--consumer', consumer, **kwargs)

    def test_null_baseline_independent_consumers_and_explicit_full(self):
        self.write()
        self.assertEqual(self.changes()['items'], [])
        self.assertEqual(self.changes('other')['items'], [])
        self.write('active')
        self.assertEqual(len(self.changes()['items']), 1)
        self.assertEqual(self.changes()['items'], [])
        self.assertEqual(len(self.changes('other')['items']), 1)
        full = self.run_cli('changes', '--scheme', 'work', '--consumer', 'full', '--full')
        self.assertEqual(len(full['items']), 1)
        self.assertEqual(self.changes('full')['items'], [])
        stored = (self.root / 'state/agent-mesh/ledger/cursors.json').read_text()
        self.assertNotIn('A synthetic item', stored)
        self.assertNotIn('active', stored)

    def test_peek_never_advances_and_deletions_are_current_items(self):
        self.changes()
        self.write()
        for _ in range(2):
            page = self.run_cli('changes', '--scheme', 'work', '--consumer', 'beat', '--peek')
            self.assertEqual(len(page['items']), 1)
        self.assertEqual(len(self.changes()['items']), 1)
        (self.items / 'A.json').unlink()
        self.assertEqual(self.changes()['items'][0]['status'], 'deleted')
        self.assertEqual(self.changes()['items'], [])

    def test_describe_routes_missing_and_discards_body(self):
        self.write(body='not part of adapter contract', logs=['not part of adapter contract'])
        result = self.run_cli('describe', 'work:A', 'work:missing', 'example:missing', '--json')
        self.assertEqual(set(result['missing']), {'work:missing', 'example:missing'})
        self.assertNotIn('body', result['items'][0])
        self.assertNotIn('logs', result['items'][0])

    def test_filtered_producer_advances_only_its_consumer(self):
        self.changes()
        self.write('waiting', waitingOn={'who': 'human', 'ask': 'Choose one option'})
        result = self.run_cli('producer', '--scheme', 'work', '--consumer', 'beat', '--filter', 'status=waiting,waitingOn.who=human')
        self.assertEqual(len(result['new']), 1)
        self.assertEqual(self.changes()['items'], [])

    def test_failures_do_not_advance_or_leak_diagnostics(self):
        self.changes()
        self.write()
        before = (self.root / 'state/agent-mesh/ledger/cursors.json').read_bytes()
        for mode in ('stderr', 'large', 'invalid'):
            result = self.changes(code=1, mode=mode)
            self.assertNotIn('private diagnostic', json.dumps(result))
            self.assertEqual((self.root / 'state/agent-mesh/ledger/cursors.json').read_bytes(), before)
        self.configure(timeout=50)
        self.changes(code=1, mode='timeout')
        self.assertEqual((self.root / 'state/agent-mesh/ledger/cursors.json').read_bytes(), before)

    def test_partial_errors_preserve_cursor_and_redact_adapter_details(self):
        self.changes()
        self.write()
        result = self.changes(mode='partial')
        self.assertEqual(result['errors'][0]['error'], 'adapter item error')
        self.assertNotIn('private diagnostic', json.dumps(result))
        self.assertEqual(len(self.changes()['items']), 1)

    def test_missing_config_is_quiet_and_conformance_passes(self):
        self.assertEqual(self.run_cli('conformance', '--scheme', 'work')['outcome'], 'pass')
        self.config.unlink()
        self.assertEqual(self.changes()['status'], 'no-adapter')
        result = self.run_cli('producer', '--scheme', 'work', '--consumer', 'beat')
        self.assertEqual((result['new'], result['errors']), ([], []))

    def test_invalid_protocol_and_filter_do_not_advance(self):
        self.changes()
        self.write(status='bad')
        self.changes(code=1)
        self.write()
        self.run_cli('producer', '--scheme', 'work', '--consumer', 'beat', '--filter', 'status=open,bad', code=1)
        self.assertEqual(len(self.changes()['items']), 1)

    def test_malformed_field_types_fail_without_traceback_or_cursor_advance(self):
        self.changes()
        for fields in ({'status': []}, {'waitingOn': {'who': []}}, {'waitingOn': {'who': 'human', 'urgency': []}}, {'sessions': [{'session': '12345678', 'role': []}]}):
            self.write(**fields)
            self.changes(code=1)
        self.write()
        self.assertEqual(len(self.changes()['items']), 1)

    def test_timeout_also_bounds_a_child_that_never_reads_stdin(self):
        self.configure(timeout=100, command=[sys.executable, '-c', 'import time; time.sleep(30)'])
        refs = ['work:' + str(i) + 'x' * 500 for i in range(200)]
        result = self.run_cli('describe', *refs, code=1)
        self.assertEqual(result['errors'][0]['error'], 'adapter timed out')

    def test_command_is_argv_without_shell(self):
        marker = self.root / 'must-not-exist'
        self.configure(command=['node', str(ADAPTER), '; touch ' + str(marker)])
        self.changes(code=1)
        self.assertFalse(marker.exists())

if __name__ == '__main__':
    unittest.main()
