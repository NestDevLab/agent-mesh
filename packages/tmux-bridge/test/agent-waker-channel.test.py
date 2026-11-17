import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('channel_waker', root / 'bin' / 'agent-waker.py')
waker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(waker)
uuid = '22222222-2222-4222-8222-222222222222'


class ChannelWakerTest(unittest.TestCase):
    def test_codex_backlog_wake_is_opt_in_and_uncertainty_is_not_retried(self):
        with tempfile.TemporaryDirectory() as directory:
            args = SimpleNamespace(state=str(Path(directory) / 'waker.json'), graph_state=str(Path(directory) / 'graph'), channel='example', job='test', producer=['fixture'], producer_timeout=1, managed_inbox_root=None, delivery_only=True, resume=False, wake_evidence_root=str(Path(directory) / 'evidence'))
            channel = {'phase': 'draining', 'session': f'codex:{uuid}', 'generation': 2, 'handover': {'backlog': ['one']}, 'queue': [{'id': 'one', 'state': 'accepted', 'session': f'codex:{uuid}', 'generation': 2, 'nativeQueueId': 'queue-1'}]}
            with patch.object(waker, 'run_producer', return_value=([], [])), patch.object(waker, 'channel_call', return_value=channel), patch.object(waker, 'start_codex_channel_wake', side_effect=ValueError('uncertain')) as start, patch.object(waker, 'deliver') as deliver, contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(waker.run(args), 3)
                self.assertEqual(waker.run(args), 3)
                self.assertEqual(start.call_count, 1)
                deliver.assert_not_called()
            self.assertEqual(json.loads(Path(args.state).read_text())['wakeAttempt']['status'], 'attempted')

    def test_codex_backlog_wake_requires_graph_settlement(self):
        with tempfile.TemporaryDirectory() as directory:
            args = SimpleNamespace(state=str(Path(directory) / 'waker.json'), graph_state=str(Path(directory) / 'graph'), channel='example', job='test', producer=['fixture'], producer_timeout=1, managed_inbox_root=None, delivery_only=True, resume=False, wake_evidence_root=str(Path(directory) / 'evidence'))
            evidence = 'codex-wake:' + 'a' * 64
            channel = {'phase': 'draining', 'session': f'codex:{uuid}', 'generation': 2, 'handover': {'backlog': ['one']}, 'queue': [{'id': 'one', 'state': 'accepted', 'session': f'codex:{uuid}', 'generation': 2, 'nativeQueueId': 'queue-1'}]}
            observed = {**channel, 'queue': [{**channel['queue'][0], 'state': 'observed', 'wakeEvidence': evidence}]}
            with patch.object(waker, 'run_producer', return_value=([], [])), patch.object(waker, 'channel_call', side_effect=[channel, observed]), patch.object(waker, 'start_codex_channel_wake', return_value=evidence), patch.object(waker, 'deliver') as deliver, contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(waker.run(args), 0)
                deliver.assert_not_called()
            self.assertEqual(json.loads(Path(args.state).read_text())['wakeAttempt']['status'], 'verified')

    def test_lost_claude_receipt_recovers_from_correlated_transcript_without_resend(self):
        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)
            state, sessions = tmp / 'graph', tmp / 'sessions'
            project = sessions / 'project'
            project.mkdir(parents=True, mode=0o700)
            sessions.chmod(0o700)
            target = f'claude:{uuid}'
            def call(*parts):
                proc = subprocess.run(['node', str(root / 'bin' / 'mesh-graph.mjs'), '--state', str(state), *parts], capture_output=True, text=True, check=True)
                return json.loads(proc.stdout)
            call('add', '--agent', 'claude', '--tmux-target', 'fixture', '--cwd', '/synthetic', '--runtime-uuid', uuid, '--json')
            call('migrate', '--apply', '--json')
            call('channel', 'create', '--name', 'example', '--session', target)
            call('channel', 'enqueue', '--name', 'example', '--id', 'one', '--input', 'fixture')
            call('channel', 'begin-delivery', '--name', 'example', '--id', 'one', '--session', target, '--generation', '1')
            record = {'schema': 'agent-mesh.monitor-inbox.v1', 'deliveryId': 'one', 'meshId': 'one', 'prompt': 'fixture'}
            message = 'AGENT_MESH_INBOX ' + json.dumps(record)
            transcript = project / (uuid + '.jsonl')
            transcript.write_text(json.dumps({'type': 'queue-operation', 'operation': 'enqueue', 'sessionId': uuid, 'content': message}) + '\n')
            transcript.chmod(0o600)
            args = SimpleNamespace(state=str(tmp / 'waker.json'), graph_state=str(state), channel='example', job='test', producer=['fixture'], producer_timeout=1, managed_inbox_root=None, delivery_only=True, resume=False)
            with patch.dict(os.environ, {'CLAUDE_SESSION_ROOT': str(sessions)}), patch.object(waker, 'run_producer', return_value=([], [])), patch.object(waker, 'deliver') as deliver, contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(waker.run(args), 3)
                self.assertEqual(call('channel', 'get', '--name', 'example')['channel']['queue'][0]['state'], 'inflight')
                with transcript.open('a') as stream:
                    stream.write(json.dumps({'type': 'user', 'sessionId': uuid, 'message': {'role': 'user', 'content': message}}) + '\n')
                self.assertEqual(waker.run(args), 0)
                self.assertEqual(waker.run(args), 0)
                deliver.assert_not_called()
            self.assertEqual(call('channel', 'get', '--name', 'example')['channel']['queue'][0]['state'], 'accepted')

    def test_draining_claude_backlog_waits_for_observation_without_resending(self):
        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)
            state, sessions = tmp / 'graph', tmp / 'sessions'
            project = sessions / 'project'
            project.mkdir(parents=True, mode=0o700)
            sessions.chmod(0o700)
            successor = '33333333-3333-4333-8333-333333333333'
            target = f'claude:{successor}'
            def call(*parts):
                proc = subprocess.run(['node', str(root / 'bin' / 'mesh-graph.mjs'), '--state', str(state), *parts], capture_output=True, text=True, check=True)
                return json.loads(proc.stdout)
            call('add', '--agent', 'codex', '--tmux-target', 'fixture', '--cwd', '/synthetic', '--runtime-uuid', uuid, '--json')
            call('migrate', '--apply', '--json')
            call('channel', 'create', '--name', 'example', '--session', f'codex:{uuid}')
            graph = call('show', '--json')
            channel = graph['channels'][0]
            channel.update(session=target, generation=2, phase='draining', handover={'predecessor': f'codex:{uuid}', 'previousGeneration': 1, 'successor': target, 'backlog': ['one']}, queue=[{'id': 'one', 'payload': 'fixture', 'state': 'accepted', 'session': target, 'generation': 2}])
            event = {'schema': 'agent-mesh.session-graph-event.v1', 'id': 'fixture-draining', 'type': 'channel.updated', 'at': '2026-01-01T00:00:00Z', 'channel': channel, 'seq': graph['lastSeq'] + 1, 'host': 'local'}
            with (state / 'events.jsonl').open('a') as stream:
                stream.write(json.dumps(event) + '\n')
            args = SimpleNamespace(state=str(tmp / 'waker.json'), graph_state=str(state), channel='example', job='test', producer=['fixture'], producer_timeout=1, managed_inbox_root=None, delivery_only=True, resume=False)
            record = {'schema': 'agent-mesh.monitor-inbox.v1', 'deliveryId': 'one', 'meshId': 'one', 'prompt': 'fixture'}
            message = 'AGENT_MESH_INBOX ' + json.dumps(record)
            transcript = project / (successor + '.jsonl')
            transcript.write_text(json.dumps({'type': 'queue-operation', 'operation': 'enqueue', 'sessionId': successor, 'content': message}) + '\n')
            transcript.chmod(0o600)
            with patch.dict(os.environ, {'CLAUDE_SESSION_ROOT': str(sessions)}), patch.object(waker, 'run_producer', return_value=([], [])), patch.object(waker, 'deliver') as deliver, contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(waker.run(args), 3)
                with transcript.open('a') as stream:
                    stream.write(json.dumps({'type': 'user', 'sessionId': successor, 'message': {'role': 'user', 'content': message}}) + '\n')
                self.assertEqual(waker.run(args), 0)
                self.assertEqual(waker.run(args), 0)
                deliver.assert_not_called()
            self.assertEqual(call('channel', 'get', '--name', 'example')['channel']['queue'][0]['state'], 'observed')

    def test_wake_reservation_survives_reload_and_blocks_handover(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / 'graph'
            def call(*args):
                return subprocess.run(['node', str(root / 'bin' / 'mesh-graph.mjs'), '--state', str(state), *args], capture_output=True, text=True)
            def ok(*args):
                result = call(*args)
                self.assertEqual(result.returncode, 0, result.stderr)
                return json.loads(result.stdout)
            session = f'codex:{uuid}'
            ok('add', '--agent', 'codex', '--tmux-target', 'fixture', '--cwd', '/synthetic', '--runtime-uuid', uuid, '--json')
            ok('migrate', '--apply', '--json')
            ok('channel', 'create', '--name', 'example', '--session', session)
            ok('channel', 'enqueue', '--name', 'example', '--id', 'message-1', '--input', 'fixture')
            ok('channel', 'begin-delivery', '--name', 'example', '--id', 'message-1', '--session', session, '--generation', '1')
            receipt = {'status': 'accepted', 'messageId': 'message-1', 'session': session, 'generation': 1, 'nativeQueueId': 'queue-1'}
            ok('channel', 'acknowledge', '--name', 'example', '--id', 'message-1', '--input', json.dumps(receipt))
            ok('channel', 'reserve-wake', '--name', 'example', '--id', 'message-1', '--session', session, '--generation', '1', '--input', 'queue-1')
            observed = ok('channel', 'get', '--name', 'example')['channel']
            self.assertEqual(observed['wakeReservation']['nativeQueueId'], 'queue-1')
            self.assertNotEqual(call('channel', 'begin-handover', '--name', 'example').returncode, 0)
            self.assertEqual(ok('channel', 'get', '--name', 'example')['channel']['phase'], 'active')

    def test_unsupported_recipient_does_not_reserve_delivery(self):
        with tempfile.TemporaryDirectory() as directory:
            args = SimpleNamespace(state=str(Path(directory) / 'waker.json'), graph_state='fixture', channel='example', job='test', producer=['fixture'], producer_timeout=1, managed_inbox_root=None, delivery_only=True, resume=False)
            queued = {'phase': 'active', 'session': 'claude-cloud:fixture:session_Test', 'generation': 1, 'queue': [{'id': 'one', 'state': 'pending', 'payload': 'fixture'}]}
            reserved = {**queued, 'queue': [{**queued['queue'][0], 'state': 'inflight', 'session': queued['session'], 'generation': 1}]}
            def call(args, operation, *options):
                return reserved if operation == 'begin-delivery' else queued
            with patch.object(waker, 'run_producer', return_value=([], [])), patch.object(waker, 'channel_call', side_effect=call) as channel_call, patch.object(waker, 'deliver') as deliver, contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(waker.run(args), 3)
                deliver.assert_not_called()
                self.assertNotIn('begin-delivery', [call.args[1] for call in channel_call.call_args_list])

    def test_native_adapter_receives_message_on_stdin(self):
        from unittest.mock import Mock
        receipt = {'status': 'queued', 'agent': 'codex', 'sessionId': uuid, 'correlationId': 'message-1', 'nativeQueueId': 'queue-1'}
        output = {}
        with patch.object(waker.subprocess, 'run', return_value=Mock(returncode=0, stdout=json.dumps(receipt))) as run:
            self.assertEqual(waker.deliver('codex', uuid, 'message-1', 'private fixture', None, True, message_stdin=True, receipt_out=output), 0)
        self.assertEqual(output, {'nativeQueueId': 'queue-1'})
        self.assertNotIn('private fixture', run.call_args.args[0])
        self.assertIn('--message-stdin', run.call_args.args[0])
        self.assertIn('--no-resume', run.call_args.args[0])
        self.assertEqual(run.call_args.kwargs['input'], 'private fixture')

    def test_cloud_queue_stays_inflight_and_is_not_resent(self):
        with tempfile.TemporaryDirectory() as directory:
            rootdir = Path(directory)
            profiles = rootdir / 'profiles'
            profiles.mkdir(mode=0o700)
            profile = profiles / 'fixture.json'
            profile.write_text('{}')
            profile.chmod(0o600)
            state = rootdir / 'graph'
            def call(*args):
                result = subprocess.run(['node', str(root / 'bin' / 'mesh-graph.mjs'), '--state', str(state), *args], capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                return json.loads(result.stdout)
            target = 'claude-cloud:fixture:session_Test'
            call('cloud', 'register', '--session', target, '--evidence', 'test:fixture')
            call('migrate', '--apply', '--json')
            call('channel', 'create', '--name', 'example', '--session', target)
            args = SimpleNamespace(state=str(rootdir / 'waker.json'), graph_state=str(state), channel='example', job='test', producer=['fixture'], producer_timeout=1, managed_inbox_root=None, delivery_only=True, resume=False, cloud_profile_root=str(profiles))
            with patch.object(waker, 'run_producer', return_value=([{'event': 'one'}], [])), patch.object(waker, 'deliver', return_value=0) as deliver, contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(waker.run(args), 3)
                self.assertEqual(waker.run(args), 3)
                self.assertEqual(deliver.call_count, 1)
                self.assertEqual(deliver.call_args.kwargs['cloud_scope'], 'fixture')
                self.assertEqual(deliver.call_args.kwargs['cloud_profile'], str(profile))
            item = call('channel', 'get', '--name', 'example')['channel']['queue'][0]
            self.assertEqual(item['state'], 'inflight')

    def test_cloud_adapter_requires_bound_queue_receipt(self):
        from unittest.mock import Mock
        receipt = {'status': 'queued', 'agent': 'claude', 'sessionId': 'session_Test', 'correlationId': 'message-1', 'transport': 'claude-cloud', 'readBack': False}
        with patch.object(waker.subprocess, 'run', return_value=Mock(returncode=0, stdout=json.dumps(receipt))) as run:
            self.assertEqual(waker.deliver('claude', 'session_Test', 'message-1', 'fixture', None, True, message_stdin=True, cloud_profile='/fixture/profile.json', cloud_scope='fixture'), 0)
        self.assertIn('--cloud', run.call_args.args[0])
        self.assertEqual(run.call_args.kwargs['input'], 'fixture')
        receipt['readBack'] = True
        with patch.object(waker.subprocess, 'run', return_value=Mock(returncode=0, stdout=json.dumps(receipt))):
            self.assertEqual(waker.deliver('claude', 'session_Test', 'message-1', 'fixture', None, True, message_stdin=True, cloud_profile='/fixture/profile.json', cloud_scope='fixture'), 78)

    def test_lost_reservation_response_does_not_send_or_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / 'graph'
            def call(*args):
                return json.loads(subprocess.run(['node', str(root / 'bin' / 'mesh-graph.mjs'), '--state', str(state), *args], check=True, capture_output=True, text=True).stdout)
            call('add', '--agent', 'codex', '--tmux-target', 'fixture', '--cwd', '/synthetic', '--runtime-uuid', uuid, '--json')
            call('migrate', '--apply', '--json')
            call('channel', 'create', '--name', 'example', '--session', f'codex:{uuid}')
            args = SimpleNamespace(state=str(Path(directory) / 'waker.json'), graph_state=str(state), channel='example', job='test', producer=['fixture'], producer_timeout=1, managed_inbox_root=None, delivery_only=True, resume=False)
            original = waker.channel_call
            def lost_response(args, operation, *options):
                result = original(args, operation, *options)
                if operation == 'begin-delivery':
                    raise subprocess.TimeoutExpired('fixture', 1)
                return result
            with patch.object(waker, 'run_producer', return_value=([{'event': 'one'}], [])), patch.object(waker, 'channel_call', side_effect=lost_response), patch.object(waker, 'deliver') as deliver, contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(waker.run(args), 3)
                deliver.assert_not_called()
            with patch.object(waker, 'run_producer', return_value=([], [])), patch.object(waker, 'deliver') as deliver, contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(waker.run(args), 3)
                deliver.assert_not_called()
            self.assertEqual(call('channel', 'get', '--name', 'example')['channel']['queue'][0]['state'], 'inflight')

    def test_lost_enqueue_response_retries_same_message_without_duplication(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / 'graph'
            def call(*args):
                return json.loads(subprocess.run(['node', str(root / 'bin' / 'mesh-graph.mjs'), '--state', str(state), *args], check=True, capture_output=True, text=True).stdout)
            call('add', '--agent', 'codex', '--tmux-target', 'fixture', '--cwd', '/synthetic', '--runtime-uuid', uuid, '--json')
            call('migrate', '--apply', '--json')
            call('channel', 'create', '--name', 'example', '--session', f'codex:{uuid}')
            call('channel', 'begin-handover', '--name', 'example')
            args = SimpleNamespace(state=str(Path(directory) / 'waker.json'), graph_state=str(state), channel='example', job='test', producer=['fixture'], producer_timeout=1, managed_inbox_root=None, delivery_only=True, resume=False)
            original = waker.channel_call
            def lost_response(args, operation, *options):
                result = original(args, operation, *options)
                if operation == 'enqueue':
                    raise subprocess.TimeoutExpired('fixture', 1)
                return result
            with patch.object(waker, 'run_producer', return_value=([{'event': 'one'}], [])), patch.object(waker, 'channel_call', side_effect=lost_response), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(waker.run(args), 3)
            with patch.object(waker, 'run_producer', return_value=([], [])), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(waker.run(args), 0)
            self.assertEqual(len(call('channel', 'get', '--name', 'example')['channel']['queue']), 1)
            self.assertEqual(json.loads(Path(args.state).read_text())['pending'], [])

    def test_unreadable_state_stops_before_producer_advances(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / 'waker.json'
            state.write_text('{broken')
            args = SimpleNamespace(state=str(state), graph_state=str(Path(directory) / 'graph'), channel='example', job='test', producer=['fixture'], producer_timeout=1, managed_inbox_root=None, delivery_only=True, resume=False)
            with patch.object(waker, 'run_producer') as producer, contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(waker.run(args), 3)
                producer.assert_not_called()
            self.assertEqual(state.read_text(), '{broken')

    def test_enqueue_during_handover_and_uncertain_delivery_blocks_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / 'graph'
            def call(*args):
                return json.loads(subprocess.run(['node', str(root / 'bin' / 'mesh-graph.mjs'), '--state', str(state), *args], check=True, capture_output=True, text=True).stdout)
            call('add', '--agent', 'codex', '--tmux-target', 'fixture', '--cwd', '/synthetic', '--runtime-uuid', uuid, '--json')
            call('migrate', '--apply', '--json')
            call('channel', 'create', '--name', '#example', '--session', f'codex:{uuid}')
            call('channel', 'begin-handover', '--name', '#example')
            args = SimpleNamespace(state=str(Path(directory) / 'waker.json'), graph_state=str(state), channel='#example', job='test', producer=['fixture'], producer_timeout=1, managed_inbox_root=None, delivery_only=True, resume=False)
            with patch.object(waker, 'run_producer', return_value=([{'event': 'one'}], [])), patch.object(waker, 'deliver') as deliver, contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(waker.run(args), 0)
                deliver.assert_not_called()
            channel = call('channel', 'get', '--name', '#example')['channel']
            self.assertEqual(channel['phase'], 'handover')
            self.assertEqual(channel['queue'][0]['state'], 'pending')
            self.assertEqual(json.loads(Path(args.state).read_text())['pending'], [])

    def test_accepted_delivery_is_bound_and_uncertainty_is_not_retried(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / 'graph'
            def call(*args):
                return json.loads(subprocess.run(['node', str(root / 'bin' / 'mesh-graph.mjs'), '--state', str(state), *args], check=True, capture_output=True, text=True).stdout)
            call('add', '--agent', 'codex', '--tmux-target', 'fixture', '--cwd', '/synthetic', '--runtime-uuid', uuid, '--json')
            call('migrate', '--apply', '--json')
            call('channel', 'create', '--name', 'example', '--session', f'codex:{uuid}')
            args = SimpleNamespace(state=str(Path(directory) / 'waker.json'), graph_state=str(state), channel='example', job='test', producer=['fixture'], producer_timeout=1, managed_inbox_root=None, delivery_only=True, resume=False)
            def accepted(*args, **kwargs):
                kwargs['receipt_out']['nativeQueueId'] = 'queue-1'
                return 0
            with patch.object(waker, 'run_producer', return_value=([{'event': 'one'}], [])), patch.object(waker, 'channel_call', wraps=waker.channel_call) as channel_call, patch.object(waker, 'deliver', side_effect=accepted) as deliver, contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(waker.run(args), 0)
                self.assertEqual(deliver.call_args.args[0:2], ('codex', uuid))
                reservation = next(call.args for call in channel_call.call_args_list if call.args[1] == 'begin-delivery')
                self.assertEqual(reservation[-2:], ('--generation', '1'))
            item = call('channel', 'get', '--name', 'example')['channel']['queue'][0]
            self.assertEqual(item['state'], 'accepted')
            self.assertEqual(item['nativeQueueId'], 'queue-1')
            self.assertEqual(item['session'], f'codex:{uuid}')
            self.assertEqual(item['generation'], 1)
            with patch.object(waker, 'run_producer', return_value=([{'event': 'two'}], [])), patch.object(waker, 'deliver', return_value=78) as deliver, contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(waker.run(args), 3)
                self.assertEqual(waker.run(args), 3)
                self.assertEqual(deliver.call_count, 1)
            self.assertEqual(call('channel', 'get', '--name', 'example')['channel']['queue'][1]['state'], 'inflight')


if __name__ == '__main__':
    unittest.main()
