"""Model-free communications policy, queue and delivery boundary checks."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
BIN = Path(__file__).resolve().parents[1]/'bin'
loader = importlib.util.spec_from_file_location('comms', BIN/'mesh-comms.py')
c = importlib.util.module_from_spec(loader); loader.loader.exec_module(c)


class CommsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        env = patch.dict(os.environ, {'MESH_COMMS_STATE': str(self.home/'comms'), 'AGENT_FALLBACK_STATE': str(self.home/'fallback')})
        env.start(); self.addCleanup(env.stop)
        self.control_original = c.controller_origin
        controller = patch.object(c, 'controller_origin', return_value=False)
        controller.start(); self.addCleanup(controller.stop)

    def spec(self, correlation='one', runtime='claude'):
        return {'kind': 'native', 'runtime': runtime, 'destination': '66666666-6666-4666-8666-666666666666',
                'message': 'Synthetic peer request', 'correlation': correlation}

    def test_receiver_outcomes_keep_transport_statuses_compatible(self):
        with c.locked() as (db, _):
            receipt = c.admit(db, self.spec())
            c.record_outcome(db, receipt['id'], 'unconfirmed', False)
            self.assertEqual(db.execute('SELECT status,detail FROM deliveries').fetchone(),
                             ('unknown', 'unconfirmed'))
            db.execute("UPDATE deliveries SET status='delivered' WHERE id=?", (receipt['id'],))
            c.record_outcome(db, receipt['id'], 'read', True)
            self.assertEqual(db.execute('SELECT status,detail FROM deliveries').fetchone(),
                             ('delivered', 'read'))
            with self.assertRaises(ValueError):
                c.record_outcome(db, receipt['id'], 'read', False)

    def test_inbox_observation_updates_transport_acceptance_separately(self):
        spec = {'kind': 'inbox', 'runtime': 'claude', 'destination': 'synthetic-session',
                'batch': ['synthetic record'], 'owner': {'pid': 1, 'start': '1'}}
        with c.locked() as (db, _):
            receipt = c.admit(db, spec)
            db.execute("UPDATE deliveries SET status='delivered',payload=NULL WHERE id=?", (receipt['id'],))
            db.commit()
        c.observe_inbox(spec, receipt['id'], False)
        with c.locked() as (db, _):
            state, detail, payload = db.execute('SELECT status,detail,payload FROM deliveries').fetchone()
            self.assertEqual((state, detail), ('unknown', 'unconfirmed'))
            self.assertEqual(json.loads(payload), spec)
            with self.assertRaisesRegex(ValueError, 'unknown'):
                c.admit(db, spec)
            self.assertEqual(c.admit(db, {**spec, 'batch': ['later record']})['status'], 'send')
        c.observe_inbox(spec, receipt['id'], True)
        with c.locked() as (db, _):
            self.assertEqual(db.execute('SELECT status,detail,payload FROM deliveries WHERE id=?',
                                       (receipt['id'],)).fetchone(), ('delivered', 'read', None))
        with self.assertRaisesRegex(ValueError, 'does not match'):
            c.observe_inbox({**spec, 'batch': ['different']}, receipt['id'], True)

    def test_queued_inbox_releases_dispatcher_lock_before_receipt_observation(self):
        spec = {'kind': 'inbox', 'runtime': 'claude', 'destination': 'synthetic-session',
                'batch': ['synthetic record'], 'owner': {'pid': 1, 'start': '1'}}
        c.change('queue', 'claude', 'test hold', 'test')
        with c.locked() as (db, _):
            c.admit(db, spec)
        code = """
import fcntl, importlib.util, json, os, sys
loader = importlib.util.spec_from_file_location('replay_test', sys.argv[1])
c = importlib.util.module_from_spec(loader)
loader.loader.exec_module(c)
spec = json.loads(sys.argv[2])
with c.Gate(spec) as gate:
    assert gate.send
    gate.accepted = True
# A separate descriptor must acquire the lock after enqueue, while the dispatcher waits.
fd = os.open(c.root() / 'delivery.lock', os.O_RDWR)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
finally:
    os.close(fd)
