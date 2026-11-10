#!/usr/bin/env python3
"""Exercise adapter boundaries, consumer isolation and local item leases."""
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
import os
from pathlib import Path
import select
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
spec = importlib.util.spec_from_file_location('ledger_item_lock', ROOT / 'bin/ledger_item_lock.py')
item_lock = importlib.util.module_from_spec(spec)
spec.loader.exec_module(item_lock)

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

@unittest.skipUnless(sys.platform == 'linux', 'item leases use the Linux boot clock')
class ItemLeaseCLI(unittest.TestCase):
    ref = 'work:A'

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.state = self.root / 'locks'
        invalid_config = self.root / 'invalid-adapters.json'
        invalid_config.write_text('invalid')
        self.env = {**os.environ, 'MESH_LEDGERS_FILE': str(invalid_config),
                    'MESH_LEDGER_LOCK_STATE_DIR': str(self.state),
                    'PYTHONPATH': str(ROOT / 'bin')}

    def run_lock(self, action, *args, ref=None, code=0):
        done = subprocess.run(
            [sys.executable, '-B', str(CLI), 'lock', action, '--ref', ref or self.ref, *args],
            env=self.env, capture_output=True, text=True, timeout=10,
        )
        self.assertEqual(done.stderr, '')
        if code is not None:
            self.assertEqual(done.returncode, code, done.stdout)
        return done.returncode, json.loads(done.stdout)

    def acquire(self, fence=0, owner='worker-a', **kwargs):
        return self.run_lock('acquire', '--owner', owner, '--expect-fence', str(fence), **kwargs)[1]

    @staticmethod
    def credentials(lease):
        return ('--owner', lease['owner'], '--fence', str(lease['fence']), '--lease-id', lease['leaseId'])

    def start_worker(self, script):
        worker = subprocess.Popen([sys.executable, '-B', '-c', script], env=self.env,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(self.kill_worker, worker)
        ready, _, _ = select.select([worker.stdout], [], [], 10)
        self.assertTrue(ready, 'lease worker did not signal readiness')
        line = worker.stdout.readline()
        self.assertTrue(line, worker.stderr.read() if worker.poll() is not None else '')
        return worker, line

    @staticmethod
    def kill_worker(worker):
        if worker.poll() is None:
            worker.kill()
        worker.communicate(timeout=5)

    def test_first_acquire_is_cas_across_processes_and_different_refs_are_independent(self):
        missing = self.run_lock('inspect')[1]
        self.assertEqual((missing['status'], missing['fence']), ('available', 0))
        self.assertFalse(self.state.exists())

        def contender(index):
            return self.acquire(owner=f'worker-{index}', code=None)

        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(contender, range(8)))
        wins = [value for value in results if value['outcome'] == 'acquired']
        self.assertEqual(len(wins), 1, results)
        self.assertEqual([value['outcome'] for value in results].count('conflict'), 7, results)
        view = self.run_lock('inspect')[1]
        self.assertEqual((view['owner'], view['fence'], view['status']), (wins[0]['owner'], 1, 'active'))
        self.assertNotIn('leaseId', view)
        self.assertEqual(self.acquire(fence=1, code=3)['outcome'], 'held')
        self.assertEqual(self.acquire(ref='work:B')['fence'], 1)

    def test_release_preserves_fence_and_old_token_fails_for_same_owner(self):
        first = self.acquire()
        self.assertEqual(self.run_lock('release', *self.credentials(first))[1]['status'], 'available')
        self.assertEqual(self.acquire(fence=0, code=3)['outcome'], 'conflict')
        second = self.acquire(fence=first['fence'])
        self.assertEqual(second['fence'], first['fence'] + 1)
        self.assertNotEqual(second['leaseId'], first['leaseId'])
        # Knowing the new public fence and stable owner does not give the old
        # holder the new lease identity.
        stale = (*self.credentials(second)[:-1], first['leaseId'])
        for action in ('release', 'renew', 'check'):
            self.assertEqual(self.run_lock(action, *stale, code=3)[1]['outcome'], 'stale')
        self.assertEqual(self.run_lock('check', *self.credentials(second))[1]['outcome'], 'current')

    def test_renew_expiry_boundary_reacquisition_and_boot_change(self):
        def run(action, boot, seconds, **kwargs):
            with patch.object(item_lock, 'clock', return_value=(boot, seconds * 1_000_000_000)):
                return item_lock.operation(action, self.ref, directory=self.state, **kwargs)

        def credentials(value):
            return {'owner': value['owner'], 'fence': value['fence'], 'lease_id': value['leaseId']}

        first = run('acquire', 'boot-1', 10, owner='worker-a', fence=0, ttl=3)
        renewed = run('renew', 'boot-1', 12, **credentials(first), ttl=10)
        self.assertEqual((renewed['fence'], renewed['remainingMs']), (1, 10_000))
        short = run('renew', 'boot-1', 13, **credentials(first), ttl=1)
        self.assertEqual(short['remainingMs'], 9_000)
        for action in ('renew', 'release', 'check'):
            self.assertEqual(run(action, 'boot-1', 22, **credentials(first), ttl=5)['outcome'], 'stale')
        second = run('acquire', 'boot-1', 22, owner='worker-b', fence=1, ttl=2)
        self.assertEqual(second['fence'], 2)
        self.assertEqual(run('inspect', 'boot-2', 0)['status'], 'expired')
        self.assertEqual(run('renew', 'boot-2', 0, **credentials(second), ttl=3)['outcome'], 'stale')
        self.assertEqual(run('acquire', 'boot-2', 0, owner='worker-c', fence=2, ttl=2)['fence'], 3)

    def test_killing_a_process_mid_transaction_rolls_back_and_preserves_cas(self):
        # Stop after the real acquire has updated SQLite but before its enclosing
        # context manager commits. A second process must see no phantom fence.
        worker, _ = self.start_worker('''
from contextlib import contextmanager
import time
import ledger_item_lock as lock
original = lock.transaction
@contextmanager
def stop_before_commit(*args, **kwargs):
    with original(*args, **kwargs) as db:
        yield db
        print("ready", flush=True)
        time.sleep(30)
lock.transaction = stop_before_commit
lock.operation("acquire", "work:A", owner="worker-a", fence=0, ttl=10)
''')
        self.kill_worker(worker)
        self.assertEqual(self.acquire(owner='worker-b')['fence'], 1)
        self.assertEqual(self.run_lock('inspect')[1]['owner'], 'worker-b')

    def test_guard_keeps_expired_lease_from_overlapping_successor_until_process_dies(self):
        worker, line = self.start_worker('''
import json
import time
import ledger_item_lock as lock
first = lock.operation("acquire", "work:A", owner="worker-a", fence=0, ttl=1)
with lock.guard_item_write("work:A", owner=first["owner"], fence=first["fence"], lease_id=first["leaseId"]):
    print(json.dumps(first), flush=True)
    time.sleep(30)
''')
        first = json.loads(line)
        self.assertEqual(self.acquire(ref='work:B')['fence'], 1)
        self.assertEqual(self.acquire(fence=1, owner='worker-b', code=1)['outcome'], 'busy')
        self.kill_worker(worker)
        self.assertEqual(self.run_lock('inspect')[1]['status'], 'expired')
        self.assertEqual(self.acquire(fence=1, owner='worker-b')['fence'], 2)
        with self.assertRaises(item_lock.StaleLease):
            with item_lock.guard_item_write(self.ref, directory=self.state, owner=first['owner'],
                                            fence=first['fence'], lease_id=first['leaseId']):
                self.fail('stale holder reached write')

    def test_ref_never_becomes_a_path_and_storage_errors_fail_closed(self):
        self.assertEqual(self.acquire(ref='not-a-ref', code=1)['outcome'], 'error')
        self.assertFalse(self.state.exists())
        self.acquire(ref='work:../../outside')
        files = list(self.state.iterdir())
        self.assertEqual(len(files), 1)
        self.assertRegex(files[0].name, r'^[a-f0-9]{64}\.sqlite3$')
        self.assertFalse((self.root / 'outside').exists())
        files[0].write_bytes(b'invalid sqlite bytes')
        self.assertEqual(self.run_lock('inspect', ref='work:../../outside', code=1)[1]['outcome'], 'error')


if __name__ == '__main__':
    unittest.main()
