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
        controller = patch.object(c, 'controller_origin', return_value=False)
        controller.start(); self.addCleanup(controller.stop)

    def spec(self, correlation='one', runtime='claude'):
        return {'kind': 'native', 'runtime': runtime, 'destination': '66666666-6666-4666-8666-666666666666',
                'message': 'Synthetic peer request', 'correlation': correlation}

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
