import hashlib
import datetime
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

    def test_graph_reads_its_locked_checkpoint_and_does_not_settle(self):
        graph = str(base / 'mesh-graph.mjs')
        state = str(Path(self.tmp.name) / 'graph')
        node = '/usr/local/bin/node'
        def call(*args, input=None, check=True):
            return subprocess.run([node, graph, '--state', state, *args], input=input,
                                  text=True, capture_output=True, check=check, timeout=15)
        old_id = '22222222-2222-4222-8222-222222222222'
        source = 'claude:' + old_id
        call('add', '--agent', 'claude', '--tmux-target', 'fixture', '--cwd', '/tmp', '--runtime-uuid', old_id, '--json')
        call('migrate', '--apply', '--json')
        call('channel', 'create', '--name', 'fixture', '--session', source)
        handover = json.loads(call('channel', 'begin-handover', '--name', 'fixture').stdout)['channel']['handoverId']
        graph_state = json.loads(call('show', '--json').stdout)
        channel = next(item for item in graph_state['channels'] if item['id'] == 'fixture')
        channel['successorLaunch'] = {**self.checkpoint, 'session': source, 'handoverId': handover}
        event = {'schema': 'agent-mesh.session-graph-event.v1', 'id': 'fixture-invoking',
                 'type': 'channel.updated', 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                 'channel': channel, 'seq': graph_state['lastSeq'] + 1, 'host': 'local'}
        events = Path(state) / 'events.jsonl'
        with events.open('a') as output:
            output.write(json.dumps(event) + '\n')
        before = events.read_bytes()
        request = {'writerPid': self.process.pid, 'panePid': os.getpid(), 'session': SESSION,
                   'trustedExecutable': sys.executable, 'transcriptRoot': self.args['transcript_root'],
                   'frame': FRAME, 'stateSha256': DIGEST, 'profileSha256': 'b' * 64,
                   'handoverId': handover, 'launchId': 'launch', 'sourceSession': source, 'generation': 1}
        args = ('channel', 'observe-owned-restart', '--name', 'fixture', '--input', '-')
        proof = json.loads(call(*args, input=json.dumps(request)).stdout)
        self.assertEqual(proof['checkpoint']['status'], 'invoking')
        self.assertEqual(events.read_bytes(), before)
        request['profileSha256'] = '0' * 64
        self.assertNotEqual(call(*args, input=json.dumps(request), check=False).returncode, 0)
        self.assertEqual(events.read_bytes(), before)

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