c.observe_inbox(spec, gate.receipt['id'], True)
"""
        with patch.object(c, 'command', return_value=[sys.executable, '-c', code,
                          str(BIN / 'mesh-comms.py'), c.encode(spec)]):
            result = c.change('on', 'claude', 'resume test', 'test')
        self.assertEqual(result['counts'], {'delivered': 1})
        with c.locked() as (db, _):
            self.assertEqual(db.execute('SELECT detail FROM deliveries').fetchone()[0], 'read')

    def test_native_resume_defaults_and_explicit_hold(self):
        codex = c.validate(self.spec(runtime='codex'))
        self.assertIs(codex['resume'], True)
        self.assertIn('--resume', c.command(codex))
        held = c.validate({**codex, 'resume': False})
        self.assertIn('--no-resume', c.command(held))
        self.assertNotIn('--resume', c.command(held))
        claude = c.validate(self.spec())
        self.assertIs(claude['resume'], False)
        self.assertNotIn('--resume', c.command(claude))
        self.assertNotIn('--no-resume', c.command(claude))

    def test_legacy_codex_queue_ids_and_payloads_survive_default_change(self):
        c.change('queue', 'codex', 'test hold', 'test')
        with c.locked() as (db, _):
            for correlation in ('legacy', ''):
                original = {**self.spec(correlation, 'codex'), 'resume': False}
                receipt = c.admit(db, original)
                before = db.execute('SELECT id,digest,payload,status FROM deliveries WHERE id=?',
                                    (receipt['id'],)).fetchone()
                default = self.spec(correlation, 'codex')
                duplicate = c.admit(db, default)
                self.assertTrue(duplicate['duplicate'])
                self.assertEqual(duplicate['id'], receipt['id'])
                self.assertEqual(duplicate['status'], 'queued')
                self.assertEqual(db.execute('SELECT id,digest,payload,status FROM deliveries WHERE id=?',
                                            (receipt['id'],)).fetchone(), before)
                self.assertIn('--no-resume', c.command(json.loads(before[2])))
                db.execute("UPDATE deliveries SET status='delivered',payload=NULL WHERE id=?", (receipt['id'],))
                self.assertEqual(c.admit(db, default)['status'], 'delivered')
                db.execute("UPDATE deliveries SET status='unknown' WHERE id=?", (receipt['id'],))
                with self.assertRaisesRegex(ValueError, 'unknown'):
                    c.admit(db, default)
                db.execute("UPDATE deliveries SET status='queued',payload=? WHERE id=?", (before[2], receipt['id']))
                if correlation:
                    with self.assertRaisesRegex(ValueError, 'different payload'):
                        c.admit(db, {**default, 'message': 'changed'})
            self.assertEqual(db.execute('SELECT count(*) FROM deliveries').fetchone()[0], 2)
        c.change('off', 'codex', 'test off', 'test')
        with c.locked() as (db, _):
            with self.assertRaisesRegex(ValueError, 'nothing stored'):
                c.admit(db, self.spec('new', 'codex'))

    def test_steer_queue_validation_and_replay_command(self):
        spec = {**self.spec(runtime='codex'), 'steer_first': True}
        self.assertIn('--steer-or-queue', c.command(spec))
        for change in ({'steer_first': False}, {'runtime': 'claude'}, {'kind': 'tmux'}, {'cloud': True}):
            with self.assertRaises(ValueError):
                c.validate({**spec, **change})

    def test_goal_validation_and_replay_command(self):
        spec = {**self.spec(runtime='codex'), 'goal': 'Finish the release', 'goal_resume': 'any'}
        args = c.command(c.validate(spec))
        self.assertEqual(args[args.index('--goal') + 1], 'Finish the release')
        self.assertEqual(args[args.index('--goal-resume') + 1], 'any')
        for change in ({'runtime': 'claude'}, {'goal': ' '}, {'goal': 3}, {'goal_resume': 'always'}):
            with self.assertRaisesRegex(ValueError, 'invalid goal options'):
                c.validate({**spec, **change})

    def test_cloud_validation_and_replay_command(self):
        spec = {**self.spec(), 'destination': 'session_Synthetic123', 'cloud': True}
        self.assertEqual(c.validate(spec)['cloud'], True)
        self.assertIn('--cloud', c.command(spec))
        for change in ({'cloud': False}, {'runtime': 'codex'}, {'kind': 'tmux'},
                       {'destination': 'Create a session'}, {'resume': True}, {'inbox_root': '/synthetic'}):
            with self.assertRaisesRegex(ValueError, 'invalid Claude cloud'):
                c.validate({**spec, **change})

    def test_queue_durable_dedupe_and_conflict(self):
        c.change('queue', 'claude', 'test hold', 'test')
        with c.locked() as (db, _):
            a = c.admit(db, self.spec()); b = c.admit(db, self.spec())
            self.assertEqual(a['status'], 'queued'); self.assertTrue(b['duplicate'])
            with self.assertRaisesRegex(ValueError, 'different payload'):
                c.admit(db, {**self.spec(), 'message': 'changed'})
        with c.locked() as (db, _):
            self.assertEqual(c.status(db)['counts'], {'queued': 1})

    def test_off_rejects_without_storing_message(self):
        c.change('off', 'all', 'test off', 'test')
        with c.locked() as (db, _):
            with self.assertRaisesRegex(ValueError, 'nothing stored'):
                c.admit(db, self.spec())
            self.assertEqual(db.execute('SELECT count(*) FROM deliveries').fetchone()[0], 0)
            self.assertEqual(db.execute('SELECT action,reason,actor FROM ledger').fetchone(), ('off', 'test off', 'test'))

    def test_scoped_queue_keeps_codex_on(self):
        c.change('queue', 'claude', 'test', 'test')
        with c.locked() as (db, _):
            self.assertEqual(c.admit(db, self.spec())['status'], 'queued')
            self.assertEqual(c.admit(db, self.spec(runtime='codex'))['status'], 'send')

    def test_fifo_flush_and_expiry(self):
        c.change('queue', 'claude', 'test', 'test')
        with c.locked() as (db, _):
            for n in ('a', 'b', 'c'): c.admit(db, self.spec(n))
            db.execute("UPDATE deliveries SET expires=0 WHERE seq=1"); db.commit()
        calls = []
        def run(argv, **kw):
            calls.append(argv[argv.index('--correlation-id')+1])
            return subprocess.CompletedProcess(argv, 0, '', '')
        with patch.object(c.subprocess, 'run', side_effect=run):
            result = c.change('on', 'claude', 'resume', 'test')
        self.assertEqual(calls, ['b', 'c'])
        self.assertEqual(result['counts'], {'delivered': 2, 'expired': 1})

    def test_uncertain_enqueue_is_not_retried_or_overtaken(self):
        c.change('queue', 'claude', 'test', 'test')
        with c.locked() as (db, _): c.admit(db, self.spec('a')); c.admit(db, self.spec('b'))
        with patch.object(c.subprocess, 'run', side_effect=subprocess.TimeoutExpired('stub', 1)) as run:
            c.change('on', 'claude', 'resume', 'test')
            with c.locked() as (db, fd):
                c.flush(db, fd)
                self.assertEqual(c.admit(db, self.spec('c'))['status'], 'queued')
            self.assertEqual(run.call_count, 1)

    def test_fallback_mode_and_hold_are_automatic_and_read_only(self):
        fallback = self.home/'fallback'; fallback.mkdir()
        (fallback/'mode').write_text('codex\n'); (fallback/'hold').write_text('until: manual')
        with c.locked() as (db, _): self.assertEqual(c.effective(db, 'claude'), 'queue')
        (fallback/'mode').write_text('claude\n')
        with c.locked() as (db, _): self.assertEqual(c.effective(db, 'claude'), 'queue')
        self.assertEqual((fallback/'hold').read_text(), 'until: manual')
        (fallback/'hold').unlink()
        with c.locked() as (db, _): self.assertEqual(c.effective(db, 'claude'), 'on')

    def test_native_and_tmux_hold_before_target_access(self):
        c.change('queue', 'claude', 'test', 'test')
        result = subprocess.run(['node', str(BIN/'agent-native-call.mjs'), '--agent', 'claude', '--session',
                                 self.spec()['destination'], '--correlation-id', 'no-wake-native', '--message', 'Synthetic hold'],
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)['held'])
        result = subprocess.run([str(BIN/'agent-send.sh'), '--agent', 'claude', 'absent-test-target', 'Synthetic hold'],
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 4, result.stderr)
        self.assertEqual(json.loads(result.stdout)['status'], 'queued')

    def test_inbox_pending_records_are_held_not_delivered(self):
        c.change('queue', 'claude', 'test', 'test')
        spec = importlib.util.spec_from_file_location('inbox', BIN/'agent-inbox-native.py')
        inbox = importlib.util.module_from_spec(spec); spec.loader.exec_module(inbox)
        with patch.object(inbox, '_deliver') as native:
            self.assertTrue(inbox.deliver('test-session', ['AGENT_MESH_INBOX '+json.dumps({'prompt':'test'})], {'pid':1,'start':'1'}))
            native.assert_not_called()

    def test_set_waits_for_inflight_enqueue_and_crash_is_uncertain(self):
        lease = subprocess.Popen([sys.executable, str(BIN/'mesh-comms.py'), 'lease', '--request', c.encode(self.spec(runtime='codex'))],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        self.addCleanup(lambda: lease.poll() is None and lease.kill())
        self.assertEqual(json.loads(lease.stdout.readline())['status'], 'send')
        setter = subprocess.Popen([sys.executable, str(BIN/'agent-mesh'), 'comms', 'off', '--reason', 'test', '--by', 'test'], stdout=subprocess.PIPE)
        with self.assertRaises(subprocess.TimeoutExpired): setter.wait(timeout=0.15)
        lease.stdin.close(); lease.wait(timeout=5); lease.stdout.close()
        setter.communicate(timeout=5)
        with c.locked() as (db, _): self.assertEqual(c.status(db)['counts'], {'unknown': 1})

    def test_read_only_lock_descriptor_cannot_authorize_replay(self):
        c.change('off', 'all', 'test', 'test')
        fd = os.open(c.root()/'delivery.lock', os.O_RDONLY)
        try:
            with patch.dict(os.environ, {'MESH_COMMS_REPLAY_FD':str(fd)}):
                with self.assertRaisesRegex(ValueError, 'capability pipe'):
                    c.replaying(self.spec())
        finally: os.close(fd)

    def test_parent_pid_and_claim_label_do_not_prove_controller_origin(self):
        graph = self.home/'graph'; graph.mkdir(); (graph/'graph.lock').mkdir()
        (graph/'graph.json').write_text(json.dumps({'roleClaims':[{'id':'fake','role':'global-controller',
          'project':'global','status':'active','expiresAt':'2099-01-01T00:00:00Z'}]}))
        original = self.control_original
        with patch.dict(os.environ, {'MESH_GRAPH_STATE':str(graph), 'PROJECT_DIRECTOR_GUARD_PID':str(os.getppid()),
                                    'PROJECT_DIRECTOR_GUARD_CLAIM':'fake', 'MESH_COMMS_GUARD_TOKEN':'forged'}):
            with c.locked() as (db, _): self.assertFalse(original(self.spec(), db))

    def test_replay_capability_is_payload_bound_and_single_use(self):
        c.change('queue', 'claude', 'test', 'test')
        with c.locked() as (db, _): c.admit(db, self.spec())
        code = ("import importlib.util,json,sys; s=importlib.util.spec_from_file_location('c',sys.argv[1]);"
                "c=importlib.util.module_from_spec(s);s.loader.exec_module(c);"
                "p=json.loads(sys.argv[2]);assert c.replaying(p)['status']=='send';"
                "print('accepted')")
        with patch.object(c, 'command', return_value=[sys.executable,'-c',code,str(BIN/'mesh-comms.py'),c.encode(self.spec())]):
            result = c.change('on', 'claude', 'resume', 'test')
        self.assertEqual(result['counts'], {'delivered':1})

    def test_off_rejects_previously_queued_duplicate(self):
        c.change('queue', 'claude', 'test', 'test')
        with c.locked() as (db, _): c.admit(db,self.spec())
        c.change('off','all','test','test')
        with c.locked() as (db, _):
            with self.assertRaisesRegex(ValueError,'off'): c.admit(db,self.spec())

    def test_fallback_return_restores_quota_linked_queue(self):
        fallback=self.home/'fallback';fallback.mkdir();(fallback/'mode').write_text('codex')
        c.change('queue','claude','test','test')
        with c.locked() as (db, _): c.admit(db,self.spec())
        (fallback/'mode').write_text('claude')
        with patch.object(c.subprocess,'run',return_value=subprocess.CompletedProcess([],0,'','')):
            with c.locked() as (db,fd):
                c.flush(db,fd)
                self.assertEqual(c.effective(db,'claude'),'on')
                self.assertEqual(c.status(db)['counts'],{'delivered':1})

    def test_queued_pre_enqueue_refusal_is_terminal(self):
        c.change('queue','codex','test','test')
        spec=self.spec(runtime='codex')
        with c.locked() as (db,_): c.admit(db,spec)
        sessions=self.home/'sessions';sessions.mkdir()
        with patch.dict(os.environ, {'CODEX_SESSION_ROOT':str(sessions)}):
            result=c.change('on','codex','resume','test')
        self.assertEqual(result['counts'],{'refused':1})
        with c.locked() as (db,_): self.assertEqual(c.admit(db,self.spec('next',runtime='codex'))['status'],'send')

    def test_queued_dead_inbox_owner_is_a_proven_refusal(self):
        c.change('queue','claude','test','test')
        spec={'kind':'inbox','runtime':'claude','destination':'test-session',
              'batch':['AGENT_MESH_INBOX '+json.dumps({'prompt':'test'})], 'owner':{'pid':99999999,'start':'1'}}
        with c.locked() as (db,_): c.admit(db,spec)
        result=c.change('on','claude','resume','test')
        self.assertEqual(result['counts'],{'refused':1})

    def test_real_controller_role_run_is_exempt(self):
        graph=self.home/'graph'
        sid='codex:22222222-2222-4222-8222-222222222222'
        def mesh(*args):
            r=subprocess.run(['node',str(BIN/'mesh-graph.mjs'),'--state',str(graph),'--json',*args],capture_output=True,text=True,timeout=10)
            self.assertEqual(r.returncode,0,r.stderr)
            return json.loads(r.stdout)
        mesh('add','--agent','codex','--runtime-uuid',sid.split(':')[1],'--tmux-target','test-controller')
        mesh('migrate','--apply')
        claim=mesh('role','claim','--session',sid,'--role','global-controller','--project','global')['claim']['id']
        code=("import importlib.util,sys,json; s=importlib.util.spec_from_file_location('c',sys.argv[1]);"
              "c=importlib.util.module_from_spec(s);s.loader.exec_module(c);"
              "print(json.dumps(c.controller_origin({'kind':'native'},None)))")
        with patch.dict(os.environ, {'MESH_GRAPH_STATE':str(graph)}):
            value=mesh('role','run','--session',sid,'--role','global-controller','--project','global','--claim-id',claim,
                       '--input',json.dumps({'argv':[sys.executable,'-c',code,str(BIN/'mesh-comms.py')]}))
        self.assertTrue(value)

    def test_legacy_dispatcher_preserves_unsupported_records(self):
        c.change('queue','claude','test','test')
        with c.locked() as (db,_): c.admit(db,self.spec())
        legacy=self.home/'legacy';legacy.mkdir();(legacy/'comms-no-replay').write_text('legacy overlay')
        with patch.object(c,'BIN',legacy), patch.object(c.subprocess,'run') as send:
            result=c.change('on','claude','resume','test')
            send.assert_not_called()
        self.assertEqual(result['counts'],{'queued':1})

    def test_mcp_control_surface(self):
        requests = [{'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2024-11-05'}},
                    {'jsonrpc':'2.0','id':2,'method':'tools/list'},
                    {'jsonrpc':'2.0','id':3,'method':'tools/call','params':{'name':'mesh_comms','arguments':{'action':'queue','scope':'claude','reason':'test','by':'test'}}}]
        result = subprocess.run([sys.executable, str(BIN/'agent-mesh'), 'comms', 'mcp'],
                                input='\n'.join(map(json.dumps, requests))+'\n', text=True, capture_output=True, timeout=5)
        rows = list(map(json.loads, result.stdout.splitlines()))
        self.assertEqual(rows[1]['result']['tools'][0]['name'], 'mesh_comms')
        self.assertEqual(json.loads(rows[2]['result']['content'][0]['text'])['effective']['claude'], 'queue')


if __name__ == '__main__': unittest.main()
