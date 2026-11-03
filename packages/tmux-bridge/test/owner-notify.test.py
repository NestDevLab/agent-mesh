#!/usr/bin/env python3
"""Hermetic owner routing, crash recovery and turn identity regressions."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

BIN = Path(__file__).resolve().parents[1] / 'bin'
spec = importlib.util.spec_from_file_location('owner_notify', BIN / 'agent-owner-notify.py')
n = importlib.util.module_from_spec(spec)
spec.loader.exec_module(n)
THREAD = '11111111-1111-4111-8111-111111111111'
OWNER = '22222222-2222-4222-8222-222222222222'
FALLBACK = '33333333-3333-4333-8333-333333333333'


class OwnerNotify(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.rollout = self.root / (THREAD + '.jsonl')
        self.rollout.write_text('')
        self.state = self.root / 'state'
        self.mail = self.root / 'mail'
        self.mail.mkdir()
        self.launch = self.root / 'launch.jsonl'
        self.launch.write_text('')
        self.graph = self.root / 'graph.json'
        self.config = {'launchEvents': str(self.launch), 'managedInboxRoot': str(self.mail),
                       'fallbackSession': FALLBACK, 'graphPath': str(self.graph)}
        for name, target, value in [('candidates', n.follow.watch, 'transcript_candidates')]:
            p = patch.object(target, value, return_value=[(THREAD, self.rollout)])
            p.start(); self.addCleanup(p.stop)
        p = patch.object(n, 'live', return_value=True)
        self.live = p.start(); self.addCleanup(p.stop)
        p = patch.object(n.waker, 'deliver', side_effect=self.delivery)
        self.send = p.start(); self.addCleanup(p.stop)
        n.tick(self.config, self.state)  # baseline

    def delivery(self, agent, recipient, key, message, mailbox, only):
        n.append(Path(mailbox) / (recipient + '.jsonl'), {'deliveryId': key, 'prompt': message})
        return 0

    def record(self, kind, **payload):
        with self.rollout.open('a') as stream:
            stream.write(json.dumps({'type': 'event_msg', 'timestamp': '2099-01-01T00:00:00Z',
                                      'payload': {'type': kind, **payload}}) + '\n')

    def owned(self, caller=OWNER):
        self.launch.write_text(json.dumps({'event': 'launch.started', 'agent': 'codex', 'launchId': 'a', 'caller': caller,
                                          'tmuxTarget': 'example', 'threadId': None}) + '\n' +
                               json.dumps({'event': 'launch.thread_resolved', 'launchId': 'a', 'threadId': THREAD}) + '\n')

    def finish(self, turn='t1', message='Complete'):
        self.record('task_started', turn_id=turn)
        self.record('task_complete', turn_id=turn, last_agent_message=message)

    def receipts(self):
        return [json.loads(line) for line in (self.state / 'receipts.jsonl').read_text().splitlines()]

    def tick(self):
        return n.tick(self.config, self.state)

    def test_owner_and_dedupe_across_ticks_and_terminal_duplicates(self):
        self.owned(); self.finish()
        self.assertEqual(self.tick()['notices'], 1)
        self.assertEqual(self.send.call_args.args[1], OWNER)
        self.record('task_complete', turn_id='t1', last_agent_message='duplicate')
        self.assertEqual(self.tick()['notices'], 0)
        self.assertEqual(self.send.call_count, 1)
        self.finish('t2'); self.tick()
        self.assertEqual(len(self.receipts()), 2)
        self.assertEqual(self.receipts()[0]['tmuxTarget'], 'example')

    def test_unknown_and_dead_fallback(self):
        self.finish(); self.tick()
        self.assertEqual(self.receipts()[-1]['reason'], 'owner-unknown')
        self.owned(); self.live.side_effect = lambda root, owner: owner != OWNER
        self.finish('t2'); self.tick()
        self.assertEqual(self.receipts()[-1]['reason'], 'owner-dead')
        self.assertEqual(self.send.call_args.args[1], FALLBACK)

    def test_graph_fallback_and_ambiguity(self):
        graph = {'nodes': [{'id': 'c', 'agent': 'codex', 'runtimeUuid': THREAD},
                           {'id': 'o', 'agent': 'claude', 'runtimeUuid': OWNER}],
                 'edges': [{'from': 'o', 'to': 'c', 'type': 'delegates-to'}]}
        self.graph.write_text(json.dumps(graph));self.finish();self.tick()
        self.assertEqual(self.receipts()[-1]['owner'], OWNER)
        graph['nodes'].append({'id': 'x', 'agent': 'claude', 'runtimeUuid': FALLBACK})
        graph['edges'].append({'from': 'x', 'to': 'c', 'type': 'spawned-by'})
        self.assertIsNone(n.owner_for(THREAD, {}, graph)['owner'])
        self.owned()
        self.assertEqual(n.owner_for(THREAD, n.launches(self.launch), graph)['owner'], OWNER)

    def test_refused_delivery_retained_then_retried(self):
        self.owned();self.finish();self.send.side_effect = None;self.send.return_value = 3
        self.assertEqual(self.tick()['pending'], 1)
        self.assertEqual(self.receipts()[-1]['outcome'], 'pending')
        self.send.side_effect = self.delivery
        self.assertEqual(self.tick()['pending'], 0)
        self.assertEqual(self.receipts()[-1]['outcome'], 'routed')

    def test_crash_after_inbox_append_does_not_redeliver(self):
        self.owned();self.finish()
        real = n.append
        def crash(path, value):
            if path.name == 'receipts.jsonl':
                raise OSError('simulated crash')
            real(path, value)
        with patch.object(n, 'append', side_effect=crash):
            with self.assertRaises(OSError):self.tick()
        self.assertEqual(self.send.call_count, 1)
        self.tick();self.assertEqual(self.send.call_count, 1)
        self.assertEqual(len(self.receipts()), 1)

    def test_dead_fallback_stays_pending(self):
        self.live.return_value = False;self.finish()
        self.assertEqual(self.tick()['pending'], 1)
        self.assertFalse(self.send.called)

    def test_noise_work_and_echo_excluded(self):
        for reason, delta in [('excluded-ref', {'excludeRefs': ['codex:' + THREAD]}),
                              ('excluded-work', {'excludePromptPrefixes': ['TB:']}),
                              ('noise', {'noise': {'promptPrefixes': ['TB:']}})]:
            self.config.update(delta)
            self.record('user_message', message='TB: example')
            self.finish(reason);self.tick()
            self.assertEqual(self.receipts()[-1]['outcome'], 'skipped')
            self.assertEqual(self.receipts()[-1]['reason'], reason)
            for key in delta:del self.config[key]
        self.owned(THREAD);self.finish('echo');self.tick()
        self.assertEqual(self.receipts()[-1]['reason'], 'own-echo')
        self.assertFalse(self.send.called)

    def test_partial_record_and_incremental_final_excerpt(self):
        self.owned();self.record('task_started', turn_id='p')
        self.record('agent_message', phase='final', message='x' * 400)
        self.tick()
        row = json.dumps({'type': 'event_msg', 'timestamp': '2099-01-01T00:00:00Z', 'payload': {'type': 'task_complete', 'turn_id': 'p'}})
        with self.rollout.open('a') as f:f.write(row)
        self.tick();self.assertFalse(self.send.called)
        with self.rollout.open('a') as f:f.write('\n')
        self.tick();self.assertEqual(len(self.receipts()[-1]['excerpt']), 300)

    def test_error_question_goal_statuses(self):
        self.owned();self.record('task_started', turn_id='e');self.record('error', message='failed');self.tick()
        self.assertEqual(self.receipts()[-1]['status'], 'error')
        self.finish('q', 'Choose A?');self.tick()
        self.assertEqual(self.receipts()[-1]['status'], 'question')
        for value, expected in [('complete', 'achieved'), ('blocked', 'blocked'), ('budget_limited', 'blocked')]:
            self.record('task_started', turn_id=value)
            with self.rollout.open('a') as f:f.write(json.dumps({'type': 'response_item', 'payload': {'type': 'custom_tool_call_output',
                'output': [{'type': 'input_text', 'text': json.dumps({'goal': {'threadId': THREAD, 'status': value}})}]}}) + '\n')
            self.record('task_complete', turn_id=value, last_agent_message='Native goal status')
            self.tick();self.assertEqual(self.receipts()[-1]['status'], expected)

    def test_initial_history_is_not_sent(self):
        self.finish('old');self.owned()
        other = self.root / 'baseline'
        self.assertEqual(n.tick(self.config, other)['notices'], 0)
        self.assertFalse(self.send.called)

    def test_launch_target_reuse_does_not_change_old_owner(self):
        self.owned()
        with self.launch.open('a') as f:f.write(json.dumps({'event': 'launch.started', 'agent': 'codex', 'launchId': 'b',
            'tmuxTarget': 'example', 'caller': FALLBACK, 'threadId': '44444444-4444-4444-8444-444444444444'}) + '\n')
        self.finish();self.tick();self.assertEqual(self.receipts()[-1]['owner'], OWNER)


if __name__ == '__main__':
    unittest.main()
