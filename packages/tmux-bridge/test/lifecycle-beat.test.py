#!/usr/bin/env python3
"""Synthetic native API fixtures for lifecycle beat durability and noise policy."""
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

BIN = Path(__file__).resolve().parents[1] / 'bin'
spec = importlib.util.spec_from_file_location('lifecycle_beat', BIN / 'agent-lifecycle-beat.py')
beat = importlib.util.module_from_spec(spec)
spec.loader.exec_module(beat)
REF = 'codex:11111111-1111-4111-8111-111111111111'


def item(**changes):
    return {'ref': 'work:EXAMPLE-1', 'title': 'Synthetic review', 'status': 'waiting',
            'updatedAt': '2026-03-28T12:00:00Z', 'domain': 'Example',
            'waitingOn': {'who': 'human', 'ask': 'Choose candidate', 'urgency': 'high'},
            'resumeCondition': 'Proceed with candidate A.', 'url': 'https://example.test/work/1', **changes}


class LifecycleBeat(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state = self.root / 'beat'
        self.follow_root = self.root / 'follow'
        self.follow_root.mkdir()
        self.config = {'followerRoot': str(self.follow_root), 'wakerState': str(self.root / 'waker.json')}
        environment = patch.dict(os.environ, {'XDG_STATE_HOME': str(self.root / 'xdg')})
        environment.start()
        self.addCleanup(environment.stop)
        tick = patch.object(beat.follow, 'tick', return_value=0)
        self.tick = tick.start()
        self.addCleanup(tick.stop)

    def row(self, seq=1, kind='REPLY', body='Ordinary progress', **changes):
        return {'seq': seq, 'event_id': 'event-' + str(seq), 'ref': REF, 'kind': kind, 'body': body,
                'timestamp': '2026-03-28T12:00:00Z', 'selection': {'label': 'Example', 'mode': 'observe'}, **changes}

    def outbox(self, rows):
        with beat.follow.locked(self.follow_root / 'state.lock'):
            beat.follow.append_outbox(self.follow_root, [{key: value for key, value in row.items() if key != 'seq'} for row in rows])

    def acknowledge(self):
        state = beat.read_state(self.state / 'state.json')
        beat.save(Path(self.config['wakerState']), {'lastDelivery': {'itemKeys': state['staged']['keys']}})

    def report(self, result):
        return json.loads(Path(result['new'][0]['report']).read_text())

    def test_ordinary_deferred_latest_nonempty_and_no_change_quiet(self):
        self.outbox([self.row(), self.row(2, body='Latest\nprogress'), self.row(3, body='   ')])
        self.assertEqual(beat.producer(self.config, self.state, epoch=100)['new'], [])
        self.assertEqual(beat.producer(self.config, self.state, epoch=101)['new'], [])
        result = beat.producer(self.config, self.state, epoch=1900)
        self.assertEqual(self.report(result)['summary'], [{'ref': REF, 'detail': 'Latest progress'}])
        self.assertEqual(self.report(result)['immediate'], [])
        self.assertEqual(self.report(result)['decisions'], [])

    def test_explicit_completion_and_errors_are_immediate_deduplicated(self):
        rows = [self.row(1, completion='task', turn_id='turn-1', body='Complete'),
                self.row(2, completion='task', turn_id='turn-1', body='Duplicate marker'),
                self.row(3, kind='ERROR', body='Failure', turn_id='turn-2'),
                self.row(4, kind='NEW', body='Discovery is not immediate')]
        self.outbox(rows)
        result = beat.producer(self.config, self.state, epoch=100)
        report = self.report(result)
        self.assertEqual([event['kind'] for event in report['immediate']], ['REPLY', 'ERROR'])
        self.assertEqual(report['summary'], [])

    def test_empty_final_is_not_synthesized_into_a_reply(self):
        events, ordinary, _, _, _ = beat.events_since([self.row(completion='task', body='')], beat.initial())
        self.assertEqual((events, ordinary), ([], {}))

    def test_staged_delivery_failure_returns_identical_items_and_holds_sources(self):
        self.outbox([self.row(kind='ERROR', body='Capacity failure')])
        first = beat.producer(self.config, self.state, epoch=100)
        with patch.object(beat, 'decision_delta', side_effect=AssertionError('source advanced while pending')):
            second = beat.producer(self.config, self.state, epoch=200)
        self.assertEqual(first, second)
        self.assertEqual(self.tick.call_count, 2)
        self.assertEqual(len(list((self.state / 'reports').glob('*.json'))), 1)

    def test_summary_cleared_only_on_delivery_ack_and_unchanged_detail_stays_quiet(self):
        self.outbox([self.row()])
        beat.producer(self.config, self.state, epoch=100)
        first = beat.producer(self.config, self.state, epoch=1900)
        self.assertTrue(beat.read_state(self.state / 'state.json')['ordinary'])
        self.assertEqual(beat.producer(self.config, self.state, epoch=2000), first)
        self.acknowledge()
        self.assertEqual(beat.producer(self.config, self.state, epoch=2001)['new'], [])
        self.assertEqual(beat.read_state(self.state / 'state.json')['ordinary'], {})
        self.outbox([self.row(2)])
        self.assertEqual(beat.producer(self.config, self.state, epoch=4000)['new'], [])

    def test_full_card_in_immutable_report_and_compact_path_first(self):
        exact = 'Exact source sentence. ' * 80
        source = item(resumeCondition=exact)
        with patch.object(beat, 'fetch_changes', return_value=([source], None, [], True)):
            result = beat.producer(self.config, self.state, epoch=1774699200)
        report = self.report(result)
        self.assertEqual(report['decisions'][0]['options'][0]['action']['value'], exact)
        self.assertEqual(next(iter(result['new'][0])), 'report')
        self.assertNotIn('Choose candidate', json.dumps(result))
        state = beat.read_state(self.state / 'state.json')
        self.assertEqual(state['decisions'], {})
        self.assertNotIn('Exact source sentence', json.dumps(state))
        self.assertEqual(Path(result['new'][0]['report']).stat().st_mode & 0o777, 0o600)

    def test_question_timestamp_changes_are_quiet_after_ack(self):
        with patch.object(beat, 'fetch_changes', return_value=([item()], None, [], True)):
            beat.producer(self.config, self.state, epoch=1774699200)
        self.acknowledge()
        changed_timestamp = item(updatedAt='2026-03-28T13:00:00Z')
        with patch.object(beat, 'fetch_changes', return_value=([changed_timestamp], None, [], True)):
            result = beat.producer(self.config, self.state, epoch=1774699300)
        self.assertEqual(result['new'], [])
        self.assertTrue(beat.read_state(self.state / 'state.json')['decisions'])

    def test_due_describes_only_due_refs_and_delegates_calendar_state(self):
        card = beat.card_for(item(), {})
        _, metadata = beat.decisions.select_due([card], {}, '2026-03-28T12:00:00Z', 'Europe/Amsterdam')
        state = {**beat.initial(), 'humanRefs': [item()['ref']], 'decisions': metadata}
        epoch = beat.decisions._instant('2026-03-29T07:00:00Z').timestamp()
        with patch.object(beat, 'fetch_changes', return_value=([], None, [], True)), patch.object(beat, 'describe_refs', return_value=([item()], [], [])) as describe:
            cards, candidate, *_ = beat.decision_delta({'timezone': 'Europe/Amsterdam'}, state, epoch)
        self.assertEqual(describe.call_args.args[1], {item()['ref']})
        self.assertEqual(len(cards), 1)
        self.assertEqual(candidate[item()['ref']]['nextDue'], '2026-03-31T07:00:00Z')

    def test_explicit_closure_forgets_membership_and_reminder(self):
        card = beat.card_for(item(), {})
        _, metadata = beat.decisions.select_due([card], {}, '2026-03-28T12:00:00Z', 'UTC')
        state = {**beat.initial(), 'humanRefs': [item()['ref']], 'decisions': metadata}
        with patch.object(beat, 'fetch_changes', return_value=([item(status='done')], None, [], True)):
            cards, candidate, refs, *_ = beat.decision_delta({}, state, 1774699300)
        self.assertEqual((cards, candidate, refs), ([], {}, []))

    def test_real_native_partial_error_retains_canonical_cursor(self):
        config = {'ledgerScheme': 'work'}
        with beat.ledger.cursor_store() as (path, state):
            state['cursors']['work:lifecycle-beat'] = 'before'
            beat.ledger.save(path, state)
        response = {'schema': beat.ledger.SCHEMA, 'items': [item()], 'errors': [{'ref': item()['ref']}],
                    'cursor': 'partial', 'more': True}
        with patch.object(beat.ledger, 'adapters', return_value={'work': {}}), patch.object(beat.ledger, 'invoke', return_value=response):
            items, intent, errors, enabled = beat.fetch_changes(config, 'lifecycle-beat')
        self.assertEqual(items, [])
        self.assertIsNone(intent)
        self.assertTrue(errors)
        self.assertTrue(enabled)
        with beat.ledger.cursor_store() as (_, state):
            self.assertEqual(state['cursors']['work:lifecycle-beat'], 'before')

    def test_native_cursor_cas_does_not_overwrite_another_consumer_or_newer_page(self):
        with beat.ledger.cursor_store() as (path, state):
            state['cursors'].update({'work:lifecycle-beat': 'newer', 'work:other': 'untouched'})
            beat.ledger.save(path, state)
        self.assertFalse(beat.commit_cursor({'key': 'work:lifecycle-beat', 'before': 'older', 'cursor': 'candidate'}))
        with beat.ledger.cursor_store() as (_, state):
            self.assertEqual(state['cursors'], {'work:lifecycle-beat': 'newer', 'work:other': 'untouched'})

    def test_full_only_first_page_and_exact_cursor_commit_after_staging(self):
        requests = []
        pages = iter([{'schema': beat.ledger.SCHEMA, 'items': [item()], 'errors': [], 'cursor': 'one', 'more': True},
                      {'schema': beat.ledger.SCHEMA, 'items': [], 'errors': [], 'cursor': 'two', 'more': False}])
        def invoke(adapter, operation, request):
            requests.append(request)
            return next(pages)
        config = {**self.config, 'ledgerScheme': 'work'}
        with patch.object(beat.ledger, 'adapters', return_value={'work': {}}), patch.object(beat.ledger, 'invoke', side_effect=invoke):
            result = beat.producer(config, self.state, full=True, epoch=1774699200)
        self.assertTrue(requests[0]['full'])
        self.assertNotIn('full', requests[1])
        self.assertEqual(requests[1]['cursor'], 'one')
        self.assertTrue(Path(result['new'][0]['report']).is_file())
        with beat.ledger.cursor_store() as (_, state):
            self.assertEqual(state['cursors']['work:lifecycle-beat'], 'two')

    def test_job_failure_timestamps_do_not_repeat(self):
        config = {**self.config, 'jobs': [{'name': 'Example', 'maxAgeHours': 1}]}
        failure = {'job': 'Example', 'status': 'failed', 'outcome': 'failed', 'checkedAt': 'first', 'ageHours': 2}
        with patch.object(beat.receipts, 'check_job', return_value=failure):
            first = beat.producer(config, self.state, epoch=100)
        self.assertEqual(self.report(first)['immediate'][0]['kind'], 'JOB')
        self.acknowledge()
        with patch.object(beat.receipts, 'check_job', return_value={**failure, 'checkedAt': 'later', 'ageHours': 3}):
            self.assertEqual(beat.producer(config, self.state, epoch=200)['new'], [])

    def test_interview_all_members_and_explicit_native_tool_question_only(self):
        output = self.root / 'interview.json'
        inventory = {'sessions': [{'sessionId': REF, 'nativeId': REF.split(':')[1], 'harness': 'codex',
                                  'title': 'Tool question', 'lastSeenAt': '2026-03-28T12:00:00Z',
                                  'lifecycle': {'pendingQuestion': True, 'question': 'Select source'}},
                                 {'sessionId': 'casual', 'lifecycle': {'pendingQuestion': False, 'question': 'Casual?'}}]}
        with patch.object(beat, 'fetch_changes', return_value=([item(resumeCondition=None)], None, [], True)):
            result = beat.interview(self.config, self.state, output, inventory)
        report = json.loads(output.read_text())
        self.assertEqual(result['decisions'], 2)
        self.assertTrue(all(card['sourceGap'] for card in report['decisions']))
        self.assertEqual(len(report['decisions'][0]['options']), 2)
        self.assertTrue(any(card['where'] == 'codex://threads/' + REF.split(':')[1] for card in report['decisions']))

    def test_outbox_read_and_repair_occurs_under_native_follow_lock(self):
        self.outbox([self.row(kind='ERROR')])
        original = beat.follow.outbox
        def checked(root):
            # tick is stubbed, so producer owns the native state.lock here.
            import fcntl
            descriptor = os.open(root / 'state.lock', os.O_RDWR)
            try:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            finally:
                os.close(descriptor)
            return original(root)
        with patch.object(beat.follow, 'outbox', side_effect=checked):
            self.assertTrue(beat.producer(self.config, self.state, epoch=100)['new'])

    def formal_question(self, answered=False):
        event = {'source_event_id': 'formal-question', 'kind': 'question', 'body': 'Choose a source',
                 'timestamp': '2026-03-28T12:00:00Z'}
        events = [event]
        if answered:
            events.append({'source_event_id': 'answer', 'kind': 'human_message', 'body': 'Use A'})
        _, pending = beat.follow.derive(REF, {'mode': 'observe'}, events, {})
        beat.save(beat.follow.cursor_path(self.follow_root, REF), {'pending': pending})
        self.outbox([self.row(kind='QUESTION', body=event['body'], event_id='formal-question')])

    def test_formal_question_is_immediate_open_source_decision(self):
        self.formal_question()
        config = {**self.config, 'decisionDestination': 'Example decision owner'}
        source = ({REF: {'title': 'Synthetic native thread', 'domains': ['Example']}}, {}, {}, 'graph')
        with patch.object(beat.follow, 'session_source', return_value=source):
            result = beat.producer(config, self.state, epoch=1774699200)
        report = self.report(result)
        self.assertEqual(len(report['decisions']), 1)
        card = report['decisions'][0]
        self.assertEqual(card['question'], 'Choose a source')
        self.assertTrue(card['sourceGap'])
        self.assertNotIn('joseph_sentence', card)
        self.assertEqual(card['options'][0]['action']['kind'], 'open-source')
        self.assertEqual(report['decisionDestination'], 'Example decision owner')
        self.assertEqual(result['new'][0]['decisionDestination'], report['decisionDestination'])

    def test_formal_question_already_answered_in_batch_is_quiet(self):
        self.formal_question(answered=True)
        with patch.object(beat.follow, 'session_source', side_effect=AssertionError('metadata not needed')):
            self.assertEqual(beat.producer(self.config, self.state, epoch=100)['new'], [])

    def test_failed_tick_keeps_uncertain_question_sequence(self):
        self.formal_question()
        self.tick.side_effect = RuntimeError('synthetic source failure')
        first = beat.producer(self.config, self.state, epoch=100)
        self.assertEqual(beat.read_state(self.state / 'state.json')['seq'], 0)
        self.acknowledge()
        self.tick.side_effect = None
        with patch.object(beat.follow, 'session_source', return_value=({}, {}, {}, None)):
            result = beat.producer(self.config, self.state, epoch=101)
        self.assertEqual(len(self.report(result)['decisions']), 1)
        self.assertNotEqual(first['new'], result['new'])

    def test_recommended_sentence_alias_is_verbatim(self):
        exact = '  Exact source decision sentence.  '
        card = beat.card_for(item(resumeCondition=exact), {})
        self.assertEqual(card['joseph_sentence'], exact)
        self.assertEqual(card['options'][0]['action']['value'], exact)

    def test_excluded_or_self_events_questions_and_interviews_are_quiet(self):
        self.formal_question()
        self.outbox([self.row(2, kind='ERROR', body='Excluded failure')])
        config = {**self.config, 'excludeRefs': [REF, item()['ref']]}
        with patch.object(beat.follow, 'session_source', side_effect=AssertionError('excluded ref metadata read')):
            self.assertEqual(beat.producer(config, self.state, epoch=100)['new'], [])
        self.assertEqual(beat.events_since([self.row(kind='ERROR')], beat.initial(), {'selfRef': REF})[0], [])
        output = self.root / 'excluded-interview.json'
        inventory = {'sessions': [{'sessionId': REF, 'nativeId': REF.split(':')[1], 'harness': 'codex',
                                  'lifecycle': {'pendingQuestion': True, 'question': 'Choose'}}]}
        with patch.object(beat, 'fetch_changes', return_value=([item()], None, [], True)):
            result = beat.interview(config, self.root / 'interview-state', output, inventory)
        self.assertEqual(result['decisions'], 0)
        self.assertEqual(json.loads(output.read_text())['errors'], [])

    def test_ack_after_cursor_conflict_retains_pending_intent_until_success(self):
        intent = {'key': 'work:lifecycle-beat', 'before': 'before', 'cursor': 'candidate'}
        with patch.object(beat, 'fetch_changes', return_value=([item()], intent, [], True)), patch.object(beat, 'commit_cursor', return_value=False):
            first = beat.producer(self.config, self.state, epoch=1774699200)
        self.acknowledge()
        with patch.object(beat, 'commit_cursor', return_value=False):
            pending = beat.producer(self.config, self.state, epoch=1774699201)
        self.assertEqual(first['new'], pending['new'])
        state = beat.read_state(self.state / 'state.json')
        self.assertEqual(state['staged']['ledgerCommit'], intent)
        self.assertEqual(state['decisions'], {})
        with patch.object(beat, 'commit_cursor', return_value=True):
            self.assertEqual(beat.producer(self.config, self.state, epoch=1774699202)['new'], [])
        state = beat.read_state(self.state / 'state.json')
        self.assertIsNone(state['staged'])
        self.assertTrue(state['decisions'])

    def test_fixed_source_fault_reawakens_after_recovery(self):
        self.tick.side_effect = RuntimeError('synthetic source failure')
        first = beat.producer(self.config, self.state, epoch=100)
        self.acknowledge()
        self.assertEqual(beat.producer(self.config, self.state, epoch=101)['new'], [])
        self.tick.side_effect = None
        self.assertEqual(beat.producer(self.config, self.state, epoch=102)['new'], [])
        self.tick.side_effect = RuntimeError('synthetic source failure')
        second = beat.producer(self.config, self.state, epoch=103)
        self.assertTrue(second['new'])
        self.assertNotEqual(first['new'], second['new'])

    def test_no_adapter_is_quiet_and_no_raw_source_reader_exists(self):
        self.assertEqual(beat.producer(self.config, self.state, epoch=100), {'new': [], 'errors': []})
        source = (BIN / 'agent-lifecycle-beat.py').read_text()
        self.assertNotIn('sqlite3', source)
        self.assertNotIn('read_records(', source)
        self.assertNotIn('transcript_candidates(', source)
        self.assertEqual((BIN / 'agent-lifecycle-beat.py').read_bytes(), (BIN.parents[2] / 'skills/agent-tmux/bin/agent-lifecycle-beat.py').read_bytes())


if __name__ == '__main__':
    unittest.main()
