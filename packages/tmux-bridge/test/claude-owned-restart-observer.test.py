import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

base = Path(__file__).resolve().parents[1] / 'bin'
spec = importlib.util.spec_from_file_location('observer', base / 'claude-owned-restart-observer.py')
observer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(observer)
UUID = '12345678-1234-4234-8234-123456789abc'
SESSION = 'claude:' + UUID
BODY = 'fixture restart\n'
DIGEST = hashlib.sha256(BODY.encode()).hexdigest()
NONCE = 'a' * 32
FRAME = f'AGENT-MESH-RESTART {NONCE} {len(BODY.encode())} {DIGEST}\n{BODY}\nAGENT-MESH-RESTART-END {NONCE}'


class OwnedRestartObservationTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        script = root / 'fixture.py'
        script.write_text('import time; time.sleep(30)\n')
        self.process = subprocess.Popen([sys.executable, str(script), '--session-id', UUID])
        def stop():
            if self.process.poll() is None:
                self.process.kill()
            self.process.wait()
        self.addCleanup(stop)
        transcripts = root / 'transcripts'
        transcripts.mkdir()
        transcript = transcripts / (UUID + '.jsonl')
        transcript.write_text(json.dumps({'type': 'user', 'sessionId': UUID,
                                          'message': {'role': 'user', 'content': FRAME}}) + '\n')
        transcript.chmod(0o600)
        self.checkpoint = {'id': 'launch', 'handoverId': 'handover', 'session': 'claude:old',
                           'generation': 1, 'status': 'invoking', 'stateSha256': DIGEST,
                           'successorSession': SESSION, 'profileSha256': 'b' * 64}
        self.args = dict(writer_pid=self.process.pid, pane_pid=os.getpid(), session=SESSION,
                         trusted_executable=sys.executable, transcript_root=str(transcripts),
                         frame=FRAME, state_sha256=DIGEST, profile_sha256='b' * 64, handover_id='handover', launch_id='launch',
                         source_session='claude:old', generation=1,
                         read_checkpoint=lambda: self.checkpoint.copy(), node_executable='/usr/local/bin/node')

    def test_returns_only_digests_and_bound_identity(self):
        proof = observer.observe_owned_restart(**self.args)
        self.assertEqual(proof['process']['session'], SESSION)
        self.assertEqual(proof['observation']['stateSha256'], DIGEST)
        self.assertNotIn(BODY, json.dumps(proof))

    def test_fails_if_checkpoint_changes_while_reading(self):
        count = 0
        def read():
            nonlocal count
            count += 1
            return {**self.checkpoint, 'status': 'cancelled' if count > 1 else 'invoking'}
        self.args['read_checkpoint'] = read
        with self.assertRaisesRegex(RuntimeError, 'checkpoint mismatch'):
            observer.observe_owned_restart(**self.args)

    def test_fails_if_writer_exits_during_observation(self):
        count = 0
        def read():
            nonlocal count
            count += 1
            if count == 2:
                self.process.terminate()
                self.process.wait(timeout=3)
            return self.checkpoint.copy()
        self.args['read_checkpoint'] = read
        with self.assertRaises((RuntimeError, ProcessLookupError, FileNotFoundError)):
            observer.observe_owned_restart(**self.args)

    def test_wrong_frame_or_reservation_is_rejected(self):
        self.args['frame'] = FRAME + ' altered'
        with self.assertRaisesRegex(RuntimeError, 'transcript observation failed'):
            observer.observe_owned_restart(**self.args)
        self.args['frame'] = FRAME
        self.checkpoint['successorSession'] = 'claude:other'
        with self.assertRaisesRegex(RuntimeError, 'checkpoint mismatch'):
            observer.observe_owned_restart(**self.args)


if __name__ == '__main__':
    unittest.main()
