import copy
import contextlib
import datetime as dt
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('controller', Path(__file__).resolve().parents[1] / 'bin/session-controller.py')
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


class ControllerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.ledger = self.root / 'item.md'
        self.ledger.write_text('old')
        self.events = self.root / 'events.jsonl'
        self.events.write_text('{"id":"historical"}\n')
        self.director = self.root / 'director.json'
        self.director.write_text('{}')
        self.project = {'id': 'example', 'ledger': [str(self.ledger)],
                        'event_files': [str(self.events)], 'director_state': str(self.director)}
        self.now = dt.datetime(2026, 11, 3, 11, tzinfo=dt.timezone.utc).timestamp()

    def test_cycle_sync_after_handover_outside_plexus_and_observe_only_has_no_sync(self):
        config = {'state': str(self.root / 'controller.json'), 'mesh_bin': str(self.root / 'installed-bin'),
                  'session': 'codex:controller', 'claim_id': 'claim-test', 'owner_project': 'global',
                  'projects': [self.project]}
        config_path = self.root / 'config.json'
        c.save(config_path, config)
        for observe_only, sync_failure in [(False, False), (True, False), (False, True)]:
            with self.subTest(observe_only=observe_only, sync_failure=sync_failure):
                events = []
                active_guard = False

                @contextlib.contextmanager
                def guard(_config):
                    nonlocal active_guard
                    events.append('handover-completed')
                    active_guard = True
                    try:
                        yield
                    finally:
                        active_guard = False

                def invoke(argv, **_kwargs):
                    if argv[-1] == 'sync':
                        self.assertTrue(active_guard)
                        self.assertEqual(argv, [c.sys.executable, str(self.root / 'installed-bin/mesh-comms.py'), 'sync'])
                        events.append('sync')
                        if sync_failure:
                            raise c.CommandError(78, 'sync refused')
                    elif 'run' in argv:
                        self.assertTrue(active_guard)
                        events.append('role-run')
                        payload = json.loads(argv[-1])
                        self.assertNotIn('mesh-comms.py', ' '.join(payload['argv']))
                    return '{}'

                args = ['controller', '--config', str(config_path), '--once']
                if observe_only:
                    args += ['--observe-only']
                with patch.object(c.sys, 'argv', args), patch.object(c, 'mode_guard', guard), \
                        patch.object(c, 'command', side_effect=invoke), patch.object(c, 'collect'), \
                        patch.object(c, 'triage_pending') as triage, contextlib.redirect_stdout(c.sys.stderr):
                    if sync_failure:
                        with self.assertRaises(c.CommandError):
                            c.main()
                        triage.assert_not_called()
                        self.assertNotIn('role-run', events)
                    else:
                        c.main()
                        if observe_only:
                            self.assertNotIn('sync', events)
                            triage.assert_not_called()
                        else:
                            self.assertEqual(events.count('sync'), 1)
                            self.assertLess(events.index('handover-completed'), events.index('sync'))
                            self.assertLess(events.index('sync'), events.index('role-run'))

    def test_baseline_partial_rows_and_replay(self):
        state = {}
        c.observe(self.project, state, self.now)
        self.assertFalse(state.get('pending'))
        self.ledger.write_text('new')
        with self.events.open('a') as out:
            out.write('{"id":"fresh"}\n{"id":')
        c.observe(self.project, state, self.now + 1)
        self.assertEqual(len(state['pending']), 2)
        before = copy.deepcopy(state['pending'])
        c.observe(self.project, state, self.now + 2)
        self.assertEqual(state['pending'], before)
        with self.events.open('a') as out:
            out.write('"completed"}\n')
        c.observe(self.project, state, self.now + 3)
        self.assertEqual(len(state['pending']), 3)

    def test_real_deadline_closed_exclusion_and_six_hour_safety(self):
        self.director.write_text(json.dumps({'threads': {
            'live': {'last_activity_at': self.now - 21601, 'wait': {'until': self.now - 1}}, 'closed': {'wait': {'until': self.now - 1}, 'resolved': True},
            'future': {'wait': {'until': self.now + 60}}}}))
        state = {}
        c.observe(self.project, state, self.now)
        self.assertEqual(sorted(x['kind'] for x in state['pending'].values()), ['deadline', 'safety'])

    def test_repeated_content_is_a_new_transition_and_directors_are_excluded(self):
        state = {}
        c.observe(self.project, state, self.now)
        for offset, text in enumerate(['new', 'old', 'new']):
            self.ledger.write_text(text)
            c.observe(self.project, state, self.now + offset)
            for identity in state['pending']:
                state.setdefault('seen', {})[identity] = self.now
            self.assertEqual(len(state['pending']), 1)
            state['pending'] = {}
        with self.events.open('a') as out:
            out.write('{"ref":"claude:director","kind":"REPLY"}\n')
        c.observe(self.project, state, self.now + 4, {'sessions': [{'sessionId': 'claude:director', 'role': 'director'}]})
        self.assertFalse(state['pending'])

    def test_shared_log_and_triage_cache_are_project_and_payload_bound(self):
        alpha = dict(self.project, id='alpha', event_files=[], shared_event_files=[str(self.events)])
        beta = dict(self.project, id='beta', event_files=[], shared_event_files=[str(self.events)])
        states = [{}, {}]
        for project, state in zip([alpha, beta], states):
            c.observe(project, state, self.now)
        with self.events.open('a') as out:
            out.write('{"project":"alpha","kind":"REPLY","body":"quiet"}\n')
            out.write('{"project":"beta","kind":"QUESTION","body":"needs action"}\n')
        for project, state in zip([alpha, beta], states):
            c.observe(project, state, self.now + 1)
        self.assertNotEqual(set(states[0]['pending']), set(states[1]['pending']))
        keys = [c.batch_key(p, s['pending']) for p,s in zip([alpha,beta],states)]
        self.assertNotEqual(*keys)
        mode = self.root / 'mode'
        mode.write_text('claude')
        config = {'state': str(self.root / 'controller.json'), 'mode_file': str(mode),
                  'mesh_bin': str(self.root), 'session': 'codex:self', 'projects': [alpha,beta]}
        c.save(config['state'], {'projects': {'alpha': states[0], 'beta': states[1]}})
        for project, identity, wake in zip([alpha,beta],keys,[False,True]):
            c.save(self.root / ('triage-' + identity + '.json'), {'project':project['id'],
                   'batch':identity,'result': {'wake_director':wake,'digest':project['id']}})
        catalog = {'sessions': [{'runtime':'claude','sessionId':'claude:beta','claims':[{
            'role':'director','project':'beta','status':'active','expiresAt':self.now+100}]}]}
        def invoke(argv, **kwargs):
            if 'catalog' in argv:
                return json.dumps(catalog)
            self.assertIn('beta', argv[argv.index('--message')+1])
            return '{"status":"queued"}'
        with patch.object(c,'command',side_effect=invoke):
            report = c.step(config,now=self.now+2)
        self.assertEqual(report['projects'],{'alpha':'triaged-quiet','beta':'queued'})
        self.assertFalse(report['errors'])

    def test_refusal_and_explicit_unknown_receipt_reconciliation(self):
        mode = self.root / 'mode'
        mode.write_text('codex')
        config = {'state': str(self.root / 'controller.json'), 'mode_file': str(mode),
                  'mesh_bin': str(self.root), 'session':'codex:self','projects':[self.project]}
        self.director.write_text(json.dumps({'threads': {'due': {'wait':{'until':self.now}}}}))
        catalog = {'sessions':[{'runtime':'codex','sessionId':'codex:target','claims':[{
            'role':'director','project':'example','status':'active','expiresAt':self.now+100}]}]}
        with patch.object(c,'command',side_effect=[json.dumps(catalog),c.CommandError(78,'refused before enqueue')]):
            self.assertTrue(c.step(config,now=self.now)['errors'])
        ps = c.read(config['state'])['projects']['example']
        self.assertNotIn('dispatching',ps)
        with patch.object(c,'command',side_effect=[json.dumps(catalog),TimeoutError('unknown')]):
            c.step(config,now=self.now+1)
        ps = c.read(config['state'])['projects']['example']
        correlation='controller-'+ps['dispatching']['id']
        with self.assertRaises(ValueError):
            c.reconcile(config,'example','wrong','queued')
        c.reconcile(config,'example',correlation,'queued')
        ps = c.read(config['state'])['projects']['example']
        self.assertFalse(ps['pending'])
        self.assertNotIn('dispatching',ps)

    def test_recap_slots_do_not_wake_directors(self):
        for month, hour in [(1, 7), (7, 6)]:
            now = dt.datetime(2026, month, 2, hour, 30, 15, tzinfo=dt.timezone.utc).timestamp()
            state = {'observed_at': now - 60}
            c.observe(self.project, state, now)
            self.assertFalse(state.get('pending'))

    def test_activity_not_recap_or_lease_controls_safety(self):
        self.director.write_text(json.dumps({'recap': {'marked_at': self.now}, 'threads': {}}))
        for active, expect_safety in [(self.now - 21601, True), (self.now - 1, False)]:
            catalog = {'sessions': [{'project': 'example', 'role': 'director',
                        'last_activity_at': active, 'last_seen_at': self.now,
                        'metadata_updated_at': self.now}]}
            state = {}
            c.observe(self.project, state, self.now, catalog)
            self.assertEqual(bool(state.get('pending')), expect_safety)
        state = {}
        c.observe(self.project, state, self.now)
        c.observe(self.project, state, self.now + 21600)
        self.assertEqual([x['kind'] for x in state['pending'].values()], ['safety'])

    def test_input_and_other_projects_do_not_create_false_idle_activity(self):
        state = {}
        catalog = {'sessions': [{'project': 'other', 'last_activity_at': self.now},
                   {'project': 'example', 'role': 'global-controller', 'last_activity_at': self.now},
                   {'project': 'example', 'last_activity_at': self.now + 999999}]}
        c.observe(self.project, state, self.now, catalog)
        c.observe(self.project, state, self.now + 21600, catalog)
        self.assertTrue(state['pending'])
        self.ledger.write_text('actual work')
        c.observe(self.project, state, self.now + 21601, catalog)
        self.assertEqual([x['kind'] for x in state['pending'].values()], ['ledger'])
        self.assertTrue(state['retired_pending'])

    def test_excluded_catalog_sessions_do_not_postpone_safety(self):
        self.project['exclude_sessions'] = ['codex:excluded']
        for session, expect_safety in [('codex:excluded', True), ('codex:active', False)]:
            with self.subTest(session=session):
                state = {}
                c.observe(self.project, state, self.now)
                catalog = {'sessions': [{'project': 'example', 'sessionId': session,
                           'last_activity_at': self.now + 21600}]}
                c.observe(self.project, state, self.now + 21600, catalog)
                self.assertEqual(bool(state.get('pending')), expect_safety)

    def test_safety_pending_and_acknowledged_requests_remain_bounded(self):
        state = {}
        catalog = {'sessions': [{'project': 'example', 'last_activity_at': self.now - 21601}]}
        c.observe(self.project, state, self.now, catalog)
        original = copy.deepcopy(state['pending'])
        c.observe(self.project, state, self.now + 25000, catalog)
        self.assertEqual(state['pending'], original)
        state['seen'] = {identity: self.now + 25000 for identity in original}
        state['pending'] = {}
        state['safety_requested_at'] = self.now + 25000
        c.observe(self.project, state, self.now + 25001, catalog)
        self.assertFalse(state['pending'])
        c.observe(self.project, state, self.now + 46600, catalog)
        self.assertEqual([x['kind'] for x in state['pending'].values()], ['safety'])

    def test_legacy_pending_is_preserved_and_unknown_dispatch_is_not_retried(self):
        pending = {'old-recap': {'kind': 'recap', 'value': 'old-slot'},
                   'old-safety': {'kind': 'safety', 'value': {'no_recap_since': self.now - 30000}}}
        state = {'pending': copy.deepcopy(pending)}
        c.observe(self.project, state, self.now)
        self.assertFalse(state['pending'])
        self.assertEqual({k: v['item'] for k, v in state['retired_pending'].items()}, pending)
        state = {'pending': copy.deepcopy(pending), 'dispatching': {'keys': ['old-recap']}}
        c.observe(self.project, state, self.now)
        self.assertEqual(state['pending'], {'old-recap': pending['old-recap']})
        self.assertIn('dispatching', state)

    def test_routing_requires_exact_live_director_claim_and_mode(self):
        def row(runtime):
            return {'runtime': runtime, 'sessionId': runtime + ':test', 'claims': [{
                'role': 'director', 'project': 'example', 'status': 'active', 'expiresAt': self.now + 50}]}
        catalog = {'sessions': [row('codex'), row('claude')]}
        self.assertEqual(c.target(self.project, 'codex', [{'kind': 'recap'}], catalog, self.now), 'codex:test')
        self.assertEqual(c.target(self.project, 'claude', [{'kind': 'recap'}], catalog, self.now), 'claude:test')
        self.assertEqual(c.target(self.project, 'claude', [{'kind': 'ledger', 'value': {}}], catalog, self.now), 'claude:test')
        catalog['sessions'][0]['claims'][0]['project'] = 'other'
        with self.assertRaises(RuntimeError):
            c.target(self.project, 'codex', [], catalog, self.now)

    def test_durable_pending_and_no_blind_retry_after_unknown_enqueue(self):
        mode = self.root / 'mode'
        mode.write_text('codex')
        config = {'state': str(self.root / 'controller.json'), 'mode_file': str(mode), 'mesh_bin': str(self.root),
                  'session': 'codex:self', 'projects': [self.project]}
        catalog = {'sessions': [{'runtime': 'codex', 'sessionId': 'codex:target', 'claims': [{
            'role': 'director', 'project': 'example', 'status': 'active', 'expiresAt': self.now + 100}]}]}
        with patch.object(c, 'command', return_value=json.dumps(catalog)):
            c.step(config, now=self.now)
        self.director.write_text(json.dumps({'threads': {'due': {'wait': {'until': self.now}}}}))
        with patch.object(c, 'command', side_effect=[json.dumps(catalog), TimeoutError('unknown')]) as call:
            result = c.step(config, now=self.now + 1)
            self.assertEqual(call.call_count, 2)
            self.assertTrue(result['errors'])
        state = c.read(config['state'])
        self.assertTrue(state['projects']['example']['pending'])
        self.assertTrue(state['projects']['example']['dispatching'])
        with patch.object(c, 'command', return_value=json.dumps(catalog)) as call:
            c.step(config, now=self.now + 2)
            self.assertEqual(call.call_count, 1)


if __name__ == '__main__':
    unittest.main()
