#!/usr/bin/env python3
"""Synthetic native helper stubs; no runtime or transcript parser is exercised."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

BIN = Path(__file__).resolve().parents[1] / 'bin'
spec = importlib.util.spec_from_file_location('agent_lifecycle', BIN / 'agent-lifecycle.py')
engine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(engine)


class LifecycleEngine(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.cwd = self.root / 'workspace'
        self.cwd.mkdir()
        self.history = self.root / 'native.jsonl'
        self.history.write_text('not a transcript; must never be parsed')
        self.run_dir = self.root / 'runs' / 'first'
        self.run_dir.mkdir(parents=True)
        self.environment = patch.dict(os.environ, {'XDG_STATE_HOME': str(self.root / 'state')})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.config = {'consumer': 'fixture', 'projectRoots': [{'root': str(self.cwd), 'project': 'Example'}],
                       'allowedProjects': ['Example'], 'archiveProjects': ['Example'], 'maxResumes': 3,
                       'idleSeconds': 0, 'resumeWindowCommand': ['window'], 'nativeGuardCommand': ['guard'],
                       'writerCommand': ['writers'], 'nativeCallCommand': ['native'], 'sessionCommand': ['session'],
                       'sendCommand': ['send']}
        self.calls = []
        self.guard_code = 0
        self.writers = []
        self.fail_delivery = False
        self.window = {'allow': True, 'reason': 'safe window'}
        self.preflight = 3
        self.target = None

    def row(self, number=1, **changes):
        native = f'11111111-1111-4111-8111-{number:012d}'
        result = {'sessionId': 'codex:' + native, 'nativeId': native, 'harness': 'codex', 'cwd': str(self.cwd),
                  'title': 'Original work', 'status': 'quiet', 'attention': 'stalled-work',
                  'lastSeenAt': '2020-01-01T00:00:00Z', 'class': 'worker', 'origin': 'human',
                  'archived': False, 'resumable': True, 'resumabilityReasons': [], 'links': [],
                  'lifecycle': {'path': str(self.history), 'historyComplete': True, 'turnActive': True,
                                'turnId': 'turn-1', 'pendingQuestion': False, 'lastEventKind': 'task_started'}}
        result.update(changes)
        return result

    def inventory(self, rows=None, **changes):
        return {'schema': 'agent-mesh.lifecycle-inventory.v1', 'at': engine.now(), 'sessions': rows or [self.row()],
                'linkCoverage': True, 'complete': True, 'errors': [], **changes}

    def query(self, config, name, payload):
        self.calls.append(('query', name, payload))
        if name == 'resume':
            ref = payload['session']
            return {'sessionId': ref, 'nativeId': ref.split(':')[1], 'harness': ref.split(':')[0],
                    'resumable': True, 'reasons': [], 'writer': {'state': 'free'}, 'successor': None}
        if name == 'subgraph':
            return {'edges': []}
        raise AssertionError(name)

    def runner(self, argv, payload=None, *, raw=False):
        self.calls.append((argv, payload))
        if argv[0] == 'window':
            return 0, self.window
        if argv[0] == 'guard':
            return self.guard_code, None
        if argv[0] == 'writers':
            return 0, {'agent': 'codex', 'sessionId': argv[argv.index('--session') + 1], 'writers': self.writers}
        if argv[0] == 'native':
            if self.fail_delivery:
                return 1, None
            return 0, {'status': 'queued', 'sessionId': argv[argv.index('--session') + 1],
                       'correlationId': argv[argv.index('--correlation-id') + 1]}
        if argv[0] == 'session':
            if 'new' in argv:
                self.target = argv[-1]
                return 0, self.target
            if '--owned-cwd' in argv:
                return 0, '22222222-2222-4222-8222-222222222222'
            return self.preflight, ''
        if argv[0] == 'send':
            return 4, 'progress is deliberately ignored'
        raise AssertionError(argv)

    def apply(self, inventory=None, config=None, run_dir=None, plan=None):
        inventory = inventory or self.inventory()
        config = config or self.config
        plan = plan or engine.build_plan(inventory, config)
        with patch.object(engine, 'collect', return_value=inventory), patch.object(engine, 'query', side_effect=self.query), patch.object(engine, 'run', side_effect=self.runner):
            return engine.apply_plan(plan, inventory, config, run_dir or self.run_dir)

    def test_complete_inventory_keeps_every_exclusion_visible(self):
        rows = [self.row(1), self.row(2, archived=True), self.row(3, origin='subagent'),
                self.row(4, title='Project director'), self.row(5, cwd=str(self.root)), self.row(6, title='Excluded topic')]
        config = {**self.config, 'excludePatterns': ['Excluded']}
        plan = engine.build_plan(self.inventory(rows), config)
        self.assertEqual(sum(plan['counts'].values()), 6)
        self.assertEqual(sum(plan['projectCounts'].values()), 6)
        self.assertEqual(len(plan['entries']), 6)
        self.assertEqual(len(plan['actions']), 1)
        self.assertEqual(len(plan['approvals']), 3)

    def test_no_ledger_match_required_and_maximum_three(self):
        plan = engine.build_plan(self.inventory([self.row(i) for i in range(1, 6)]), self.config)
        self.assertEqual(len(plan['actions']), 3)
        self.assertTrue(all(not row['links'] for row in self.inventory()['sessions']))
        with self.assertRaises(engine.LifecycleError):
            engine.validate_config({**self.config, 'maxResumes': 4})

    def test_unknown_or_refused_reset_window_blocks_without_attempt(self):
        self.window = {'allow': False, 'reason': 'unknown'}
        result = self.apply()
        self.assertEqual(result[0]['status'], 'blocked')
        self.assertFalse(any(isinstance(call[0], list) and call[0][0] == 'native' for call in self.calls))
        self.assertNotIn('"phase": "attempt"', (self.run_dir / 'actions.jsonl').read_text())
        self.assertEqual(self.apply(config={**self.config, 'resumeWindowCommand': None})[0]['status'], 'blocked')

    def test_guarded_queue_is_acknowledged_never_claimed_executed(self):
        result = self.apply()
        self.assertEqual(result[0]['status'], 'queued')
        self.assertNotIn('executed', result[0])
        records = [json.loads(line) for line in (self.run_dir / 'actions.jsonl').read_text().splitlines()]
        self.assertEqual([row['phase'] for row in records], ['attempt', 'acknowledgement'])
        native_call = next(call[0] for call in self.calls if isinstance(call[0], list) and call[0][0] == 'native')
        self.assertIn('--delivery-only', native_call)

    def test_only_exclusive_app_server_guard_exception_is_allowed(self):
        self.guard_code = 4
        self.writers = [{'role': 'app-server', 'kind': 'codex'}]
        self.assertEqual(self.apply()[0]['status'], 'queued')
        other = self.root / 'runs' / 'second'
        other.mkdir()
        self.writers = [{'role': 'cli', 'kind': 'codex'}]
        changed = self.inventory([self.row(2)])
        self.assertEqual(self.apply(changed, run_dir=other)[0]['status'], 'blocked')
        self.guard_code = 3
        self.writers = []
        self.assertEqual(self.apply(self.inventory([self.row(3)]), run_dir=other)[0]['status'], 'blocked')

    def test_desktop_free_writer_can_queue_without_bypass(self):
        self.guard_code = 6
        self.assertEqual(self.apply()[0]['status'], 'queued')
        guards = [call[0] for call in self.calls if isinstance(call[0], list) and call[0][0] == 'guard']
        self.assertNotIn('--allow-desktop-thread', guards[0])

    def test_attempt_precedes_failure_and_deduplicates_across_runs(self):
        self.fail_delivery = True
        inventory = self.inventory()
        first = self.apply(inventory)
        self.assertEqual(first[0]['status'], 'blocked')
        other = self.root / 'runs' / 'second'
        other.mkdir()
        self.calls = []
        result = self.apply(inventory, run_dir=other)
        self.assertEqual(result[0]['status'], 'not-retried')
        self.assertFalse(any(isinstance(call[0], list) and call[0][0] == 'native' for call in self.calls))

    def test_stops_after_first_action_failure(self):
        self.fail_delivery = True
        result = self.apply(self.inventory([self.row(1), self.row(2)]))
        self.assertEqual(len(result), 1)
        self.assertEqual(len([call for call in self.calls if isinstance(call[0], list) and call[0][0] == 'native']), 1)

    def test_pending_human_permanent_and_archive_are_protected(self):
        human = self.row(1)
        human['lifecycle']['pendingQuestion'] = True
        complete = self.row(3, attention=None)
        complete['lifecycle'].update(turnActive=False, completion='task', historyComplete=False)
        inventory = self.inventory([human, self.row(2, title='Coordinator'), complete])
        plan = engine.build_plan(inventory, self.config)
        self.assertEqual(plan['actions'], [])
        self.assertEqual([row['classification'] for row in plan['entries']], ['approval-human', 'approval-compaction', 'archive-candidate'])
        self.assertTrue(plan['entries'][-1]['sourceGaps'])
        continuation = {**self.config, 'continuationPatterns': ['Original'], 'humanWaitPatterns': ['Original']}
        self.assertEqual(engine.build_plan(self.inventory([complete]), continuation)['actions'], [])

    def test_completed_idle_requires_explicit_continuation_pattern(self):
        complete = self.row(attention=None)
        complete['lifecycle'].update(turnActive=False, completion='task')
        self.assertEqual(engine.build_plan(self.inventory([complete]), self.config)['actions'], [])
        config = {**self.config, 'continuationPatterns': ['Original work']}
        self.assertEqual(len(engine.build_plan(self.inventory([complete]), config)['actions']), 1)

    def test_unsupported_handoff_report_and_supported_owned_child(self):
        source = self.row(harness='claude')
        source['sessionId'] = 'claude:' + source['nativeId']
        inventory = self.inventory([source])
        plan = engine.build_plan(inventory, self.config)
        self.assertEqual(plan['actions'], [])
        self.assertEqual(plan['entries'][0]['classification'], 'handoff-candidate')
        config = {**self.config, 'handoffProfile': 'developer', 'limenConfig': str(self.root / 'policy.json')}
        result = self.apply(inventory, config=config)
        self.assertEqual(result[0]['status'], 'submitted')
        self.assertEqual(result[0]['originalSession'], source['sessionId'])
        self.assertTrue(result[0]['childSession'].startswith('codex:'))
        self.assertTrue(self.target.startswith('lifecycle-'))
        calls = [call[0] for call in self.calls if isinstance(call[0], list)]
        self.assertTrue(any('--owned-cwd' in call for call in calls))
        self.assertFalse(any('kill' in call or 'resume' in call for call in calls))

    def test_existing_or_unresolved_handoff_target_never_launches(self):
        source = self.row(harness='claude')
        source['sessionId'] = 'claude:' + source['nativeId']
        self.preflight = 4
        config = {**self.config, 'handoffProfile': 'developer', 'limenConfig': 'fixture-policy.json'}
        result = self.apply(self.inventory([source]), config=config)
        self.assertEqual(result[0]['status'], 'blocked')
        self.assertFalse(any(isinstance(call[0], list) and 'new' in call[0] for call in self.calls))

    def test_source_errors_and_digest_tampering_fail_closed(self):
        inventory = self.inventory(complete=False, errors=['source unavailable'])
        self.assertEqual(engine.build_plan(inventory, self.config)['actions'], [])
        with self.assertRaises(engine.LifecycleError):
            self.apply(inventory)
        inventory = self.inventory()
        plan = engine.build_plan(inventory, self.config)
        plan['actions'][0]['fingerprint'] = 'tampered'
        with self.assertRaises(engine.LifecycleError):
            self.apply(inventory, plan=plan)

    def test_changed_fresh_observation_blocks_old_plan(self):
        inventory = self.inventory()
        plan = engine.build_plan(inventory, self.config)
        changed = copy.deepcopy(inventory)
        changed['sessions'][0]['lifecycle']['pendingQuestion'] = True
        with patch.object(engine, 'collect', return_value=changed):
            self.assertEqual(engine.apply_plan(plan, inventory, self.config, self.run_dir)[0]['status'], 'blocked')

    def test_paged_collection_covers_all_identities_and_flags_source_errors(self):
        pages = [{'sessions': [self.row(1)], 'linkCoverage': False, 'cursor': 'next'},
                 {'sessions': [self.row(2, archived=True)], 'linkCoverage': False, 'cursor': None}]
        with patch.object(engine, 'mesh', return_value={}), patch.object(engine, 'query', side_effect=pages):
            inventory = engine.collect(self.config)
        self.assertEqual(len(inventory['sessions']), 2)
        self.assertFalse(inventory['linkCoverage'])
        self.assertTrue(inventory['complete'])
        with patch.object(engine, 'mesh', side_effect=engine.LifecycleError('source failure')), patch.object(engine, 'query', return_value={'sessions': [], 'cursor': None}):
            self.assertFalse(engine.collect(self.config)['complete'])

    def test_run_artifacts_have_restrictive_modes(self):
        path = self.run_dir / 'plan.json'
        engine.write(path, {'synthetic': True})
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.run_dir.stat().st_mode & 0o777, 0o700)
        self.assertEqual((BIN / 'agent-lifecycle.py').read_bytes(), (BIN.parents[2] / 'skills/agent-tmux/bin/agent-lifecycle.py').read_bytes())


if __name__ == '__main__':
    unittest.main()
