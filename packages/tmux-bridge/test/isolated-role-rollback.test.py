import importlib.util
import hashlib
import json
from pathlib import Path
import threading
import tempfile
import os
import subprocess
import sys
from unittest.mock import patch
import unittest


BIN = Path(__file__).resolve().parents[1] / 'bin'
spec = importlib.util.spec_from_file_location('isolated_role_rollback', BIN / 'isolated-role-rollback.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
SESSION = 'codex:22222222-2222-4222-8222-222222222222'
ASSESSMENT = {'schema': 'agent-mesh.codex-role-start-assessment.v1', 'session': SESSION,
              'status': 'rollback-required', 'failures': ['unexpected-permission-request']}
STOP = {'schema': 'agent-mesh.isolated-namespace-stop.v1', 'status': 'init-exited',
        'descendants': 'unverified', 'remoteEffects': 'unverified'}


class IsolatedRoleRollbackTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='rollback-journal-test-')
        self.addCleanup(self.directory.cleanup)
        self.root = self.directory.name

    def test_incomplete_observation_keeps_handover_blocked_without_stop(self):
        calls = []
        coordinator = module.IsolatedRoleRollback(SESSION, lambda: calls.append(True), self.root)
        assessment = {**ASSESSMENT, 'status': 'observed-incomplete', 'failures': []}
        self.assertEqual(coordinator.apply(assessment)['status'], 'blocked-incomplete')
        self.assertEqual(calls, [])

    def test_wrong_session_or_invalid_assessment_never_stops(self):
        with self.assertRaises(ValueError):
            module.IsolatedRoleRollback(SESSION.upper(), lambda: STOP, self.root)
        calls = []
        coordinator = module.IsolatedRoleRollback(SESSION, lambda: calls.append(True), self.root)
        for assessment in ({**ASSESSMENT, 'session': 'codex:33333333-3333-4333-8333-333333333333'},
                           {**ASSESSMENT, 'failures': []}, {**ASSESSMENT, 'status': 'ready'}):
            with self.assertRaises(ValueError):
                coordinator.apply(assessment)
        self.assertEqual(calls, [])

    def test_unsafe_assessment_stops_once_and_preserves_uncertainty(self):
        calls = []
        coordinator = module.IsolatedRoleRollback(SESSION, lambda: calls.append(True) or STOP, self.root)
        first = coordinator.apply(ASSESSMENT)
        self.assertEqual(first['status'], 'local-init-exited')
        self.assertEqual(first['handover'], 'blocked')
        self.assertEqual(first['namespaceStop']['descendants'], 'unverified')
        first['namespaceStop']['status'] = 'altered'
        self.assertEqual(coordinator.apply(ASSESSMENT)['namespaceStop']['status'], 'init-exited')
        self.assertEqual(calls, [True])

    def test_persisted_receipts_exclude_extra_callback_fields(self):
        coordinator = module.IsolatedRoleRollback(SESSION, lambda: {**STOP, 'extra': 'private-fixture'}, self.root)
        receipt = coordinator.apply(ASSESSMENT)
        key = hashlib.sha256(SESSION.encode()).hexdigest()
        intent = json.loads((Path(self.root) / f'stop-{key}.intent.json').read_text())
        saved = json.loads((Path(self.root) / f'stop-{key}.result.json').read_text())
        self.assertEqual(intent['session'], SESSION)
        self.assertEqual(saved, receipt)
        self.assertNotIn('private-fixture', json.dumps(saved))

    def test_lost_or_invalid_stop_receipt_stays_uncertain_without_retry(self):
        for index, stop in enumerate((lambda: (_ for _ in ()).throw(RuntimeError('lost')), lambda: {'status': 'ok'})):
            root = Path(self.root) / str(index)
            root.mkdir(mode=0o700)
            calls = []
            def wrapped():
                calls.append(True)
                return stop()
            coordinator = module.IsolatedRoleRollback(SESSION, wrapped, str(root))
            self.assertEqual(coordinator.apply(ASSESSMENT)['status'], 'stop-uncertain')
            self.assertEqual(coordinator.apply(ASSESSMENT)['status'], 'stop-uncertain')
            self.assertEqual(calls, [True])

    def test_concurrent_assessments_do_not_repeat_stop(self):
        calls, receipts = [], []
        coordinator = module.IsolatedRoleRollback(SESSION, lambda: calls.append(True) or STOP, self.root)
        threads = [threading.Thread(target=lambda: receipts.append(coordinator.apply(ASSESSMENT))) for _ in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(calls, [True])
        self.assertEqual([receipt['status'] for receipt in receipts], ['local-init-exited'] * 8)


    def test_distinct_coordinators_share_a_single_durable_reservation(self):
        calls, receipts = [], []
        coordinators = [module.IsolatedRoleRollback(SESSION, lambda: calls.append(True) or STOP, self.root) for _ in range(8)]
        threads = [threading.Thread(target=lambda c=c: receipts.append(c.apply(ASSESSMENT))) for c in coordinators]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(calls, [True])
        self.assertEqual(sum(item['status'] == 'local-init-exited' for item in receipts), 1)
        self.assertTrue(all(item['handover'] == 'blocked' for item in receipts))

    def test_process_death_after_reservation_blocks_retry(self):
        path = str(BIN / 'isolated-role-rollback.py')
        code = "import importlib.util,json,os,sys;spec=importlib.util.spec_from_file_location('r',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);c=m.IsolatedRoleRollback(sys.argv[2],lambda:os._exit(43),sys.argv[3]);c.apply(json.loads(sys.argv[4]))"
        result = subprocess.run([sys.executable, '-B', '-c', code, path, SESSION, self.root, json.dumps(ASSESSMENT)], timeout=5)
        self.assertEqual(result.returncode, 43)
        calls = []
        coordinator = module.IsolatedRoleRollback(SESSION, lambda: calls.append(True) or STOP, self.root)
        self.assertEqual(coordinator.apply(ASSESSMENT)['status'], 'stop-uncertain')
        self.assertEqual(calls, [])

    def test_unwritable_or_invalid_journal_never_invokes_stop(self):
        calls = []
        os.chmod(self.root, 0o755)
        try:
            coordinator = module.IsolatedRoleRollback(SESSION, lambda: calls.append(True) or STOP, self.root)
            with self.assertRaises(ValueError):
                coordinator.apply(ASSESSMENT)
        finally:
            os.chmod(self.root, 0o700)
        self.assertEqual(calls, [])
        coordinator = module.IsolatedRoleRollback(SESSION, lambda: calls.append(True) or STOP, self.root)
        with patch.object(module, '_write_once', side_effect=OSError('intent unavailable')):
            with self.assertRaises(OSError):
                coordinator.apply(ASSESSMENT)
        self.assertEqual(calls, [])

    def test_replaced_journal_root_blocks_before_stop(self):
        root = Path(self.root) / 'journal'
        root.mkdir(mode=0o700)
        renamed = Path(self.root) / 'renamed'
        original = module._write_once
        calls = []
        def replace_after_reservation(directory_fd, name, value):
            original(directory_fd, name, value)
            root.rename(renamed)
            root.mkdir(mode=0o700)
        coordinator = module.IsolatedRoleRollback(SESSION, lambda: calls.append(True) or STOP, str(root))
        with patch.object(module, '_write_once', side_effect=replace_after_reservation):
            with self.assertRaisesRegex(ValueError, 'root changed'):
                coordinator.apply(ASSESSMENT)
        self.assertEqual(calls, [])
        self.assertEqual(len(list(renamed.glob('*.intent.json'))), 1)

    def test_lost_result_persistence_remains_uncertain_without_retry(self):
        calls = []
        original = module._write_once
        def write(directory_fd, name, value):
            if name.endswith('.result.json'):
                raise OSError('result unavailable')
            return original(directory_fd, name, value)
        coordinator = module.IsolatedRoleRollback(SESSION, lambda: calls.append(True) or STOP, self.root)
        with patch.object(module, '_write_once', side_effect=write):
            self.assertEqual(coordinator.apply(ASSESSMENT)['status'], 'stop-uncertain')
        restarted = module.IsolatedRoleRollback(SESSION, lambda: calls.append(True) or STOP, self.root)
        self.assertEqual(restarted.apply(ASSESSMENT)['status'], 'stop-uncertain')
        self.assertEqual(calls, [True])


if __name__ == '__main__':
    unittest.main()
