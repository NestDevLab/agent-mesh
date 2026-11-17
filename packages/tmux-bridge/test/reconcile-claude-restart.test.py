import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

BIN = Path(__file__).resolve().parents[1] / 'bin'
spec = importlib.util.spec_from_file_location('reconcile_restart', BIN / 'reconcile-claude-restart.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
c = module.comms


class ReconcileRestartTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        patcher = patch.dict(os.environ, {'MESH_COMMS_STATE': self.tmp.name + '/comms', 'MESH_TMUX_SOCKET': 'fixture', 'AGENT_FALLBACK_STATE': self.tmp.name + '/fallback'})
        patcher.start(); self.addCleanup(patcher.stop)
        self.first = {'kind': 'tmux', 'runtime': 'claude', 'destination': 'fixture-target', 'socket': 'fixture',
                      'message': 'private fixture frame', 'message_stdin': True, 'correlation': 'first', 'timeout': 10}
        self.second = {**self.first, 'message': 'later fixture', 'correlation': 'later'}
        with c.locked() as (db, _):
            self.ident = c.admit(db, self.first)['id']
            self.assertEqual(c.admit(db, self.second)['status'], 'queued')
        self.checkpoint = {'id': 'launch', 'handoverId': 'handover', 'session': 'claude:old', 'generation': 1,
                           'status': 'invoking', 'stateSha256': 'a' * 64, 'profileSha256': 'b' * 64,
                           'successorSession': 'claude:12345678-1234-4234-8234-123456789abc',
                           'bridgeLaunchId': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}
        self.channel = {'phase': 'handover', 'successorLaunch': self.checkpoint}
        self.proof = {'schema': 'agent-mesh.claude-owned-restart-observation.v1', 'checkpoint': self.checkpoint.copy(),
                      'target': 'fixture-target', 'process': {'session': self.checkpoint['successorSession'], 'writerPid': 123, 'panePid': 122},
                      'launch': {'socket': 'fixture', 'launchId': self.checkpoint['bridgeLaunchId'], 'requestedSession': self.checkpoint['successorSession']},
                      'observation': {'session': self.checkpoint['successorSession'], 'stateSha256': self.checkpoint['stateSha256'],
                                      'frameSha256': hashlib.sha256(self.first['message'].encode()).hexdigest()}}
        self.args = dict(delivery_id=self.ident, graph_state='/fixture/graph', channel='fixture', writer_pid=123, pane_pid=122,
                         trusted_executable='/fixture/claude', transcript_root='/fixture/transcripts', launch_record='/fixture/launches')

    def fake_graph(self, argv, **kwargs):
        if 'observe-owned-restart' in argv:
            request = json.loads(kwargs['input'])
            self.assertEqual(request['frame'], self.first['message'])
            return subprocess.CompletedProcess(argv, 0, json.dumps(self.proof), '')
        return subprocess.CompletedProcess(argv, 0, json.dumps({'channel': self.channel}), '')

    def test_observation_preserves_unknown_and_does_not_flush(self):
        with patch.object(module.subprocess, 'run', side_effect=self.fake_graph) as run:
            result = module.reconcile(**self.args)
        self.assertEqual(result['status'], 'transcript-observed')
        self.assertEqual(result['execution'], 'unverified')
        self.assertEqual(result['delivery'], 'unknown')
        self.assertEqual(run.call_count, 3)
        self.assertNotIn(self.first['message'], json.dumps(result))
        with c.locked() as (db, _):
            rows = db.execute('SELECT status,detail,payload IS NOT NULL FROM deliveries ORDER BY seq').fetchall()
            self.assertEqual(rows, [('unknown', None, 1), ('queued', None, 1)])
            proof = db.execute('SELECT proof FROM restart_reconciliation').fetchone()[0]
            self.assertNotIn(self.first['message'], proof)
            self.assertEqual(db.execute('SELECT count(*) FROM restart_reconciliation').fetchone()[0], 1)
        with patch.object(module.subprocess, 'run', side_effect=self.fake_graph):
            with self.assertRaisesRegex(ValueError, 'already observed'):
                module.reconcile(**self.args)

    def test_changed_checkpoint_never_records_proof(self):
        calls = 0
        def changing(argv, **kwargs):
            nonlocal calls
            if 'observe-owned-restart' in argv:
                return self.fake_graph(argv, **kwargs)
            calls += 1
            value = self.channel if calls == 1 else {**self.channel, 'phase': 'active'}
            return subprocess.CompletedProcess(argv, 0, json.dumps({'channel': value}), '')
        with patch.object(module.subprocess, 'run', side_effect=changing):
            with self.assertRaisesRegex(ValueError, 'checkpoint changed'):
                module.reconcile(**self.args)
        with c.locked() as (db, _):
            self.assertEqual(db.execute('SELECT status FROM deliveries ORDER BY seq').fetchall(), [('unknown',), ('queued',)])
            self.assertIsNone(db.execute("SELECT name FROM sqlite_master WHERE name='restart_reconciliation'").fetchone())

    def test_mismatched_frame_or_process_preserves_unknown(self):
        for field in ('frameSha256', 'writerPid'):
            with self.subTest(field=field):
                if field == 'frameSha256':
                    self.proof['observation'][field] = '0' * 64
                else:
                    self.proof['process'][field] = 999
                with patch.object(module.subprocess, 'run', side_effect=self.fake_graph):
                    with self.assertRaisesRegex(ValueError, 'does not match'):
                        module.reconcile(**self.args)
                with c.locked() as (db, _):
                    self.assertEqual(db.execute('SELECT status FROM deliveries ORDER BY seq').fetchall(), [('unknown',), ('queued',)])
                self.proof['observation']['frameSha256'] = hashlib.sha256(self.first['message'].encode()).hexdigest()
                self.proof['process']['writerPid'] = 123


if __name__ == '__main__':
    unittest.main()
