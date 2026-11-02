#!/usr/bin/env python3
"""Synthetic native helper stubs; no runtime or transcript parser is exercised."""
import copy
import importlib.util
import json
import os
import sys
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
        self.proof_code = 0
        self.launch_code = 0
        self.send_code = 4
        self.native_capacity = False
        self.retry_permission = True

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

    def runner(self, argv, payload=None, *, raw=False, timeout_ms=120000):
        self.calls.append((argv, payload))
        if argv[0] == 'work-item':
            self.assertEqual(timeout_ms, 10000)
            self.assertEqual(payload, {'session': self.row()['sessionId']})
            return 0, json.dumps(self.work_item)
        if argv[0] == 'retry-policy':
            return 0, {'allow': self.retry_permission}
        if argv[0] == 'window':
            return 0, self.window
        if argv[0] == 'guard':
            return self.guard_code, None
        if argv[0] == 'writers':
            return 0, {'agent': 'codex', 'sessionId': argv[argv.index('--session') + 1], 'writers': self.writers}
        if argv[0] == 'native':
            if self.native_capacity:
                return 75, {'status': 'waiting_capacity', 'accepted': False, 'sessionId': argv[argv.index('--session') + 1],
                            'correlationId': argv[argv.index('--correlation-id') + 1]}
            if self.fail_delivery:
                return 1, None
            return 0, {'status': 'queued', 'sessionId': argv[argv.index('--session') + 1],
                       'correlationId': argv[argv.index('--correlation-id') + 1]}
        if argv[0] == 'session':
            if 'new' in argv:
                self.target = argv[-1]
                return self.launch_code, self.target
            if '--owned-cwd' in argv:
                return self.proof_code, '22222222-2222-4222-8222-222222222222'
            return self.preflight, ''
        if argv[0] == 'send':
            return self.send_code, 'progress is deliberately ignored'
        raise AssertionError(argv)

    def apply(self, inventory=None, config=None, run_dir=None, plan=None):
        inventory = inventory or self.inventory()
        config = config or self.config
        plan = plan or engine.build_plan(inventory, config)
        with patch.object(engine, 'collect', return_value=inventory), patch.object(engine, 'query', side_effect=self.query), patch.object(engine, 'run', side_effect=self.runner):
            return engine.apply_plan(plan, inventory, config, run_dir or self.run_dir)

    def item_command(self, script):
        return {**self.config, 'workItemCommand': [sys.executable, '-c', script]}

    def test_unset_work_item_command_keeps_original_prompt(self):
        self.apply()
        native = next(call[0] for call in self.calls if isinstance(call[0], list) and call[0][0] == 'native')
        self.assertEqual(native[native.index('--message') + 1], engine.PROMPT)

    def test_owned_work_item_is_in_plan_report_and_delivered_prompt(self):
        self.work_item = {'item': 'TASK-42', 'title': 'Complete fixture', 'nextStep': 'Run the fixture check'}
        config = {**self.config, 'workItemCommand': ['work-item']}
        inventory = self.inventory()
        with patch.object(engine, 'run', side_effect=self.runner):
            plan = engine.build_plan(inventory, config)
        self.assertEqual(plan['actions'][0]['workItem'], self.work_item)
        report = engine.report(inventory, plan)
        self.assertIn('TASK-42', report)
        self.assertIn('Run the fixture check', report)
        self.assertEqual(self.apply(inventory, config=config, plan=plan)[0]['status'], 'queued')
        native = next(call[0] for call in self.calls if isinstance(call[0], list) and call[0][0] == 'native')
        prompt = native[native.index('--message') + 1]
        self.assertIn('TASK-42: Complete fixture', prompt)
        self.assertIn('Next step: Run the fixture check', prompt)
        self.assertTrue(prompt.endswith(engine.SAFETY))
        self.assertNotIn('Continue only the original requested work', prompt)

    def test_work_item_command_receives_session_json_on_stdin(self):
        config = self.item_command('import json,sys; ref=json.load(sys.stdin)["session"]; '
                                   'print(json.dumps({"item":"TASK-42","title":"Fixture","nextStep":ref}))')
        plan = engine.build_plan(self.inventory(), config)
        self.assertEqual(plan['actions'][0]['workItem']['nextStep'], self.row()['sessionId'])

    def test_empty_error_invalid_or_missing_command_never_resumes(self):
        cases = [('pass', 'no item'), ('print("null")', 'no item'), ('print("{}")', 'no item'),
                 ('print("[]")', 'no item'), ('raise SystemExit(2)', 'exited with error'),
                 ('print("not json")', 'invalid JSON'), ('print("[] trailing")', 'invalid JSON'),
                 ('print(42)', 'invalid item fields'),
                 ('print(' + repr(json.dumps({'item': 'TASK-42', 'title': 7, 'nextStep': 'Check'})) + ')', 'invalid item fields'),
                 ('print(' + repr(json.dumps({'item': 'TASK-42', 'title': ' ', 'nextStep': 'Check'})) + ')', 'empty item fields')]
        for script, reason in cases:
            with self.subTest(script=script):
                inventory = self.inventory()
                plan = engine.build_plan(inventory, self.item_command(script))
                self.assertEqual(plan['actions'], [])
                self.assertEqual(plan['entries'][0]['classification'], 'keep-no-work-item')
                self.assertIn(reason, plan['entries'][0]['reason'])
                self.assertIn(reason, engine.report(inventory, plan))
        config = {**self.config, 'workItemCommand': ['missing-synthetic-helper']}
        self.assertEqual(engine.build_plan(self.inventory(), config)['counts'], {'keep-no-work-item': 1})

    def test_work_item_timeout_never_resumes(self):
        config = self.item_command('import time; time.sleep(30)')
        plan = engine.build_plan(self.inventory(), config)
        self.assertEqual(plan['actions'], [])
        self.assertEqual(plan['entries'][0]['classification'], 'keep-no-work-item')
        self.assertIn('timed out', plan['entries'][0]['reason'])

    def test_work_item_sanitization_and_limits(self):
        item = {'item': 'TASK-42\n\x00', 'title': 'Title\r\n\x1b\u2028\u202e' + 'x' * 200,
                'nextStep': 'Check\t\x7f\x85\u2029' + 'y' * 300}
        config = self.item_command('import json; print(' + repr(json.dumps(item)) + ')')
        action = engine.build_plan(self.inventory(), config)['actions'][0]
        clean = action['workItem']
        self.assertEqual(clean['item'], 'TASK-42')
        self.assertEqual(len(clean['title']), 120)
        self.assertEqual(len(clean['nextStep']), 200)
        self.assertFalse(any(engine.unicodedata.category(char).startswith('C') or char in '\n\r\u2028\u2029'
                             for char in engine.resume_prompt(action)))

    def test_changed_or_closed_item_blocks_saved_plan_before_queue(self):
        config = {**self.config, 'workItemCommand': ['work-item']}
        self.work_item = {'item': 'TASK-42', 'title': 'Fixture', 'nextStep': 'Check'}
        inventory = self.inventory()
        with patch.object(engine, 'run', side_effect=self.runner):
            plan = engine.build_plan(inventory, config)
        for item in (None, {**self.work_item, 'nextStep': 'Changed'}):
            with self.subTest(item=item):
                self.work_item = item
                self.calls = []
                self.assertEqual(self.apply(inventory, config=config, plan=plan)[0]['status'], 'blocked')
                self.assertFalse(any(isinstance(call[0], list) and call[0][0] == 'native' for call in self.calls))

    def test_work_item_config_requires_nonempty_argv(self):
        for command in (None, [], 'helper', [42], ['']):
            with self.subTest(command=command), self.assertRaises(engine.LifecycleError):
                engine.validate_config({**self.config, 'workItemCommand': command})

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

    def test_automation_worker_is_kept_as_noise(self):
        row = self.row(origin='automation', **{'class': 'worker'})
        plan = engine.build_plan(self.inventory([row]), self.config)
        self.assertEqual(plan['entries'][0]['classification'], 'keep-noise')
        self.assertEqual(plan['actions'], [])

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
        self.assertIn('--resume', native_call)
        self.assertTrue(result[0]['resumeRequested'])
        self.assertFalse(result[0]['resumeVerified'])

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

    def handoff_fixture(self):
        row = self.row(harness='claude')
        row['sessionId'] = 'claude:' + row['nativeId']
        return self.inventory([row]), {**self.config, 'handoffProfile': 'developer', 'limenConfig': 'fixture-policy.json'}

    def test_known_handoff_proof_failure_backs_off_then_reuses_same_child(self):
        inventory, config = self.handoff_fixture()
        self.proof_code = 4
        with patch.object(engine, 'now', return_value='2026-11-02T12:00:00Z'):
            first = self.apply(inventory, config=config)
        self.assertEqual(first[0]['retryClass'], 'handoff-proof')
        self.assertEqual(first[0]['nextRetryAt'], '2026-11-02T12:05:00Z')
        target = self.target
        self.calls = []
        with patch.object(engine, 'now', return_value='2026-11-02T12:04:59Z'):
            self.assertEqual(self.apply(inventory, config=config)[0]['status'], 'not-retried')
        self.proof_code = 0
        with patch.object(engine, 'now', return_value='2026-11-02T12:05:00Z'):
            result = self.apply(inventory, config=config)
        self.assertEqual(result[0]['status'], 'submitted')
        self.assertEqual(result[0]['target'], target)
        self.assertFalse(any(isinstance(call[0], list) and 'new' in call[0] for call in self.calls))

    def test_capacity_dispatcher_keeps_ownership_of_pending_target_without_child_flood(self):
        inventory, config = self.handoff_fixture()
        self.launch_code = 75
        with patch.object(engine, 'now', return_value='2026-11-02T12:00:00Z'):
            first = self.apply(inventory, config=config)
        self.assertEqual(first[0]['retryClass'], 'capacity')
        self.calls = []
        self.proof_code = 3
        with patch.object(engine, 'now', return_value='2026-11-02T12:05:00Z'):
            second = self.apply(inventory, config=config)
        self.assertEqual(second[0]['retryAttempt'], 2)
        self.assertEqual(second[0]['nextRetryAt'], '2026-11-02T12:15:00Z')
        self.assertFalse(any(isinstance(call[0], list) and 'new' in call[0] for call in self.calls))
        self.proof_code = 0
        with patch.object(engine, 'now', return_value='2026-11-02T12:15:00Z'):
            self.assertEqual(self.apply(inventory, config=config)[0]['status'], 'submitted')

    def test_explicit_queue_capacity_rejection_is_retryable_but_ambiguous_failure_is_not(self):
        inventory = self.inventory()
        self.native_capacity = True
        with patch.object(engine, 'now', return_value='2026-11-02T12:00:00Z'):
            result = self.apply(inventory)
        self.assertTrue(result[0]['retryable'])
        self.native_capacity = False
        with patch.object(engine, 'now', return_value='2026-11-02T12:05:00Z'):
            self.assertEqual(self.apply(inventory)[0]['status'], 'queued')

    def test_private_permission_hold_and_hard_cap_never_launch_new_children(self):
        inventory, config = self.handoff_fixture()
        config.update(retryMaxAttempts=2, retryGuardCommand=['retry-policy'])
        self.proof_code = 4
        with patch.object(engine, 'now', return_value='2026-11-02T12:00:00Z'):
            self.apply(inventory, config=config)
        self.retry_permission = False
        self.calls = []
        with patch.object(engine, 'now', return_value='2026-11-02T12:05:00Z'):
            held = self.apply(inventory, config=config)
        self.assertTrue(held[0]['retryExhausted'])
        self.assertIn('private', held[0]['reason'])
        with patch.object(engine, 'now', return_value='2026-11-03T12:00:00Z'):
            self.assertEqual(self.apply(inventory, config=config)[0]['status'], 'not-retried')
        self.assertFalse(any(isinstance(call[0], list) and 'new' in call[0] for call in self.calls))

    def test_ambiguous_child_send_is_held_and_new_observation_cannot_create_another_child(self):
        inventory, config = self.handoff_fixture()
        self.send_code = 1
        first = self.apply(inventory, config=config)
        self.assertNotIn('retryable', first[0])
        self.calls = []
        self.assertEqual(self.apply(inventory, config=config)[0]['status'], 'not-retried')
        changed = copy.deepcopy(inventory)
        changed['sessions'][0]['lifecycle']['lastEventId'] = 'new-observation'
        history = engine.receipt_history(self.run_dir, config['consumer'])
        plan = engine.build_plan(changed, config, (), history)
        self.assertEqual(plan['entries'][0]['classification'], 'keep-child-held')
        self.assertEqual(plan['actions'], [])

    def test_model_capacity_fact_backoff_and_budget_do_not_reclassify_noise(self):
        row = self.row()
        row['lifecycle'].update(error={'message': 'Selected model is at capacity'}, outcome='error',
                                completedAt='2026-11-02T12:00:00Z')
        inventory = self.inventory([row], at='2026-11-02T12:01:00Z')
        waiting = engine.build_plan(inventory, self.config)
        self.assertEqual(waiting['entries'][0]['classification'], 'keep-retry-backoff')
        self.assertEqual(waiting['entries'][0]['retryability']['retryClass'], 'model-capacity')
        inventory['at'] = '2026-11-02T13:00:00Z'
        due = engine.build_plan(inventory, self.config)
        self.assertEqual(len(due['actions']), 1)
        scope = due['actions'][0]['modelCapacityScope']
        history = [{'phase': 'attempt', 'modelCapacityScope': scope} for _ in range(3)]
        held = engine.build_plan(inventory, self.config, (), history)
        self.assertEqual(held['entries'][0]['classification'], 'keep-retry-held')
        row['origin'] = 'subagent'
        noise = engine.build_plan(self.inventory([row]), self.config)
        self.assertEqual(noise['entries'][0]['classification'], 'keep-noise')
        self.assertNotIn('retryability', noise['entries'][0])

    def test_legacy_known_pre_delivery_proof_failure_is_recoverable_but_delivery_is_not(self):
        base = {'fingerprint': 'same', 'session': self.row()['sessionId'], 'consumer': 'fixture', 'at': '2026-11-02T12:00:00Z'}
        records = [{**base, 'phase': 'attempt', 'target': 'lifecycle-existing'},
                   {**base, 'phase': 'child-created', 'target': 'lifecycle-existing'},
                   {**base, 'phase': 'failure', 'reason': 'new child ownership or native identity unavailable'}]
        state = engine.retry_states(records)['same']
        self.assertTrue(engine.retry_ready(state, self.config, '2026-11-02T12:05:00Z'))
        records.insert(2, {**base, 'phase': 'delivery-attempt'})
        self.assertFalse(engine.retry_ready(engine.retry_states(records)['same'], self.config, '2026-11-02T12:05:00Z'))

    def test_new_model_capacity_scope_cannot_bypass_private_retry_guard(self):
        row = self.row()
        row['lifecycle'].update(error={'message': 'Selected model is at capacity'}, outcome='error',
                                completedAt='2026-11-02T12:00:00Z')
        inventory = self.inventory([row], at='2026-11-02T13:00:00Z')
        config = {**self.config, 'retryGuardCommand': ['retry-policy']}
        self.retry_permission = False
        with patch.object(engine, 'now', return_value='2026-11-02T13:00:00Z'):
            result = self.apply(inventory, config=config)
        self.assertEqual(result[0]['retryClass'], 'model-capacity')
        self.assertIn('private', result[0]['reason'])
        guards = [call[1] for call in self.calls if isinstance(call[0], list) and call[0][0] == 'retry-policy']
        self.assertEqual(guards, [{'session': row['sessionId'], 'target': None, 'retryClass': 'model-capacity'}])
        self.assertFalse(any(isinstance(call[0], list) and call[0][0] in ('native', 'session', 'send') for call in self.calls))
        with patch.object(engine, 'now', return_value='2026-11-02T13:00:01Z'):
            self.assertEqual(self.apply(inventory, config=config)[0]['status'], 'not-retried')

    def test_long_launch_failure_backoff_starts_when_failure_is_observed(self):
        inventory, config = self.handoff_fixture()
        clock = {'at': '2026-11-02T12:00:00Z'}
        self.launch_code = 75
        runner = self.runner
        def delayed(argv, payload=None, **kwargs):
            result = runner(argv, payload, **kwargs)
            if argv[0] == 'session' and 'new' in argv:
                clock['at'] = '2026-11-02T12:20:00Z'
            return result
        with patch.object(engine, 'now', side_effect=lambda: clock['at']), patch.object(engine, 'collect', return_value=inventory), \
             patch.object(engine, 'query', side_effect=self.query), patch.object(engine, 'run', side_effect=delayed):
            plan = engine.build_plan(inventory, config)
            result = engine.apply_plan(plan, inventory, config, self.run_dir)
        failure = result[0]
        self.assertEqual(failure['actionStartedAt'], '2026-11-02T12:00:00Z')
        self.assertEqual(failure['failureObservedAt'], '2026-11-02T12:20:00Z')
        self.assertEqual(failure['at'], failure['failureObservedAt'])
        self.assertEqual(failure['nextRetryAt'], '2026-11-02T12:25:00Z')
        self.assertIn(plan['actions'][0]['fingerprint'], engine.attempted(self.run_dir, config['consumer'], config, '2026-11-02T12:20:01Z'))

    def test_run_artifacts_have_restrictive_modes(self):
        path = self.run_dir / 'plan.json'
        engine.write(path, {'synthetic': True})
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.run_dir.stat().st_mode & 0o777, 0o700)
        self.assertEqual((BIN / 'agent-lifecycle.py').read_bytes(), (BIN.parents[2] / 'skills/agent-tmux/bin/agent-lifecycle.py').read_bytes())


    def test_prior_attempts_are_filtered_before_the_batch_limit(self):
        inventory = self.inventory([self.row(i) for i in range(1, 7)])
        first = engine.build_plan(inventory, self.config)
        second = engine.build_plan(inventory, self.config, [entry['fingerprint'] for entry in first['actions']])
        self.assertEqual([entry['session'] for entry in second['actions']], [row['sessionId'] for row in inventory['sessions'][3:]])
        self.assertEqual(second['counts']['keep-attempted'], 3)
        changed = copy.deepcopy(inventory)
        changed['sessions'][0]['lifecycle']['lastEventId'] = 'new-native-event'
        self.assertNotEqual(engine.fingerprint(changed['sessions'][0]), first['actions'][0]['fingerprint'])

    def test_action_outbox_recovers_acknowledgement_without_repeating_native_queue(self):
        config = {**self.config, 'eventOutbox': str(self.root / 'follow')}
        inventory = self.inventory()
        plan = engine.build_plan(inventory, config)
        with patch.object(engine, 'publish_outcomes', side_effect=engine.LifecycleError('interrupted after receipt')):
            with self.assertRaises(engine.LifecycleError):
                self.apply(inventory, config=config, plan=plan)
        result = self.apply(inventory, config=config, plan=plan)
        self.assertEqual(result[0]['status'], 'not-retried')
        self.assertEqual(sum(isinstance(call[0], list) and call[0][0] == 'native' for call in self.calls), 1)
        outbox = self.root / 'follow/outbox.jsonl'
        rows = [json.loads(line) for line in outbox.read_text().splitlines()]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['kind'], 'LIFECYCLE')
        self.assertEqual(rows[0]['payload']['status'], 'queued')
        self.apply(inventory, config=config, plan=plan)
        self.assertEqual(len(outbox.read_text().splitlines()), 1)

    def test_each_dispatch_refreshes_native_context_after_previous_actions(self):
        inventory = self.inventory([self.row(1), self.row(2)])
        changed = copy.deepcopy(inventory)
        changed['sessions'][1]['lifecycle']['pendingQuestion'] = True
        plan = engine.build_plan(inventory, self.config)
        with patch.object(engine, 'collect', side_effect=[inventory, changed]) as refresh, patch.object(engine, 'query', side_effect=self.query), patch.object(engine, 'run', side_effect=self.runner):
            results = engine.apply_plan(plan, inventory, self.config, self.run_dir)
        self.assertEqual([row['status'] for row in results], ['queued', 'blocked'])
        self.assertEqual(refresh.call_count, 2)
        self.assertEqual(sum(isinstance(call[0], list) and call[0][0] == 'native' for call in self.calls), 1)

    def test_native_helper_output_is_bounded_during_read(self):
        with patch.object(engine, 'HELPER_OUTPUT_BYTES', 1024):
            with self.assertRaisesRegex(engine.LifecycleError, 'output exceeds size limit'):
                engine.run([sys.executable, '-c', 'import sys;sys.stdout.write("x" * 65536)'])
        code, value = engine.run([sys.executable, '-c', 'import sys;sys.stderr.write("diagnostic" * 65536);print("ok")'], raw=True)
        self.assertEqual((code, value), (0, 'ok'))

if __name__ == '__main__':
    unittest.main()
