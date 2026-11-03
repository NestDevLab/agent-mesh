#!/usr/bin/env python3
"""Synthetic protocol and receipt tests; never invokes native archive or AI."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

BIN = Path(__file__).resolve().parents[1] / 'bin'
spec = importlib.util.spec_from_file_location('archive_engine_fixture', BIN / 'agent-lifecycle.py')
engine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(engine)


class ArchiveProtocol(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.run_dir = self.root / 'runs' / 'first'
        self.run_dir.mkdir(parents=True)
        self.cwd = self.root / 'workspace'
        self.cwd.mkdir()
        self.history = self.root / 'history.jsonl'
        self.history.write_text('opaque native history; do not parse')
        self.environment = patch.dict(os.environ, {'XDG_STATE_HOME': str(self.root / 'state')})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.config = {'consumer': 'archive-fixture', 'selfRef': self.ref(999), 'idleSeconds': 0,
                       'maxResumes': 3, 'maxArchives': 10, 'projectRoots': [{'root': str(self.cwd), 'project': 'Example'}],
                       'allowedProjects': ['Example'], 'archiveProjects': ['Example'],
                       'archivePrepareCommand': ['prepare'], 'archiveReviewCommand': ['review'], 'archiveApplyCommand': ['apply']}
        self.calls = []
        self.prepare_skips = set()
        self.apply_skips = set()
        self.review_skips = set()
        self.technical_prepare = None
        self.ambiguous_apply = None
        self.bad_review = False
        self.verdict = 'PASS'
        self.attestation = True

    def ref(self, number):
        return f'codex:11111111-1111-4111-8111-{number:012d}'

    def row(self, number):
        ref = self.ref(number)
        return {'sessionId': ref, 'nativeId': ref.split(':')[1], 'harness': 'codex', 'cwd': str(self.cwd),
                'title': 'Completed fixture', 'status': 'quiet', 'attention': 'quiet', 'lastSeenAt': '2020-01-01T00:00:00Z',
                'class': 'worker', 'origin': 'human', 'archived': False, 'links': [],
                'lifecycle': {'path': str(self.history), 'historyComplete': True, 'turnActive': False,
                              'turnId': 'finished', 'completion': 'task', 'pendingQuestion': False}}

    def inventory(self, count=1):
        return {'schema': 'agent-mesh.lifecycle-inventory.v1', 'at': engine.now(), 'sessions': [self.row(n) for n in range(1, count + 1)],
                'linkCoverage': True, 'complete': True, 'errors': []}

    def artifact(self, name, value):
        path = self.root / name
        path.write_text(json.dumps(value))
        return {'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}

    def runner(self, argv, payload=None, *, timeout_ms=120000, **kwargs):
        self.calls.append((argv[0], payload, timeout_ms))
        if argv == ['prepare']:
            ref = payload['session']
            if ref == self.technical_prepare:
                return 0, {'status': 'technical_error', 'reasonCode': 'guard_error'}
            if ref in self.prepare_skips:
                return 0, {'status': 'skipped', 'reasonCode': 'writer_live'}
            return 0, {'status': 'eligible', 'session': ref, 'fingerprint': payload['fingerprint'],
                       **({'obligationsChecked': self.attestation} if self.attestation is not None else {}),
                       'summary': self.artifact(ref + '-summary', {'durable': 'fixture'}),
                       'evidence': self.artifact(ref + '-evidence', {'eligibility': 'fixture'})}
        if argv == ['review']:
            self.assertEqual(timeout_ms, self.config.get('archiveReviewTimeoutMs', 240000))
            plan = json.loads(Path(payload['planPath']).read_text())
            decisions = [{'actionDigest': action['actionDigest'], 'verdict': 'SKIP', 'reasonCode': 'proof_unproven'}
                         if action['session'] in self.review_skips else {'actionDigest': action['actionDigest'], 'verdict': 'PASS'}
                         for action in plan['actions'] if action['kind'] == 'archive']
            if self.bad_review:
                decisions = decisions[:-1]
            value = {'verdict': self.verdict, 'planDigest': payload['planDigest'], 'reviewerRef': self.ref(998), 'decisions': decisions}
            return 0, {**value, 'receipt': self.artifact('review-receipt', value)}
        if argv == ['apply']:
            records = [json.loads(line) for line in (self.run_dir / 'actions.jsonl').read_text().splitlines()]
            self.assertEqual(records[-1]['phase'], 'archive-attempt')
            ref = payload['session']
            if ref == self.ambiguous_apply:
                return 0, {'status': 'unknown'}
            if ref in self.apply_skips:
                return 0, {'status': 'skipped', 'reasonCode': 'descendant_live'}
            value = {key: payload[key] for key in ('session', 'planDigest', 'actionDigest')}
            value.update(status='archived', nativeArchived=True)
            return 0, {**value, 'receipt': self.artifact(ref + '-confirmation', value)}
        raise AssertionError(argv)

    def prepare(self, inventory):
        plan = engine.build_plan(inventory, self.config)
        with patch.object(engine, 'run', side_effect=self.runner):
            engine.archive_module().prepare(plan, inventory, self.config, self.run_dir, engine.archive_api(), engine.receipt_history(self.run_dir, self.config["consumer"]))
        engine.write(self.run_dir / 'inventory.json', inventory)
        engine.write(self.run_dir / 'plan.json', plan)
        engine.append(self.run_dir / 'actions.jsonl', {'consumer': self.config['consumer'], 'phase': 'planned', 'at': engine.now()})
        return plan

    def apply(self, plan, inventory, fresh=None):
        def query(config, name, payload):
            ref = payload['session']
            return {'sessionId': ref, 'nativeId': ref.split(':')[1], 'harness': ref.split(':')[0]}
        with patch.object(engine, 'run', side_effect=self.runner), patch.object(engine, 'collect', return_value=fresh or inventory), patch.object(engine, 'query', side_effect=query):
            return engine.apply_plan(plan, inventory, self.config, self.run_dir)

    def test_prepare_semantic_skip_continues_and_technical_stops(self):
        self.prepare_skips.add(self.ref(1))
        self.technical_prepare = self.ref(3)
        plan = self.prepare(self.inventory(4))
        self.assertEqual([a['session'] for a in plan['archive']['prepared']], [self.ref(2)])
        self.assertEqual(plan['archive']['status'], 'technical-error')
        self.assertEqual(len(self.calls), 3)
        with self.assertRaises(engine.LifecycleError):
            self.apply(plan, self.inventory(4))
        self.assertFalse(any(call[0] == 'review' for call in self.calls))

    def test_success_cap_counts_confirmed_only_after_both_skip_kinds(self):
        inventory = self.inventory(14)
        self.config['maxArchives'] = 10
        self.review_skips.add(self.ref(1))
        self.apply_skips.add(self.ref(2))
        plan = self.prepare(inventory)
        outcomes = self.apply(plan, inventory)
        self.assertEqual(sum(o['status'] == 'archived' for o in outcomes), 10)
        self.assertEqual(sum(o['status'] == 'skipped' for o in outcomes), 2)
        self.assertEqual(sum(o['status'] == 'success-limit' for o in outcomes), 2)
        self.assertEqual(len([c for c in self.calls if c[0] == 'apply']), 11)
        # Reapplying the same plan cannot reset its confirmed success count.
        self.apply(plan, inventory)
        self.assertEqual(len([c for c in self.calls if c[0] == 'apply']), 11)

    def test_overall_fail_is_all_skip_without_native_calls(self):
        inventory = self.inventory(2)
        self.review_skips.update([self.ref(1), self.ref(2)])
        self.verdict = 'FAIL'
        outcomes = self.apply(self.prepare(inventory), inventory)
        self.assertEqual([o['status'] for o in outcomes], ['skipped', 'skipped'])
        self.assertFalse(any(c[0] == 'apply' for c in self.calls))

    def test_missing_action_review_is_technical_stop(self):
        inventory = self.inventory(2)
        self.bad_review = True
        with self.assertRaises(engine.LifecycleError):
            self.apply(self.prepare(inventory), inventory)
        self.assertFalse(any(c[0] == 'apply' for c in self.calls))

    def test_ambiguous_outcome_stops_and_restart_never_retries(self):
        inventory = self.inventory(3)
        plan = self.prepare(inventory)
        self.ambiguous_apply = self.ref(1)
        result = self.apply(plan, inventory)
        self.assertEqual([o['status'] for o in result], ['blocked'])
        with self.assertRaisesRegex(engine.LifecycleError, 'unresolved'):
            self.apply(plan, inventory)
        self.assertEqual(len([c for c in self.calls if c[0] == 'apply']), 1)

    def test_crash_after_attempt_marker_holds_new_runs(self):
        inventory = self.inventory()
        plan = self.prepare(inventory)
        engine.append(self.run_dir / 'actions.jsonl', {'consumer': self.config['consumer'], 'at': engine.now(), 'kind': 'archive',
                      'phase': 'archive-attempt', 'session': self.ref(1), 'fingerprint': engine.fingerprint(inventory['sessions'][0])})
        with self.assertRaisesRegex(engine.LifecycleError, 'unresolved'):
            self.apply(plan, inventory)
        self.assertIn(engine.fingerprint(inventory['sessions'][0]), engine.attempted(self.run_dir, self.config['consumer']))
        self.assertFalse(any(c[0] == 'review' for c in self.calls))

    def test_changed_observation_skips_without_mutation(self):
        inventory = self.inventory()
        plan = self.prepare(inventory)
        fresh = copy.deepcopy(inventory)
        fresh['sessions'][0]['lifecycle']['lastEventId'] = 'new-human-event'
        outcomes = self.apply(plan, inventory, fresh)
        self.assertEqual(outcomes[0]['reasonCode'], 'native_observation_changed')
        self.assertFalse(any(c[0] == 'apply' for c in self.calls))

    def test_summary_tamper_is_technical_stop(self):
        inventory = self.inventory()
        plan = self.prepare(inventory)
        Path(plan['archive']['prepared'][0]['summary']['path']).write_text('changed')
        outcomes = self.apply(plan, inventory)
        self.assertEqual(outcomes[0]['status'], 'blocked')
        self.assertFalse(any(c[0] == 'apply' for c in self.calls))

    def test_reviewed_override_only_soft_title_and_project(self):
        inventory = self.inventory()
        row = inventory['sessions'][0]
        row['title'] = 'Old coordinator probe title'
        self.config['archiveProjects'] = []
        self.config['reviewedTemporaryRefs'] = [{'session': row['sessionId'], 'fingerprint': engine.fingerprint(row)}]
        self.assertIsNone(engine.archive_guard(row, inventory, self.config))
        for field, value in [('selfRef', row['sessionId']), ('permanentRefs', [row['sessionId']]),
                             ('permanentPrefixes', ['codex:1111']), ('excludeRefs', [row['sessionId']]),
                             ('excludePatterns', ['probe']), ('humanWaitPatterns', ['probe'])]:
            config = {**self.config, field: value}
            self.assertIsNotNone(engine.archive_guard(row, inventory, config), field)
        row['class'] = 'orchestrator'
        self.assertEqual(engine.archive_guard(row, inventory, self.config), 'hard_role_protection')
        row['class'] = 'worker'
        row['lifecycle']['pendingQuestion'] = True
        self.assertEqual(engine.archive_guard(row, inventory, self.config), 'human_wait_or_unknown')

    def test_claude_unsupported_and_unconfigured_coverage_gap_stay_skipped(self):
        inventory = self.inventory()
        row = inventory['sessions'][0]
        row.update(harness='claude', sessionId=row['sessionId'].replace('codex:', 'claude:'))
        self.config['reviewedTemporaryRefs'] = [{'session': row['sessionId'], 'fingerprint': engine.fingerprint(row)}]
        plan = self.prepare(inventory)
        self.assertEqual(plan['archive']['skipped'][0]['reasonCode'], 'unsupported_harness')
        self.assertEqual(self.apply(plan, inventory), [])
        self.assertFalse(self.calls)
        inventory['linkCoverage'] = False
        self.assertEqual(engine.archive_guard(row, inventory, {**self.config, 'maxArchives': 0}), 'source_coverage_unproven')

    def test_prepare_pool_and_config_hard_limits(self):
        self.config['archivePrepareLimit'] = 2
        plan = self.prepare(self.inventory(5))
        self.assertEqual(len(plan['actions']), 2)
        for changes in ({'maxArchives': 11}, {'archivePrepareLimit': 201}, {'archivePrepareLimit': 0},
                        {'archiveReviewTimeoutMs': 300001}, {'reviewedTemporaryRefs': [self.ref(1)]}):
            with self.assertRaises(engine.LifecycleError):
                engine.validate_config({**self.config, **changes})

    def test_reviewed_archive_intent_never_resumes_even_report_only(self):
        inventory = self.inventory()
        row = inventory['sessions'][0]
        row['lifecycle'].update(turnActive=True, completion=None)
        row['attention'] = 'stalled-work'
        self.config['reviewedTemporaryRefs'] = [{'session': row['sessionId'], 'fingerprint': engine.fingerprint(row)}]
        self.config['maxArchives'] = 0
        plan = self.prepare(inventory)
        self.assertEqual(plan['actions'], [])
        self.assertFalse(self.calls)

    def test_no_eligible_pool_does_not_call_reviewer(self):
        inventory = self.inventory()
        self.prepare_skips.add(self.ref(1))
        plan = self.prepare(inventory)
        self.assertEqual(self.apply(plan, inventory), [])
        self.assertEqual([c[0] for c in self.calls], ['prepare'])

    def test_new_run_with_unchanged_native_observation_never_rearchives(self):
        inventory = self.inventory()
        self.apply(self.prepare(inventory), inventory)
        self.run_dir = self.root / 'runs' / 'second'
        self.run_dir.mkdir()
        plan = self.prepare(inventory)
        self.assertEqual(plan['actions'], [])
        self.assertEqual(plan['archive']['skipped'][0]['reasonCode'], 'previous_native_archive_confirmed')
        self.assertEqual(len([c for c in self.calls if c[0] == 'apply']), 1)

    def test_new_hard_role_protection_is_rechecked_per_thread(self):
        inventory = self.inventory(2)
        plan = self.prepare(inventory)
        fresh = copy.deepcopy(inventory)
        fresh['sessions'][0]['class'] = 'orchestrator'
        result = self.apply(plan, inventory, fresh)
        self.assertEqual(result[0]['reasonCode'], 'hard_role_protection')
        self.assertEqual(result[1]['status'], 'archived')
        self.assertEqual([c[1]['session'] for c in self.calls if c[0] == 'apply'], [self.ref(2)])

    def test_semantic_skip_outbox_key_ignores_poll_and_plan_timestamps(self):
        root = self.root / 'follow'
        root.mkdir()
        config = {**self.config, 'eventOutbox': str(root)}
        record = {'session': self.ref(1), 'kind': 'archive', 'fingerprint': 'a' * 64,
                  'phase': 'skipped', 'status': 'skipped', 'reasonCode': 'writer_live', 'at': engine.now()}
        engine.publish_outcomes(config, [record], self.run_dir)
        engine.publish_outcomes(config, [{**record, 'at': '2030-01-01T00:00:00Z', 'planDigest': 'another-plan'}], self.run_dir)
        engine.publish_outcomes(config, [{**record, 'reasonCode': 'descendant_live'}], self.run_dir)
        rows = [json.loads(line) for line in (root / 'outbox.jsonl').read_text().splitlines()]
        self.assertEqual(len(rows), 2)
        self.assertNotEqual(rows[0]['event_id'], rows[1]['event_id'])

    def test_known_hard_rejects_do_not_consume_prepare_hook_budget(self):
        inventory = self.inventory(8)
        self.config['archiveMaxCandidates'] = 2
        self.config['excludeRefs'] = [self.ref(3)]
        for row in inventory['sessions'][:2]:
            row.update(harness='claude', sessionId=row['sessionId'].replace('codex:', 'claude:'))
        self.config['reviewedTemporaryRefs'] = [{'session': row['sessionId'], 'fingerprint': engine.fingerprint(row)} for row in inventory['sessions'][:3]]
        plan = self.prepare(inventory)
        self.assertEqual(plan['archive']['prepareCalls'], 2)
        self.assertEqual([a['session'] for a in plan['actions']], [self.ref(4), self.ref(5)])
        self.assertEqual(len(plan['archive']['skipped']), 3)
        records = [json.loads(line) for line in (self.run_dir / 'actions.jsonl').read_text().splitlines()]
        self.assertEqual(sum(row['phase'] == 'preparation-skipped' for row in records), 3)

    def test_receipt_rotation_reaches_candidates_after_permanent_semantic_skips(self):
        inventory = self.inventory(5)
        self.config['archiveMaxCandidates'] = 2
        self.prepare_skips.update(row['sessionId'] for row in inventory['sessions'])
        self.prepare(inventory)
        self.run_dir = self.root / 'runs' / 'second'
        self.run_dir.mkdir()
        self.prepare(inventory)
        self.run_dir = self.root / 'runs' / 'third'
        self.run_dir.mkdir()
        self.prepare(inventory)
        considered = [call[1]['session'] for call in self.calls if call[0] == 'prepare']
        self.assertEqual(considered[:5], [self.ref(n) for n in range(1, 6)])
        self.assertEqual(len(considered), 6)

    def test_completed_noise_and_ephemeral_codex_are_prepared_but_not_resumed(self):
        inventory = self.inventory(2)
        inventory['sessions'][0].update(origin='automation')
        inventory['sessions'][1].update(origin='subagent', **{'class': 'ephemeral'})
        plan = self.prepare(inventory)
        self.assertEqual([action['kind'] for action in plan['actions']], ['archive', 'archive'])
        self.assertEqual(plan['counts'], {'archive-prepared': 2})
        self.assertTrue(all(entry['originalClassification'] == 'keep-noise' for entry in plan['entries']))
        self.assertTrue(all(entry in plan['approvals'] for entry in plan['entries']))

    def test_preparation_skip_cannot_settle_older_ambiguous_archive(self):
        records = [{'kind': 'archive', 'session': self.ref(1), 'phase': 'archive-attempt',
                    'fingerprint': 'a' * 64, 'planDigest': 'old', 'actionDigest': 'attempt'},
                   {'kind': 'archive', 'session': self.ref(1), 'phase': 'preparation-skipped', 'reasonCode': 'writer_live'},
                   {'kind': 'archive', 'session': self.ref(1), 'phase': 'skipped', 'planDigest': 'new', 'actionDigest': 'different'}]
        self.assertTrue(engine.archive_module().history(records)[self.ref(1)]['unresolved'])

    def test_global_projection_gap_allows_attested_canonical_per_thread_gate(self):
        inventory = self.inventory()
        inventory['linkCoverage'] = False
        plan = self.prepare(inventory)
        self.assertEqual(plan['archive']['status'], 'ready')
        self.assertEqual(plan['archive']['prepareCalls'], 1)
        action = plan['actions'][0]
        self.assertIs(action['obligationsChecked'], True)
        without = {key: value for key, value in action.items() if key not in ('actionDigest', 'obligationsChecked')}
        self.assertNotEqual(engine.digest(without), action['actionDigest'])
        self.assertFalse(inventory['linkCoverage'])
        self.assertTrue(any('link coverage incomplete' in gap for gap in plan['sourceGaps']))
        result = self.apply(plan, inventory)
        self.assertEqual(result[0]['status'], 'archived')
        self.assertEqual([c[0] for c in self.calls], ['prepare', 'review', 'apply'])
        frozen = json.loads((self.run_dir / 'plan.json').read_text())
        self.assertIs(frozen['actions'][0]['obligationsChecked'], True)
        self.assertFalse(json.loads((self.run_dir / 'inventory.json').read_text())['linkCoverage'])

    def test_missing_or_false_obligation_attestation_is_protocol_stop(self):
        inventory = self.inventory()
        inventory['linkCoverage'] = False
        for index, attestation in enumerate((None, False, 1, 'true')):
            with self.subTest(attestation=attestation):
                self.attestation = attestation
                self.run_dir = self.root / 'runs' / ('invalid-proof-' + str(index))
                self.run_dir.mkdir()
                plan = self.prepare(inventory)
                self.assertEqual(plan['archive']['status'], 'technical-error')
                self.assertIn('attestation required', plan['archive']['reason'])
                self.assertEqual(plan['actions'], [])
                with self.assertRaises(engine.LifecycleError):
                    self.apply(plan, inventory)
        self.assertTrue(all(call[0] == 'prepare' for call in self.calls))

    def test_incomplete_native_inventory_stops_before_prepare_hook(self):
        inventory = self.inventory()
        inventory.update(complete=False, linkCoverage=False, errors=['synthetic native failure'])
        plan = self.prepare(inventory)
        self.assertEqual(plan['archive']['status'], 'technical-error')
        self.assertIn('native inventory incomplete', plan['archive']['reason'])
        self.assertEqual(plan['archive']['prepareCalls'], 0)
        self.assertFalse(self.calls)
        with self.assertRaises(engine.LifecycleError):
            self.apply(plan, inventory)

    def test_projection_gap_never_relaxes_hard_protection(self):
        inventory = self.inventory()
        row = inventory['sessions'][0]
        cases = [(self.config, {'lifecycle': {**row['lifecycle'], 'pendingQuestion': True}}),
                 ({**self.config, 'selfRef': row['sessionId']}, {}),
                 ({**self.config, 'excludeRefs': [row['sessionId']]}, {}),
                 ({**self.config, 'permanentRefs': [row['sessionId']]}, {}),
                 (self.config, {'class': 'orchestrator'})]
        for config, changes in cases:
            candidate = {**row, **changes}
            expected = engine.archive_guard(candidate, inventory, config)
            self.assertIsNotNone(expected)
            self.assertEqual(engine.archive_guard(candidate, {**inventory, 'linkCoverage': False}, config), expected)

    def test_no_canonical_hook_keeps_projection_gap_report_only(self):
        inventory = self.inventory()
        inventory['linkCoverage'] = False
        del self.config['archivePrepareCommand']
        plan = self.prepare(inventory)
        self.assertEqual(plan['archive']['status'], 'report-only')
        self.assertEqual(plan['actions'], [])
        self.assertFalse(self.calls)
        self.assertEqual(engine.archive_guard(inventory['sessions'][0], inventory, self.config), 'source_coverage_unproven')

    def test_source_error_before_mutation_stops(self):
        inventory = self.inventory(2)
        plan = self.prepare(inventory)
        fresh = {**inventory, 'complete': False, 'errors': ['fixture unavailable']}
        result = self.apply(plan, inventory, fresh)
        self.assertEqual(result[0]['status'], 'blocked')
        self.assertFalse(any(c[0] == 'apply' for c in self.calls))


if __name__ == '__main__':
    unittest.main()
