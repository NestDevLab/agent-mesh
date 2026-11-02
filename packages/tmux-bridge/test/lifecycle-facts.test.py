#!/usr/bin/env python3
"""Native lifecycle facts and cursor replacement regression fixtures."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

BIN = Path(__file__).resolve().parents[1] / 'bin'

def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), BIN / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

watch = load('agent-watch')
follow = load('agent-follow')
ID = '11111111-1111-4111-8111-111111111111'

def row(kind, **kwargs):
    return {'type': 'event_msg', 'timestamp': '2026-09-01T10:00:00Z', 'payload': {'type': kind, **kwargs}}

def encoded(*rows):
    return ''.join(json.dumps(item) + '\n' for item in rows)

class LifecycleFacts(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / f'{ID}.jsonl'

    def test_task_final_and_error_survive_incremental_discovery(self):
        self.path.write_text(encoded(row('task_started', turn_id='t1'), row('agent_message', phase='commentary', message='working')))
        first = watch.read_appended_facts('codex', ID, self.path, None)
        self.assertTrue(first['turn_active'])
        self.assertIsNone(first['last_outcome'])
        with self.path.open('a') as handle:
            handle.write(encoded(row('task_complete', turn_id='t1', last_agent_message='done')))
        final = watch.read_appended_facts('codex', ID, self.path, first)
        self.assertEqual((final['last_completion'], final['last_outcome'], final['last_assistant']), ('task', 'replied', 'done'))
        self.assertFalse(final['turn_active'])
        with self.path.open('a') as handle:
            handle.write(encoded(row('task_started', turn_id='t2'), row('error', message='capacity exhausted', codex_error_info='capacity')))
        failed = watch.read_appended_facts('codex', ID, self.path, final)
        self.assertEqual(failed['last_outcome'], 'error')
        self.assertEqual(failed['last_error']['code'], 'capacity')
        self.assertFalse(failed['turn_active'])
        with self.path.open('a') as handle:
            handle.write(encoded(row('task_started', turn_id='t3')))
        self.assertIsNone(watch.read_appended_facts('codex', ID, self.path, failed)['last_error'])

    def test_same_path_replacement_and_prefix_rewrite_reset_facts(self):
        self.path.write_text(encoded(row('user_message', message='old')))
        first = watch.read_appended_facts('codex', ID, self.path, None)
        replacement = self.path.with_suffix('.new')
        replacement.write_text(encoded(row('user_message', message='new longer prompt')))
        replacement.replace(self.path)
        second = watch.read_appended_facts('codex', ID, self.path, first)
        self.assertEqual(second['first_real_prompt'], 'new longer prompt')
        self.assertEqual(second['human_turns'], 1)
        # Same inode and a larger file must not reuse a cursor after a prefix rewrite.
        self.path.write_text(encoded(row('user_message', message='different prompt'), row('task_complete', last_agent_message='completed')))
        third = watch.read_appended_facts('codex', ID, self.path, second)
        self.assertEqual(third['first_real_prompt'], 'different prompt')
        self.assertEqual(third['human_turns'], 1)

    def test_partial_append_unchanged_and_truncated_reads(self):
        self.path.write_text(encoded(row('user_message', message='first')))
        first = watch.read_appended_facts('codex', ID, self.path, None)
        again = watch.read_appended_facts('codex', ID, self.path, first)
        self.assertEqual(first, again)
        part = json.dumps(row('task_complete', last_agent_message='done'))
        with self.path.open('a') as handle:
            handle.write(part)
        partial = watch.read_appended_facts('codex', ID, self.path, first)
        self.assertEqual(partial['offset'], first['offset'])
        with self.path.open('a') as handle:
            handle.write('\n')
        complete = watch.read_appended_facts('codex', ID, self.path, partial)
        self.assertEqual(complete['last_assistant'], 'done')
        self.path.write_text('{}\n')
        self.assertEqual(watch.read_appended_facts('codex', ID, self.path, complete)['human_turns'], 0)

    def test_watch_and_follow_share_replacement_guard_and_event_ids(self):
        self.path.write_text(encoded(row('user_message', message='old')))
        events, cursor = follow.read_records('codex', 'codex:' + ID, self.path, {})
        expected = events[0]['source_event_id']
        self.assertEqual(follow.read_records('codex', 'codex:' + ID, self.path, cursor)[0], [])
        state = {'path': str(self.path), 'offset': 0}
        with contextlib.redirect_stdout(io.StringIO()):
            watch.consume(agent='codex', session_id=ID, state=state, output_format='jsonl', inbox=None)
        self.path.write_text(encoded(row('user_message', message='replacement with more bytes')))
        events, _ = follow.read_records('codex', 'codex:' + ID, self.path, cursor)
        self.assertEqual(events[0]['body'], 'replacement with more bytes')
        self.assertNotEqual(events[0]['source_event_id'], expected)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            watch.consume(agent='codex', session_id=ID, state=state, output_format='jsonl', inbox=None)
        self.assertEqual(json.loads(output.getvalue())['source_event_id'], events[0]['source_event_id'])

    def test_archived_metadata_only_session_is_observed(self):
        with patch.object(watch, 'codex_metadata', return_value={ID: {'archived': True, 'name': 'archived', 'metadata_updated_at_ns': 0}}), patch.object(watch, 'transcript_candidates', return_value=[]), patch.object(watch, 'bridge_parents', return_value={}):
            facts, _ = watch.discover_transcripts('codex')
        self.assertEqual(len(facts), 1)
        self.assertTrue(facts[0]['archived'])
        self.assertTrue(facts[0]['metadata_only'])

if __name__ == '__main__':
    unittest.main()
