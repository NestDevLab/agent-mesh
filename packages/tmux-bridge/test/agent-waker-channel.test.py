import contextlib
import importlib.util
import io
import json
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
    def test_native_adapter_receives_message_on_stdin(self):
        from unittest.mock import Mock
        receipt = {'status': 'queued', 'agent': 'codex', 'sessionId': uuid, 'correlationId': 'message-1'}
        with patch.object(waker.subprocess, 'run', return_value=Mock(returncode=0, stdout=json.dumps(receipt))) as run:
            self.assertEqual(waker.deliver('codex', uuid, 'message-1', 'private fixture', None, True, message_stdin=True), 0)
        self.assertNotIn('private fixture', run.call_args.args[0])
        self.assertIn('--message-stdin', run.call_args.args[0])
        self.assertEqual(run.call_args.kwargs['input'], 'private fixture')

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
            with patch.object(waker, 'run_producer', return_value=([{'event': 'one'}], [])), patch.object(waker, 'deliver', return_value=0) as deliver, contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(waker.run(args), 0)
                self.assertEqual(deliver.call_args.args[0:2], ('codex', uuid))
            self.assertEqual(call('channel', 'get', '--name', 'example')['channel']['queue'][0]['state'], 'accepted')
            with patch.object(waker, 'run_producer', return_value=([{'event': 'two'}], [])), patch.object(waker, 'deliver', return_value=78) as deliver, contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(waker.run(args), 3)
                self.assertEqual(waker.run(args), 3)
                self.assertEqual(deliver.call_count, 1)
            self.assertEqual(call('channel', 'get', '--name', 'example')['channel']['queue'][1]['state'], 'inflight')


if __name__ == '__main__':
    unittest.main()
