import importlib.util
from pathlib import Path
import threading
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
    def test_incomplete_observation_keeps_handover_blocked_without_stop(self):
        calls = []
        coordinator = module.IsolatedRoleRollback(SESSION, lambda: calls.append(True))
        assessment = {**ASSESSMENT, 'status': 'observed-incomplete', 'failures': []}
        self.assertEqual(coordinator.apply(assessment)['status'], 'blocked-incomplete')
        self.assertEqual(calls, [])

    def test_wrong_session_or_invalid_assessment_never_stops(self):
        calls = []
        coordinator = module.IsolatedRoleRollback(SESSION, lambda: calls.append(True))
        for assessment in ({**ASSESSMENT, 'session': 'codex:33333333-3333-4333-8333-333333333333'},
                           {**ASSESSMENT, 'failures': []}, {**ASSESSMENT, 'status': 'ready'}):
            with self.assertRaises(ValueError):
                coordinator.apply(assessment)
        self.assertEqual(calls, [])

    def test_unsafe_assessment_stops_once_and_preserves_uncertainty(self):
        calls = []
        coordinator = module.IsolatedRoleRollback(SESSION, lambda: calls.append(True) or STOP)
        first = coordinator.apply(ASSESSMENT)
        self.assertEqual(first['status'], 'local-init-exited')
        self.assertEqual(first['handover'], 'blocked')
        self.assertEqual(first['namespaceStop']['descendants'], 'unverified')
        first['namespaceStop']['status'] = 'altered'
        self.assertEqual(coordinator.apply(ASSESSMENT)['namespaceStop']['status'], 'init-exited')
        self.assertEqual(calls, [True])

    def test_lost_or_invalid_stop_receipt_stays_uncertain_without_retry(self):
        for stop in (lambda: (_ for _ in ()).throw(RuntimeError('lost')), lambda: {'status': 'ok'}):
            calls = []
            def wrapped():
                calls.append(True)
                return stop()
            coordinator = module.IsolatedRoleRollback(SESSION, wrapped)
            self.assertEqual(coordinator.apply(ASSESSMENT)['status'], 'stop-uncertain')
            self.assertEqual(coordinator.apply(ASSESSMENT)['status'], 'stop-uncertain')
            self.assertEqual(calls, [True])

    def test_concurrent_assessments_do_not_repeat_stop(self):
        calls, receipts = [], []
        coordinator = module.IsolatedRoleRollback(SESSION, lambda: calls.append(True) or STOP)
        threads = [threading.Thread(target=lambda: receipts.append(coordinator.apply(ASSESSMENT))) for _ in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(calls, [True])
        self.assertEqual([receipt['status'] for receipt in receipts], ['local-init-exited'] * 8)


if __name__ == '__main__':
    unittest.main()
