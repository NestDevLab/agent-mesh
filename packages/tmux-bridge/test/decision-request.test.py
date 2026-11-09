#!/usr/bin/env python3
"""Synthetic decision-request card and delivery contract fixtures."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import shlex
import stat
import subprocess
import tempfile
import unittest
from unittest import mock

BIN = Path(__file__).resolve().parents[1] / 'bin'
spec = importlib.util.spec_from_file_location('agent_decision', BIN / 'agent-decision.py')
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)

ORIGIN = 'codex:11111111-1111-4111-8111-111111111111'
CLOUD = 'cloud:session_ExampleOnly'
ACCEPTED = subprocess.CompletedProcess([], 0, 'Sent to cloud session.\n', '')


def request(**changes):
    return dict({'id': 'WORK-1', 'question': 'Ship  the\nnew flow?', 'where': 'https://example.test/thread/1',
                 'waitingSince': '2026-03-27T12:00:00+01:00', 'options': [
                     {'id': 'later', 'label': 'Wait', 'consequence': 'Ships next week'},
                     {'id': 'ship', 'label': 'Ship', 'consequence': 'Live today', 'recommended': True, 'reason': 'Tests pass'},
                 ]}, **changes)


TOKEN = cli.decisions.semantic_hash(cli.decisions.make_request_card(request()))[:16]


class Cards(unittest.TestCase):
    def test_recommended_first_and_fixed_exits_last(self):
        card = cli.decisions.make_request_card(request())
        self.assertEqual([o['id'] for o in card['options']], ['ship', 'later', 'discuss', 'other'])
        self.assertEqual(card['options'][0]['reason'], 'Tests pass')
        self.assertEqual(card['question'], 'Ship the new flow?')
        self.assertEqual(card['waitingSince'], '2026-03-27T11:00:00Z')

    def test_labels_are_host_presentation(self):
        card = cli.decisions.make_request_card(request(), labels={'other': 'Custom', 'discuss': 'Talk'})
        self.assertEqual([o['label'] for o in card['options'][2:]], ['Talk', 'Custom'])

    def test_rejects_malformed_requests(self):
        option = {'id': 'a', 'label': 'A', 'consequence': 'C', 'recommended': True, 'reason': 'R'}
        plain = {'id': 'b', 'label': 'B', 'consequence': 'C'}
        for bad in (request(options=[]), request(options=[option, plain, {**plain, 'id': 'c'}]),
                    request(options=[plain]), request(options=[option, {**option, 'id': 'b'}]),
                    request(options=[{**option, 'reason': ' '}]), request(options=[{**option, 'id': 'other'}]),
                    request(options=[option, {**plain, 'id': 'a'}]), request(options=[{**option, 'consequence': ''}]),
                    request(options=[{**option, 'id': '--flag'}]), request(options=[{**option, 'id': 'a b'}]),
                    request(id='../escape'), request(question=' '), request(where=''),
                    request(waitingSince='2026-03-27T12:00:00')):
            with self.assertRaises(ValueError):
                cli.decisions.make_request_card(bad)

    def test_answer_matches_option_id_only(self):
        card = cli.decisions.make_request_card(request())
        self.assertEqual(cli.decisions.resolve_answer(card, 'ship')['label'], 'Ship')
        for args in (('Ship',), ('other',), ('ship', 'extra words')):
            with self.assertRaises(ValueError):
                cli.decisions.resolve_answer(card, *args)
        self.assertEqual(cli.decisions.resolve_answer(card, 'other', 'my words')['id'], 'other')


class Delivery(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name) / 'state'
        self.request_file = Path(temporary.name) / 'request.json'
        self.request_file.write_text(json.dumps(request()))
        cloud = mock.patch.object(cli.subprocess, 'run', return_value=ACCEPTED)
        native = mock.patch.object(cli.waker, 'deliver', return_value=0)
        self.cloud, self.native = cloud.start(), native.start()
        self.addCleanup(cloud.stop)
        self.addCleanup(native.stop)

    def main(self, argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = cli.main(argv)
        return code, json.loads(out.getvalue() or err.getvalue())

    def run_cli(self, *argv):
        return self.main(['--state', str(self.root), *argv])

    def send(self, *extra):
        return self.run_cli('send', '--request', str(self.request_file), '--from', ORIGIN, '--to', CLOUD, *extra)

    def answer(self, *extra):
        return self.run_cli('answer', 'WORK-1', '--card-hash', TOKEN, '--by', 'Owner', '--card', 'msg-1', *extra)

    def crash_when(self, stamped):
        real = cli.follow.atomic_json
        def write(path, record):
            if stamped(record):
                raise RuntimeError('crashed')
            real(path, record)
        return mock.patch.object(cli.follow, 'atomic_json', side_effect=write)

    def record(self):
        return json.loads((self.root / 'WORK-1.json').read_text())

    def test_cloud_send_uses_exact_transport_once(self):
        self.assertEqual(self.send(), (0, {'id': 'WORK-1', 'outcome': 'request-sent'}))
        command = self.cloud.call_args.args[0]
        self.assertEqual(command[:4], ['claude', '-p', '--cloud', 'session_ExampleOnly'])
        self.assertEqual(self.cloud.call_args.kwargs['stdin'], subprocess.DEVNULL)
        self.assertIn('"id": "ship"', command[4])
        self.assertEqual(self.send(), (0, {'id': 'WORK-1', 'outcome': 'request-already-sent'}))
        self.assertEqual(self.cloud.call_count, 1)
        self.assertEqual(stat.S_IMODE(self.root.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((self.root / 'WORK-1.json').stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE((self.root / 'receipts.jsonl').stat().st_mode), 0o600)

    def test_unconfirmed_transport_stays_pending_then_retries(self):
        for result in (subprocess.CompletedProcess([], 0, 'something else\n', ''),
                       subprocess.CompletedProcess([], 1, 'Sent to cloud session.\n', ''),
                       subprocess.TimeoutExpired('claude', 30)):
            self.cloud.side_effect = [result]
            self.assertEqual(self.send()[0], cli.PENDING)
            self.assertIsNone(self.record()['sentAt'])
        self.cloud.side_effect = None
        self.assertEqual(self.send()[0], 0)
        self.assertIsNotNone(self.record()['sentAt'])

    def test_changed_content_under_one_id_is_refused(self):
        self.assertEqual(self.send()[0], 0)
        self.request_file.write_text(json.dumps(request(question='Something else?')))
        self.assertEqual(self.send()[0], cli.INVALID)
        self.assertEqual(self.cloud.call_count, 1)

    def test_answer_returns_to_codex_origin_scoped_to_the_question(self):
        self.send()
        code, result = self.answer('--option', 'ship', '--at', '2026-03-27T13:00:00Z')
        self.assertEqual((code, result['outcome']), (0, 'answer-returned'))
        args, kwargs = self.native.call_args
        self.assertEqual(args[:2], ('codex', ORIGIN.split(':')[1]))
        self.assertEqual(kwargs, {'resume': True})
        self.assertIn('"Ship"', args[3])
        self.assertIn('2026-03-27T13:00:00Z', args[3])
        self.assertIn('Ship the new flow?', args[3])
        self.assertIn('that one question only', args[3])

    def test_answer_rejects_unknown_unsent_and_conflicting(self):
        self.assertEqual(self.answer('--option', 'ship')[0], cli.INVALID)
        self.send()
        self.assertEqual(self.answer('--option', 'Ship')[0], cli.INVALID)
        self.assertEqual(self.answer('--option', 'other')[0], cli.INVALID)
        self.assertEqual(self.answer('--option', 'ship')[0], 0)
        self.assertEqual(self.answer('--option', 'later')[0], cli.INVALID)
        self.assertEqual(self.record()['answer']['optionId'], 'ship')

    def test_answer_retries_after_refusal_with_the_first_choice(self):
        self.send()
        self.native.return_value = 78
        self.assertEqual(self.answer('--option', 'ship', '--at', '2026-03-27T13:00:00Z')[0], cli.PENDING)
        self.native.return_value = 0
        self.assertEqual(self.answer('--option', 'ship')[0], 0)
        self.assertEqual(self.native.call_args_list[0].args[2], self.native.call_args_list[1].args[2])
        self.assertEqual(self.record()['answer']['at'], '2026-03-27T13:00:00Z')
        self.assertEqual(self.answer('--option', 'ship')[1]['outcome'], 'answer-already-returned')
        self.assertEqual(self.native.call_count, 2)

    def test_another_cards_answer_is_refused(self):
        self.send()
        code, _ = self.run_cli('answer', 'WORK-1', '--card-hash', '0' * 16, '--option', 'ship', '--by', 'Owner', '--card', 'msg-2')
        self.assertEqual(code, cli.INVALID)
        self.assertIsNone(self.record()['answer'])
        self.native.assert_not_called()

    def test_blank_owner_or_card_is_refused(self):
        self.send()
        for by, card in ((' ', 'msg-1'), ('Owner', '')):
            code, _ = self.run_cli('answer', 'WORK-1', '--card-hash', TOKEN, '--option', 'ship', '--by', by, '--card', card)
            self.assertEqual(code, cli.INVALID)
        self.assertIsNone(self.record()['answer'])

    def test_delivered_answer_command_finds_custom_state_and_config(self):
        config = self.root.parent / 'host config.json'
        config.write_text(json.dumps({'target': CLOUD, 'labels': {'other': 'Custom'}}))
        self.assertEqual(self.run_cli('--config', str(config), 'send', '--request', str(self.request_file), '--from', ORIGIN)[0], 0)
        line = self.cloud.call_args.args[0][4].splitlines()[-1].split('Once the owner picks: ')[1]
        command = shlex.split(line.split(' --option')[0])
        self.assertEqual(Path(command[0]).name, 'agent-decision.py')
        self.assertEqual(command[1:5], ['--config', str(config.resolve()), '--state', str(self.root.resolve())])
        self.assertEqual(self.main(command[1:] + ['--option', 'ship', '--by', 'Owner', '--card', 'msg-1'])[0], 0)

    def test_crash_after_delivery_retries_with_the_same_key(self):
        send = ('send', '--request', str(self.request_file), '--from', ORIGIN, '--to', ORIGIN)
        with self.crash_when(lambda record: record['sentAt']), self.assertRaises(RuntimeError):
            self.run_cli(*send)
        self.assertIsNone(self.record()['sentAt'])
        self.assertEqual(self.run_cli(*send)[1]['outcome'], 'request-sent')
        with self.crash_when(lambda record: record['answer'] and record['answer']['returnedAt']), self.assertRaises(RuntimeError):
            self.answer('--option', 'ship')
        self.assertEqual(self.answer('--option', 'ship')[1]['outcome'], 'answer-returned')
        keys = [call.args[2] for call in self.native.call_args_list]
        self.assertEqual(len(keys), 4)
        self.assertEqual((keys[0], keys[2]), (keys[1], keys[3]))

    def test_claude_target_needs_a_live_inbox(self):
        target = 'claude:22222222-2222-4222-8222-222222222222'
        with mock.patch.object(cli.notify, 'live', return_value=False):
            self.assertEqual(self.run_cli('send', '--request', str(self.request_file), '--from', ORIGIN, '--to', target)[0], cli.PENDING)
        self.native.assert_not_called()
        with mock.patch.object(cli.notify, 'live', return_value=True):
            self.assertEqual(self.run_cli('send', '--request', str(self.request_file), '--from', ORIGIN, '--to', target)[0], 0)
        self.assertEqual(self.native.call_args.args[0], 'claude')
        self.assertTrue(self.native.call_args.args[5])

    def test_bad_refs_are_refused_before_any_delivery(self):
        for ref in ('cloud:--help', 'cloud:session_x;rm', 'claude:not-a-uuid', 'human:someone'):
            self.assertEqual(self.run_cli('send', '--request', str(self.request_file), '--from', ORIGIN, '--to', ref)[0], cli.INVALID)
        self.cloud.assert_not_called()


if __name__ == '__main__':
    unittest.main()
