#!/usr/bin/env python3
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

BIN = Path(__file__).resolve().parents[1] / 'bin'
spec = importlib.util.spec_from_file_location('observer', BIN / 'agent-plexus-observer.py')
observer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(observer)


class ObserverTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / 'observer'
        self.receipt = Path(self.tmp.name) / 'waker.json'
        self.config = {'destination': 'codex:owner', 'wakerState': str(self.receipt),
                       'maxPages': 1, 'subscriptions': [{'id': 'test', 'all': True}]}
        self.calls = []
        self.pages = []

    def ask(self, config, name, values):
        self.calls.append((name, values))
        if name == 'search':
            return {'sessions': [{'sessionId': 'codex:visible', 'project': 'demo'},
                                 {'sessionId': 'codex:private', 'project': None}], 'cursor': None}
        if values.get('initial') == 'head':
            return {'reset': False, 'events': [], 'cursor': 'opaque:baseline'}
        return self.pages.pop(0) if self.pages else {'reset': False, 'events': [], 'cursor': values['sinceCursor']}

    def tick(self):
        return observer.producer(self.config, self.root, self.ask)

    def stage(self, events=None):
        self.assertEqual(self.tick()['new'], [])
        self.pages.append({'reset': False, 'cursor': 'opaque:next', 'events': events or [
            {'eventId': 'event:1', 'type': 'session.updated', 'session': 'codex:visible'}]})
        return self.tick()

    def ack(self, result):
        self.receipt.write_text(json.dumps({'lastDelivery': {'itemKeys': [observer.waker.item_key(result['new'][0])],
                                                          'correlationId': 'transport-only'}}))

    def test_quiet_exact_baseline_and_postbaseline_event(self):
        result = self.stage()
        self.assertEqual(self.calls[0], ('changes', {'initial': 'head'}))
        self.assertEqual(self.calls[1][1]['sinceCursor'], 'opaque:baseline')
        self.assertEqual(len(result['new']), 1)

    def test_hold_restart_and_receipt_keep_distinct_states(self):
        result = self.stage()
        state = json.loads((self.root / 'state.json').read_text())
        self.assertEqual(state['cursors']['test'], 'opaque:baseline')
        self.assertEqual(state['pending']['cursors']['test'], 'opaque:next')
        count = len(self.calls)
        # A gate hold has no matching transport acknowledgement, even after restart.
        self.receipt.write_text(json.dumps({'pending': [], 'lastDelivery': {'itemKeys': ['unrelated']}}))
        self.assertEqual(self.tick(), result)
        self.assertEqual(len(self.calls), count)
        self.ack(result)
        self.assertEqual(self.tick()['new'], [])
        state = json.loads((self.root / 'state.json').read_text())
        self.assertEqual(state['cursors']['test'], 'opaque:next')
        report = json.loads(next((self.root / 'reports').iterdir()).read_text())
        self.assertEqual(report['actorResponse'], 'unverified')
        self.assertEqual(report['kind'], 'system-event')

    def test_project_unknown_and_cross_scope_are_excluded_with_gap(self):
        self.config['subscriptions'] = [{'id': 'project', 'projects': ['demo']}]
        self.tick()  # coverage gap is itself durable and visible
        state = json.loads((self.root / 'state.json').read_text())
        self.ack({'new': [state['pending']['item']]})
        self.tick()
        self.pages.append({'cursor': 'next', 'events': [
            {'eventId': 'ok', 'type': 'session.updated', 'session': 'codex:visible'},
            {'eventId': 'hidden', 'type': 'session.updated', 'session': 'codex:private'},
            {'eventId': 'cross', 'type': 'edge.added', 'from': 'codex:visible', 'to': 'codex:private'}]})
        result = self.tick()
        report = json.loads(Path(result['new'][0]['detail'].split(' | ')[0]).read_text())
        self.assertEqual([e['eventId'] for e in report['events']], ['ok'])

    def test_self_types_sessions_and_native_ref_filter(self):
        self.config['subscriptions'] = [{'id': 'test', 'sessions': ['codex:visible'],
                                         'refs': ['item:demo'], 'eventTypes': ['edge.added']}]
        result = self.stage([
            {'eventId': 'self', 'type': 'edge.added', 'from': 'codex:owner', 'to': 'item:demo', 'ref': 'item:demo'},
            {'eventId': 'wrong', 'type': 'session.updated', 'session': 'codex:visible'},
            {'eventId': 'ok', 'type': 'edge.added', 'from': 'codex:visible', 'to': 'item:demo', 'ref': 'item:demo'}])
        self.assertEqual(self.calls[-1][1]['refs'], ['item:demo'])
        report = json.loads(Path(result['new'][0]['detail'].split(' | ')[0]).read_text())
        self.assertEqual([e['eventId'] for e in report['events']], ['ok'])

    def test_reset_recovery_and_replayed_event_dedup(self):
        result = self.stage()
        self.ack(result)
        self.tick()
        self.pages.append({'reset': True, 'events': [], 'cursor': 'new:head'})
        reset = self.tick()
        report = json.loads(Path(reset['new'][0]['detail'].split(' | ')[0]).read_text())
        self.assertEqual(report['events'][0]['type'], 'observer.reset')
        self.ack(reset)
        self.tick()
        self.pages.append({'cursor': 'new:tail', 'events': [
            {'eventId': 'event:1', 'type': 'session.updated', 'session': 'codex:visible'}]})
        self.assertEqual(self.tick()['new'], [])

    def test_invalid_scope_changed_config_and_catalog_bound_fail_closed(self):
        self.tick()
        self.config['destination'] = 'codex:other'
        with self.assertRaises(ValueError):
            self.tick()
        self.config['subscriptions'] = [{'id': 'none'}]
        with self.assertRaises(ValueError):
            observer.validate(self.config)
        with self.assertRaises(RuntimeError):
            observer.catalog({'maxCatalogPages': 1}, lambda *args: {'sessions': [], 'cursor': 'more'})

    def test_event_log_guard_and_query_timeout_fail_closed(self):
        graph = Path(self.tmp.name) / 'graph'
        graph.mkdir()
        (graph / 'events.jsonl').write_bytes(b'too large')
        with patch.object(observer.subprocess, 'run') as run:
            with self.assertRaises(RuntimeError):
                observer.query({'graphState': str(graph), 'maxEventBytes': 2}, 'changes', {})
            run.assert_not_called()
        with patch.object(observer.subprocess, 'run', side_effect=observer.subprocess.TimeoutExpired('node', 30)):
            with self.assertRaises(RuntimeError):
                observer.query({'graphState': str(graph)}, 'changes', {})

    def test_failed_state_save_does_not_ack_or_advance(self):
        self.tick()
        self.pages.append({'cursor': 'next', 'events': [{'eventId': 'one', 'type': 'session.updated', 'session': 'codex:x'}]})
        real_save = observer.save
        def fail_state(path, value):
            if path.name == 'state.json':
                raise OSError('simulated crash')
            real_save(path, value)
        with patch.object(observer, 'save', side_effect=fail_state), self.assertRaises(OSError):
            self.tick()
        state = json.loads((self.root / 'state.json').read_text())
        self.assertEqual(state['cursors']['test'], 'opaque:baseline')
        self.assertIsNone(state['pending'])


if __name__ == '__main__':
    unittest.main()
