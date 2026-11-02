#!/usr/bin/env python3
"""Exercise adapter boundaries and consumer isolation with a synthetic ledger."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / 'bin/mesh-ledger.py'
ADAPTER = ROOT / 'test/fixtures/ledger-adapter.mjs'
spec = importlib.util.spec_from_file_location('mesh_ledger', CLI)
ledger = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ledger)

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

    def test_cursor_store_accepts_multiple_large_cursors_and_preserves_prior_at_limit(self):
        path = self.root / 'cursors.json'
        value = {'schemaVersion': 1, 'cursors': {f'work:c{i}': 'x' * (ledger.MAX_BYTES // 2) for i in range(3)}}
        ledger.save(path, value)
        self.assertEqual(ledger.read_json(path, {}, limit=ledger.MAX_CURSOR_BYTES), value)
        previous = path.read_bytes()
        with patch.object(ledger, 'MAX_CURSOR_BYTES', len(previous)):
            with self.assertRaises(ledger.ProtocolError):
                ledger.save(path, {'schemaVersion': 1, 'cursors': {**value['cursors'], 'work:extra': 'x'}})
        self.assertEqual(path.read_bytes(), previous)

    def test_timeout_retires_descendants_after_adapter_leader_exits(self):
        pid_file = self.root / 'child.pid'
        program = ('import os,time; pid=os.fork(); '
                   + f'open({str(pid_file)!r}, "w").write(str(pid)) if pid else None; '
                   + 'time.sleep(30) if pid == 0 else None')
        self.configure(timeout=300, command=[sys.executable, '-c', program])
        result = self.changes(code=1)
        self.assertEqual(result['errors'][0]['error'], 'adapter timed out')
        pid = int(pid_file.read_text())
        status = Path(f'/proc/{pid}/stat')
        if status.exists():
            self.assertEqual(status.read_text().split(') ', 1)[1].split()[0], 'Z')

    def graph(self, *args, code=0):
        done = subprocess.run(['node', str(ROOT / 'bin/mesh-graph.mjs'), *args, '--json'], env=self.env, capture_output=True, text=True, timeout=10)
        self.assertEqual(done.returncode, code, done.stderr)
        return json.loads(done.stdout) if done.stdout.strip() else None

    def seed_graph(self, migrate=True):
        for key in ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'):
            self.graph('add', '--agent', 'codex', '--runtime-uuid', key, '--cwd', str(self.root), '--tmux-target', 'test-' + key[:8])
        if migrate:
            self.graph('migrate', '--apply')

    def test_sync_opens_touches_closes_and_preserves_operator_links(self):
        self.seed_graph()
        a = 'codex:11111111-1111-4111-8111-111111111111'
        b = '22222222-2222-4222-8222-222222222222'
        self.graph('link', 'open', '--agent', 'codex', '--runtime-uuid', b, '--ref', 'work:A', '--role', 'owns', '--source', 'operator')
        self.write(sessions=[{'session': a}])
        self.run_cli('sync', '--scheme', 'work', '--full')
        links = self.graph('show')['links']
        owned = next(link for link in links if link['source'] == 'ledger-write')
        self.assertIsNone(owned['lastActivityAt'])
        self.write('active', sessions=[{'session': a}])
        self.run_cli('sync', '--scheme', 'work')
        self.assertIsNotNone(next(link for link in self.graph('show')['links'] if link['id'] == owned['id'])['lastActivityAt'])
        self.write('done')
        self.run_cli('sync', '--scheme', 'work')
        links = self.graph('show')['links']
        self.assertIsNotNone(next(link for link in links if link['id'] == owned['id'])['until'])
        self.assertIsNone(next(link for link in links if link['source'] == 'operator')['until'])

    def test_sync_prefix_resolution_is_unique_and_never_advances_on_ambiguity(self):
        self.seed_graph()
        self.write(sessions=[{'session': '11111111'}])
        self.run_cli('sync', '--scheme', 'work', '--full')
        self.graph('add', '--agent', 'claude', '--runtime-uuid', '11111111-1111-4111-8111-111111111111', '--cwd', str(self.root), '--tmux-target', 'test-claude')
        self.write('active', sessions=[{'session': '11111111'}])
        path = self.root / 'state/agent-mesh/ledger/cursors.json'
        before = path.read_bytes()
        result = self.run_cli('sync', '--scheme', 'work')
        self.assertEqual(result['sync']['unresolved'][0]['reason'], 'ambiguous')
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(len([link for link in self.graph('show')['links'] if link['until'] is None]), 1)
        self.write('active', sessions=[{'session': 'codex:11111111'}])
        self.assertEqual(self.run_cli('sync', '--scheme', 'work')['errors'], [])

    def test_sync_missing_sessions_is_not_removal_and_disabled_adapter_is_read_only(self):
        self.seed_graph()
        self.write(sessions=[{'session': 'codex:11111111'}])
        self.run_cli('sync', '--scheme', 'work', '--full')
        self.write('active')
        self.run_cli('sync', '--scheme', 'work')
        self.assertIsNone(self.graph('show')['links'][0]['until'])
        self.write('active', sessions=[])
        self.run_cli('sync', '--scheme', 'work')
        self.assertIsNotNone(self.graph('show')['links'][0]['until'])
        value = json.loads(self.config.read_text())
        value['adapters'][0]['linkSessions'] = False
        self.config.write_text(json.dumps(value))
        self.assertEqual(self.run_cli('sync', '--scheme', 'work')['status'], 'link-sync-disabled')

    def test_sync_never_migrates_a_legacy_graph_or_advances_after_failure(self):
        self.seed_graph(migrate=False)
        self.run_cli('sync', '--scheme', 'work')
        path = self.root / 'state/agent-mesh/ledger/cursors.json'
        before = path.read_bytes()
        self.write(sessions=[{'session': 'codex:11111111'}])
        self.run_cli('sync', '--scheme', 'work', code=1)
        self.assertEqual(path.read_bytes(), before)
        self.assertFalse(self.graph('show').get('migrated'))

    def test_command_is_argv_without_shell(self):
        marker = self.root / 'must-not-exist'
        self.configure(command=['node', str(ADAPTER), '; touch ' + str(marker)])
        self.changes(code=1)
        self.assertFalse(marker.exists())

if __name__ == '__main__':
    unittest.main()
