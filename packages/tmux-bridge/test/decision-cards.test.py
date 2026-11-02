#!/usr/bin/env python3
"""Synthetic decision-card and calendar-backoff contract fixtures."""
import copy
import importlib.util
from pathlib import Path
import unittest

BIN = Path(__file__).resolve().parents[1] / 'bin'
spec = importlib.util.spec_from_file_location('agent_decisions', BIN / 'agent-decisions.py')
decisions = importlib.util.module_from_spec(spec)
spec.loader.exec_module(decisions)


def item(**changes):
    return dict({'ref': 'WORK-1', 'title': 'Review candidate', 'status': 'waiting',
                 'updatedAt': '2026-03-27T12:00:00Z', 'domain': 'Example',
                 'waitingOn': {'who': 'human', 'ask': 'Which candidate\nshould proceed?'},
                 'resumeCondition': 'Proceed with candidate A.',
                 'url': 'https://example.test/work/1'}, **changes)


def card(**changes):
    return decisions.make_decision(item(**changes))


class DecisionCards(unittest.TestCase):
    def test_exact_sentence_and_two_explicit_actions(self):
        result = card(resumeCondition='  Exact source sentence.\nPreserve this.  ')
        self.assertEqual(result['question'], 'Which candidate should proceed?')
        self.assertEqual(result['id'], 'WORK-1')
        self.assertEqual(result['project'], 'Example')
        self.assertTrue(result['discuss'])
        self.assertFalse(result['sourceGap'])
        self.assertEqual(len(result['options']), 2)
        self.assertTrue(result['options'][0]['recommended'])
        self.assertEqual(result['options'][0]['action'], {
            'kind': 'source-sentence', 'value': '  Exact source sentence.\nPreserve this.  '})
        self.assertEqual(result['options'][1]['action']['kind'], 'discuss-at-source')

    def test_missing_sentence_never_invents_consent(self):
        result = card(resumeCondition=None)
        self.assertTrue(result['sourceGap'])
        self.assertEqual(result['options'][0]['action'], {'kind': 'open-source', 'value': result['where']})
        guarded = decisions.make_decision(item(resumeCondition=None), guard_sentence='Exact host guard.')
        self.assertEqual(guarded['options'][0]['action']['value'], 'Exact host guard.')
        self.assertFalse(guarded['sourceGap'])

    def test_host_presentation_and_location(self):
        result = decisions.make_decision(item(), project='Caller', where='native://work/1',
                                         labels={'recommended': 'Preferred'}, question_template='{title}: {ask}')
        self.assertEqual(result['project'], 'Caller')
        self.assertEqual(result['where'], 'native://work/1')
        self.assertEqual(result['options'][0]['marker'], 'Preferred')
        self.assertTrue(result['question'].startswith('Review candidate:'))

    def test_nonhuman_and_progress_questions_are_filtered(self):
        for status in ('open', 'active', 'done', 'cancelled', 'deleted'):
            with self.subTest(status=status):
                self.assertIsNone(card(status=status))
        for owner in ('agent', 'external', None):
            self.assertIsNone(card(waitingOn={'who': owner, 'ask': 'What next?'}))
        self.assertIsNone(card(waitingOn={'who': 'human', 'ask': ''}))
        self.assertIsNone(card(waitingOn=None))
        self.assertIsNotNone(card(status='blocked'))

    def test_input_contract_and_source_location_required(self):
        for key in ('ref', 'title', 'status', 'updatedAt'):
            with self.subTest(key=key), self.assertRaises(ValueError):
                decisions.make_decision(item(**{key: ''}))
        with self.assertRaises(ValueError):
            card(url=None)
        with self.assertRaises(ValueError):
            card(updatedAt='2026-03-27T12:00:00')

    def test_new_unchanged_and_semantic_change(self):
        source = card()
        emitted, state = decisions.select_due([source], {}, '2026-03-27T12:00:00Z', 'Europe/Amsterdam')
        self.assertEqual(emitted, [source])
        self.assertEqual(state['WORK-1']['nextDue'], '2026-03-28T08:00:00Z')
        self.assertEqual(state['WORK-1']['reminderCount'], 0)
        before = copy.deepcopy(state)
        emitted, same = decisions.select_due([card(updatedAt='2026-03-28T00:00:00Z')], state,
                                              '2026-03-27T13:00:00Z', 'Europe/Amsterdam')
        self.assertEqual(emitted, [])
        self.assertEqual(same, before)
        changed = card(resumeCondition='Proceed with candidate B.')
        emitted, new = decisions.select_due([changed], state, '2026-03-27T13:00:00Z', 'Europe/Amsterdam')
        self.assertEqual(emitted, [changed])
        self.assertNotEqual(new['WORK-1']['hash'], state['WORK-1']['hash'])
        self.assertEqual(state, before)

    def test_duplicate_same_source_timestamps_emit_once(self):
        first, second = card(), card(updatedAt='2026-03-28T00:00:00Z')
        emitted, state = decisions.select_due([first, second], {}, '2026-03-27T12:00:00Z', 'UTC')
        self.assertEqual(len(emitted), 1)
        self.assertEqual(len(state), 1)
        with self.assertRaises(ValueError):
            decisions.select_due([first, card(resumeCondition='Different.')], {}, '2026-03-27T12:00:00Z', 'UTC')

    def test_spring_dst_next_morning_then_two_calendar_days(self):
        source = card()
        _, state = decisions.select_due([source], {}, '2026-03-28T22:00:00Z', 'Europe/Amsterdam')
        self.assertEqual(state['WORK-1']['nextDue'], '2026-03-29T07:00:00Z')
        self.assertEqual(decisions.due_ids(state, '2026-03-29T06:59:59Z'), [])
        self.assertEqual(decisions.due_ids(state, '2026-03-29T07:00:00Z'), ['WORK-1'])
        emitted, state = decisions.select_due([source], state, '2026-03-29T07:00:00Z', 'Europe/Amsterdam')
        self.assertEqual(emitted, [source])
        self.assertEqual(state['WORK-1']['nextDue'], '2026-03-31T07:00:00Z')
        self.assertEqual(state['WORK-1']['reminderCount'], 1)

    def test_two_calendar_days_cross_fall_dst(self):
        source = card()
        _, state = decisions.select_due([source], {}, '2026-10-22T20:00:00Z', 'Europe/Amsterdam')
        _, state = decisions.select_due([source], state, '2026-10-23T07:00:00Z', 'Europe/Amsterdam')
        self.assertEqual(state['WORK-1']['nextDue'], '2026-10-25T08:00:00Z')

    def test_closure_is_explicit_and_delta_absence_preserves_state(self):
        _, state = decisions.select_due([card()], {}, '2026-03-27T12:00:00Z', 'UTC')
        emitted, retained = decisions.select_due([], state, '2026-03-30T12:00:00Z', 'UTC')
        self.assertEqual(emitted, [])
        self.assertEqual(retained, state)
        emitted, closed = decisions.select_due([card()], state, '2026-03-30T12:00:00Z', 'UTC', closed_refs=['WORK-1'])
        self.assertEqual((emitted, closed), ([], {}))
        self.assertEqual(decisions.forget_closed(state, ['WORK-1']), {})
        self.assertTrue(state)

    def test_metadata_contains_no_source_or_card_content(self):
        _, state = decisions.select_due([card()], {}, '2026-03-27T12:00:00Z', 'UTC')
        self.assertEqual(set(state['WORK-1']), {'hash', 'lastEmission', 'nextDue', 'reminderCount'})

    def test_custom_hour_interval_and_delayed_emission(self):
        source = card()
        _, state = decisions.select_due([source], {}, '2026-03-27T12:00:00Z', 'UTC', next_morning_hour=6)
        self.assertEqual(state['WORK-1']['nextDue'], '2026-03-28T06:00:00Z')
        _, state = decisions.select_due([source], state, '2026-04-01T17:00:00Z', 'UTC', next_morning_hour=6, interval_days=3)
        self.assertEqual(state['WORK-1']['nextDue'], '2026-04-04T06:00:00Z')
        for settings in ({'interval_days': 0}, {'next_morning_hour': 24}):
            with self.assertRaises(ValueError):
                decisions.select_due([], {}, '2026-03-27T12:00:00Z', 'UTC', **settings)


if __name__ == '__main__':
    unittest.main()
