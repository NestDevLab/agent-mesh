#!/usr/bin/env python3
"""Hermetic owner, cursor, privacy and prompt fallback regressions."""
import contextlib
import fcntl
import io
import importlib.util
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import tempfile
import threading
from types import SimpleNamespace
import time
import unittest
from unittest.mock import patch, MagicMock

SCRIPT = Path(__file__).resolve().parents[1] / 'bin' / 'agent-session-inbox.py'
SESSION = 'synthetic-session'
SCHEMA = 'agent-mesh.monitor-inbox-cursor.v1'
sys.dont_write_bytecode = True


def record(text):
    return json.dumps({'schema': 'agent-mesh.monitor-inbox.v1', 'prompt': text}) + '\n'


def identity(pid):
    fields = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
    return {'pid': pid, 'start': fields[19]}


class SessionInboxTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / 'inboxes'
        self.processes = []
        env = patch.dict(os.environ, {'MESH_COMMS_STATE':str(Path(self.temp.name)/'comms'),
                                     'AGENT_FALLBACK_STATE':str(Path(self.temp.name)/'fallback'),
                                     'CLAUDE_SESSION_ROOT':str(Path(self.temp.name)/'transcripts')})
        env.start(); self.addCleanup(env.stop)

    def tearDown(self):
        for proc in self.processes:
            if proc.poll() is None:
                proc.terminate()
            proc.communicate(timeout=5)
        self.temp.cleanup()

    def hook(self, agent='claude', session=SESSION, event='SessionStart', owner=None, extra_env=None, payload=None):
        env = {**os.environ, 'AGENT_MESH_HARNESS_PID': str(owner or os.getpid()), **(extra_env or {})}
        return subprocess.run([sys.executable, str(SCRIPT), 'hook', '--root', str(self.root), '--agent', agent],
                              input=json.dumps(payload if payload is not None else {'session_id': session, 'hook_event_name': event}),
                              env=env, text=True, capture_output=True, check=True)

    def watcher(self, owner=None, batch=0.1, agent='claude', extra_env=None):
        proc = subprocess.Popen([sys.executable, str(SCRIPT), 'watch', '--root', str(self.root),
                                 '--session', SESSION, '--owner-pid', str(owner or os.getpid()),
                                 '--batch-seconds', str(batch), '--retry-seconds', '0.02', '--agent', agent],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                env={**os.environ, **(extra_env or {})})
        self.processes.append(proc)
        return proc

    def ready(self):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            result = subprocess.run([sys.executable, str(SCRIPT), 'status', '--root', str(self.root),
                                     '--session', SESSION], capture_output=True, text=True)
            if result.returncode == 0:
                return json.loads(result.stdout)
            time.sleep(0.01)
        self.fail('supervisor did not become ready')

    def append(self, text):
        with (self.root / (SESSION + '.jsonl')).open('a') as stream:
            stream.write(text)

    def test_unconfirmed_batch_keeps_cursor_and_surfaces_alert(self):
        spec = importlib.util.spec_from_file_location('checkpoint_inbox_test', SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        inbox = module.prepare(self.root, SESSION)
        before = json.loads(inbox.with_suffix('.cursor.json').read_text())['offset']
        self.append(record('pending-request'))
        helper = SimpleNamespace(deliver=MagicMock(return_value=False))
        fake_spec = SimpleNamespace(loader=SimpleNamespace(exec_module=lambda _module: None))
        args = SimpleNamespace(root=self.root, session=SESSION, owner_pid=os.getpid(),
                               owner_start=None, mode='serve', batch_seconds=0, retry_seconds=0.01)
        with patch.object(module, 'alive', return_value=True), patch(
                'importlib.util.spec_from_file_location', return_value=fake_spec), patch(
                'importlib.util.module_from_spec', return_value=helper), patch.object(module.sys, 'stderr') as stderr:
            module.watch(args)
        helper.deliver.assert_called_once()
        cursor = json.loads(inbox.with_suffix('.cursor.json').read_text())
        self.assertEqual(cursor['offset'], before)
        self.assertEqual(cursor['alert'], 'delivery-unconfirmed')
        self.assertEqual(cursor['pending_offset'], inbox.stat().st_size)
        self.assertIn('AGENT_MESH_INBOX_UNCONFIRMED', str(stderr.write.call_args_list))

    def test_detached_service_survives_hook_exit_and_delivers_only_real_batches(self):
        owner = subprocess.Popen(['sleep', '30'])
        self.processes.append(owner)
        config = Path(self.temp.name) / 'claude'
        (config / 'sessions').mkdir(parents=True)
        (config / 'sessions' / 'owner.json').write_text(json.dumps({
            'pid': owner.pid, 'sessionId': SESSION, 'procStart': identity(owner.pid)['start'],
            'name': 'synthetic-peer', 'messagingSocketPath':'/synthetic/peer.sock'}))
        transcript = config / 'projects' / 'fixture' / (SESSION + '.jsonl')
        transcript.parent.mkdir(parents=True)
        transcript.write_text(json.dumps({'permissionMode': 'default'}) + '\n')
        calls = Path(self.temp.name) / 'native-calls.jsonl'
        native = Path(self.temp.name) / 'claude-native'
        native.write_text('#!' + sys.executable + '\n' + """
import json, os, sys
for line in sys.stdin:
    r=json.loads(line)
    if 'id' not in r: continue
    if r['method']=='initialize': result={}
    elif r['params']['name']=='ListAgents':
        result={'content':[{'type':'text','text':json.dumps({'sections':[{'kind':'sessions','rows':[{'name':'synthetic-peer','ref':__import__('hashlib').sha256(b'session:/synthetic/peer.sock').hexdigest()[:6]}]}]})}]}
    else:
        with open(os.environ['NATIVE_TRANSCRIPT'],'a') as f:
            f.write(json.dumps({'type':'queue-operation','operation':'enqueue',
                                'content':r['params']['arguments']['message']})+'\\n')
        with open(os.environ['NATIVE_CALL_LOG'],'a') as f: f.write(json.dumps(r['params']['arguments'])+'\\n')
        result={'content':[{'type':'text','text':json.dumps({'success':True})}]}
    print(json.dumps({'jsonrpc':'2.0','id':r['id'],'result':result}),flush=True)
""")
        native.chmod(0o700)
        result = self.hook(owner=owner.pid, extra_env={'CLAUDE_CONFIG_DIR':str(config),
                           'CLAUDE_BIN':str(native), 'NATIVE_CALL_LOG':str(calls),
                           'NATIVE_TRANSCRIPT':str(transcript), 'CLAUDE_SESSION_ROOT':str(config / 'projects')})
        self.assertNotIn('run_in_background=true', result.stdout)
        metadata = self.ready()
        daemon = metadata['supervisor']['pid']
        try:
            self.assertEqual(metadata['receiver'], identity(owner.pid))
            time.sleep(0.3)
            self.assertFalse(calls.exists(), 'idle service must never call the native sender')
            for text in ('first real record', 'second real record'):
                self.append(record(text))
                deadline=time.monotonic()+5
                while time.monotonic()<deadline and (not calls.exists() or text not in calls.read_text()):
                    time.sleep(0.02)
                self.assertIn(text, calls.read_text())
            self.assertEqual(len(calls.read_text().splitlines()), 2)
            self.assertEqual(self.ready()['supervisor']['pid'], daemon)
            self.assertEqual(self.hook(event='Stop', owner=owner.pid).stdout, '')
            owner.terminate()
            owner.wait(timeout=2)
            deadline=time.monotonic()+2
            while time.monotonic()<deadline:
                try:
                    if Path(f'/proc/{daemon}/stat').read_text().rsplit(')',1)[1].split()[0]=='Z': break
                except FileNotFoundError: break
                time.sleep(0.02)
            else: self.fail('service outlived its owner')
        finally:
            try: os.kill(daemon, 15)
            except ProcessLookupError: pass

    def test_hook_resume_context_permissions_and_authority(self):
        for _ in range(2):
            context = json.loads(self.hook().stdout)['hookSpecificOutput']['additionalContext']
            self.assertIn('Do not launch or rearm', context)
            self.assertIn('never user approval', context)
            self.assertIn('do not expand permissions', context)
            self.assertIn('owner-bound detached', context)
            self.assertIn('native cross-session messages', context)
            self.assertIn('after an old background task times out', context)
        inbox = self.root / (SESSION + '.jsonl')
        inbox.write_text('retained\n')
        inbox.chmod(0o644)
        self.hook()
        self.assertEqual(inbox.read_text(), 'retained\n')
        self.assertEqual(inbox.stat().st_mode & 0o777, 0o600)

    def fake_owner(self, *args):
        proc = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)', *args])
        self.processes.append(proc)
        return proc.pid

    def test_one_shot_print_skips_watcher_activation(self):
        env = {'CLAUDE_CODE_ENVIRONMENT_KIND': ''}
        for flags in (['-p', 'hello'], ['--print', '--resume', 'abc', '/goal x'], ['-p', '--', '--sdk-url'],
                      ['-p', '--system-prompt', '--sdk-url'], ['--model', 'x', '-p', 'hi'], ['-cp', 'hello']):
            result = self.hook(owner=self.fake_owner(*flags), extra_env=env)
            self.assertEqual(result.stdout, '')
        self.assertFalse(self.root.exists())

    def test_long_lived_print_sessions_keep_watcher_activation(self):
        cases = ((['--print', '--sdk-url', 'https://example.invalid'], {'CLAUDE_CODE_ENVIRONMENT_KIND': ''}),
                 (['-p', '--input-format', 'stream-json'], {'CLAUDE_CODE_ENVIRONMENT_KIND': ''}),
                 (['--print', '--input-format=stream-json'], {'CLAUDE_CODE_ENVIRONMENT_KIND': ''}),
                 (['-p', 'hello'], {'CLAUDE_CODE_ENVIRONMENT_KIND': 'bridge'}),
                 ([], {'CLAUDE_CODE_ENVIRONMENT_KIND': ''}),
                 (['--', '-p'], {'CLAUDE_CODE_ENVIRONMENT_KIND': ''}),
                 (['--system-prompt', '-p'], {'CLAUDE_CODE_ENVIRONMENT_KIND': ''}),
                 (['--add-dir', 'a', 'b', '--print', '--sdk-url=x'], {'CLAUDE_CODE_ENVIRONMENT_KIND': ''}),
                 (['-n', '-p'], {'CLAUDE_CODE_ENVIRONMENT_KIND': ''}),
                 (['-np'], {'CLAUDE_CODE_ENVIRONMENT_KIND': ''}))
        for flags, env in cases:
            context = json.loads(self.hook(owner=self.fake_owner(*flags), extra_env=env).stdout)
            self.assertIn('Do not launch or rearm', context['hookSpecificOutput']['additionalContext'])

    def test_codex_and_automation_disabled_without_side_effects(self):
        self.assertEqual(self.hook(agent='codex').stdout, '')
        self.assertEqual(self.hook(extra_env={'AGENT_MESH_INBOX_DISABLED': '1'}).stdout, '')
        self.assertFalse(self.root.exists())
        self.assertEqual(self.watcher(agent='codex').communicate(timeout=2), ('', ''))
        self.assertEqual(self.watcher(extra_env={'AGENT_MESH_INBOX_DISABLED': 'true'}).communicate(timeout=2), ('', ''))
        self.assertFalse(self.root.exists())
        self.assertFalse((SCRIPT.parent.parent / 'hooks' / 'codex-session-start.json').exists())

    def test_root_requires_owner_and_no_group_or_other_writes(self):
        self.root.mkdir(mode=0o700)
        for mode in (0o770, 0o707, 0o777):
            self.root.chmod(mode)
            result = self.hook()
            self.assertEqual((result.stdout, result.stderr), ('', ''))
            self.assertEqual(list(self.root.iterdir()), [])
            self.assertEqual(self.root.stat().st_mode & 0o777, mode)
        self.root.chmod(0o700)
        spec = importlib.util.spec_from_file_location('session_inbox_test', SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with patch.object(module.os, 'geteuid', return_value=os.geteuid() + 1):
            with self.assertRaises(ValueError):
                module.secure_root(self.root)

    def test_symlink_and_nonobject_payload_fail_open(self):
        for payload in ([], 'text', 42):
            result = self.hook(payload=payload)
            self.assertEqual((result.stdout, result.stderr), ('', ''))
        self.assertFalse(self.root.exists())
        target = Path(self.temp.name) / 'target'
        target.mkdir(mode=0o700)
        self.root.symlink_to(target)
        self.assertEqual(self.hook().stdout, '')
        self.assertEqual(list(target.iterdir()), [])

    def test_mailbox_symlink_and_invalid_session_are_rejected(self):
        self.assertEqual(self.hook(session='../invalid').stdout, '')
        self.root.mkdir(mode=0o700)
        target = Path(self.temp.name) / 'outside'
        target.write_text('untouched')
        (self.root / (SESSION + '.jsonl')).symlink_to(target)
        self.assertEqual(self.hook().stdout, '')
        self.assertEqual(target.read_text(), 'untouched')

    def test_prompt_fallback_without_start_and_unlocked_stale_lock(self):
        result = json.loads(self.hook(event='UserPromptSubmit').stdout)['hookSpecificOutput']
        self.assertEqual(result['hookEventName'], 'UserPromptSubmit')
        self.assertEqual(result['additionalContext'], json.loads(self.hook().stdout)['hookSpecificOutput']['additionalContext'])
        (self.root / (SESSION + '.watch.lock')).touch(mode=0o600)
        self.assertIn('Session mailbox', self.hook(event='UserPromptSubmit').stdout)

    def test_live_prompt_probe_is_silent_read_only_and_session_specific(self):
        self.hook()
        watcher = self.watcher()
        metadata = self.ready()
        self.assertEqual(metadata['owner'], identity(os.getpid()))
        self.assertEqual(metadata['supervisor']['pid'], watcher.pid)
        before = {p.name: (p.stat().st_mtime_ns, p.stat().st_mode) for p in self.root.iterdir()}
        for _ in range(3):
            result = self.hook(event='UserPromptSubmit')
            self.assertEqual((result.stdout, result.stderr), ('', ''))
        for name, info in before.items():
            self.assertEqual(((self.root/name).stat().st_mtime_ns, (self.root/name).stat().st_mode), info)
        self.assertIn('Session mailbox', self.hook(session='other-session', event='UserPromptSubmit').stdout)
        self.assertEqual(self.watcher().communicate(timeout=2), ('AGENT_MESH_INBOX_DUPLICATE do-not-relaunch\n', ''))

    def test_owner_exit_releases_lock_and_new_owner_takes_over(self):
        owner = subprocess.Popen(['sleep', '30'])
        self.processes.append(owner)
        self.hook(owner=owner.pid)
        old = self.watcher(owner=owner.pid)
        self.assertEqual(self.ready()['owner']['pid'], owner.pid)
        owner.terminate()
        owner.wait(timeout=2)
        new = self.watcher()
        self.assertEqual(old.communicate(timeout=2), ('', ''))
        self.assertEqual(self.ready()['supervisor']['pid'], new.pid)
        self.append(record('new-owner'))
        self.assertIn('new-owner', new.communicate(timeout=3)[0])

    def test_owner_pid_reuse_or_invalid_start_does_not_claim_lock(self):
        self.hook()
        result = subprocess.run([sys.executable, str(SCRIPT), 'watch', '--root', str(self.root),
                                 '--session', SESSION, '--owner-pid', str(os.getpid()), '--owner-start', 'wrong'],
                                capture_output=True, timeout=2)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, b'', b''))
        self.assertFalse((self.root / (SESSION + '.watch.lock')).exists())

    def test_cutover_starts_at_eof_without_replaying_old_messages(self):
        self.root.mkdir(mode=0o700)
        self.append(record('old-record'))
        self.hook()
        watcher = self.watcher()
        self.ready()
        self.assertFalse(select.select([watcher.stdout], [], [], 0.15)[0])
        self.append(record('fresh-record'))
        output, errors = watcher.communicate(timeout=3)
        self.assertEqual(errors, '')
        self.assertIn('fresh-record', output)
        self.assertNotIn('old-record', output)

    def test_cutover_adopts_legacy_cursor(self):
        self.root.mkdir(mode=0o700)
        inbox = self.root / (SESSION + '.jsonl')
        old = record('already-delivered')
        self.append(old + record('pending'))
        legacy = self.root / '.cursors'
        legacy.mkdir(mode=0o700)
        (legacy / (SESSION + '.json')).write_text(json.dumps({'schema': SCHEMA, 'inbox': str(inbox), 'offset': len(old.encode())}))
        self.hook()
        output, errors = self.watcher().communicate(timeout=3)
        self.assertEqual(errors, '')
        self.assertIn('pending', output)
        self.assertNotIn('already-delivered', output)

    def test_supervisor_cursor_never_advances_past_emitted_batch(self):
        self.hook()
        watcher = self.watcher(batch=0)
        self.ready()
        messages = ''.join(record('message-' + str(i)) for i in range(1000))
        self.append(messages)
        output, errors = watcher.communicate(timeout=3)
        self.assertEqual(errors, '')
        self.assertEqual(len(output.splitlines()), 1000)
        cursor = json.loads((self.root / (SESSION + '.cursor.json')).read_text())
        self.assertEqual(cursor['offset'], len(messages.encode()))
        self.append(record('after-batch'))
        output, _ = self.watcher().communicate(timeout=3)
        self.assertEqual(len(output.splitlines()), 1)
        self.assertIn('after-batch', output)

    def test_owner_exit_with_unemitted_batch_keeps_cursor_for_successor(self):
        owner = subprocess.Popen(['sleep', '30'])
        self.processes.append(owner)
        self.hook(owner=owner.pid)
        watcher = self.watcher(owner=owner.pid, batch=10)
        self.ready()
        self.append(record('pending-handover'))
        time.sleep(0.1)
        owner.terminate()
        owner.wait(timeout=2)
        self.assertEqual(watcher.communicate(timeout=2), ('', ''))
        self.assertEqual(json.loads((self.root / (SESSION + '.cursor.json')).read_text())['offset'], 0)
        self.assertIn('pending-handover', self.watcher().communicate(timeout=3)[0])

    def test_output_backpressure_does_not_hold_dead_owner_lock(self):
        owner = subprocess.Popen(['sleep', '30'])
        self.processes.append(owner)
        self.hook(owner=owner.pid)
        watcher = self.watcher(owner=owner.pid, batch=0)
        self.ready()
        self.append(record('large-' + 'x' * 200000))
        # Do not read stdout: the pipe fills while the supervisor owns the batch.
        time.sleep(0.15)
        owner.terminate()
        owner.wait(timeout=2)
        watcher.wait(timeout=2)
        self.assertEqual(json.loads((self.root / (SESSION + '.cursor.json')).read_text())['offset'], 0)
        output, errors = self.watcher(batch=0).communicate(timeout=3)
        self.assertEqual(errors, '')
        self.assertEqual(len(output.splitlines()), 1)
        self.assertIn('large-', output)

    def test_io_failure_retries_without_noise(self):
        self.hook()
        spec = importlib.util.spec_from_file_location('inbox_retry_test', SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        inbox = self.root / (SESSION + '.jsonl')
        failed, recover = threading.Event(), threading.Event()
        original_open = os.open
        emitted = []
        stdout, stderr = io.StringIO(), io.StringIO()
        def fail_then_recover(path, flags, *args, **kwargs):
            if Path(path) == inbox and not flags & os.O_CREAT:
                if not failed.is_set():
                    failed.set()
                    raise OSError('synthetic read failure')
                if not recover.wait(timeout=5):
                    raise OSError('test did not release recovery')
            return original_open(path, flags, *args, **kwargs)
        args = SimpleNamespace(root=self.root, session=SESSION, owner_pid=os.getpid(),
                               owner_start=None, batch_seconds=0, retry_seconds=0.001)
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr), patch.object(module.os, 'open', side_effect=fail_then_recover), patch.object(
                module, 'emit_batch', side_effect=lambda batch, owner: emitted.extend(batch) or True):
            worker = threading.Thread(target=module.watch, args=(args,))
            worker.start()
            try:
                self.assertTrue(failed.wait(timeout=5))
                self.assertTrue(worker.is_alive())
                self.assertEqual(emitted, [])
                replacement = self.root / 'replacement'
                replacement.write_text(record('recovered'))
                replacement.replace(inbox)
            finally:
                recover.set()
                worker.join(timeout=5)
            self.assertFalse(worker.is_alive())
        self.assertEqual((stdout.getvalue(), stderr.getvalue()), ('', ''))
        self.assertEqual(len(emitted), 1)
        self.assertIn('recovered', emitted[0])

    def test_probe_contention_retries_when_registered_supervisor_is_dead(self):
        self.hook()
        lock = self.root / (SESSION + '.watch.lock')
        lock.write_text(json.dumps({'schema': 'agent-mesh.session-inbox-lock.v1',
                                   'owner': identity(os.getpid()),
                                   'supervisor': {'pid': os.getpid(), 'start': 'expired'}}))
        lock.chmod(0o600)
        spec = importlib.util.spec_from_file_location('inbox_probe_test', SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        # A status probe takes the lock briefly; after it leaves the next attempt succeeds.
        with patch.object(module.fcntl, 'flock', side_effect=[BlockingIOError(), None]) as probe:
            fd = module.acquire_lock(self.root / (SESSION + '.jsonl'), identity(os.getpid()))
        self.assertIsNotNone(fd)
        os.close(fd)
        self.assertEqual(probe.call_count, 2)
        self.assertEqual(json.loads(lock.read_text())['supervisor'], identity(os.getpid()))

    def test_readiness_accepts_live_supervisor_without_child_reader(self):
        self.hook()
        watcher = self.watcher()
        self.ready()
        proc = Path(self.temp.name) / 'proc' / str(os.getpid())
        proc.mkdir(parents=True)
        (proc / 'cmdline').write_bytes(b'claude\0--resume\0' + SESSION.encode() + b'\0')
        provider = Path(self.temp.name) / 'claude-inventory'
        provider.write_text('#!/bin/sh\nprintf "[]\\n"\n')
        provider.chmod(0o700)
        result = subprocess.run(['node', str(SCRIPT.with_name('session-writer-status.mjs')),
                                 '--agent', 'claude', '--session', SESSION, '--require-single',
                                 '--require-monitor-inbox', str(self.root / (SESSION + '.jsonl'))],
                                env={**os.environ, 'AGENT_WRITER_PROC_ROOT': str(proc.parent), 'CLAUDE_BIN': str(provider)},
                                text=True, capture_output=True, timeout=3)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIsNone(watcher.poll())

    def test_readiness_accepts_remote_control_child_of_inbox_owner(self):
        self.hook()
        watcher = self.watcher()
        self.ready()
        child = Path(self.temp.name) / 'proc' / '999999'
        child.mkdir(parents=True)
        (child / 'cmdline').write_bytes(b'/opt/claude/versions/9.9.9\0--print\0--sdk-url\0https://example.invalid\0')
        (child / 'status').write_text(f'Name:\tclaude\nPPid:\t{os.getpid()}\n')
        provider = Path(self.temp.name) / 'claude-inventory'
        provider.write_text(f'#!/bin/sh\nprintf \'[{{"pid": 999999, "sessionId": "{SESSION}"}}]\\n\'\n')
        provider.chmod(0o700)
        command = ['node', str(SCRIPT.with_name('session-writer-status.mjs')), '--agent', 'claude',
                   '--session', SESSION, '--require-single',
                   '--require-monitor-inbox', str(self.root / (SESSION + '.jsonl'))]
        env = {**os.environ, 'AGENT_WRITER_PROC_ROOT': str(child.parent), 'CLAUDE_BIN': str(provider)}
        supervisor = json.loads((self.root / (SESSION + '.watch.lock')).read_text())['supervisor']['pid']
        supervisor_status = Path(self.temp.name) / 'proc' / str(supervisor) / 'status'
        supervisor_status.parent.mkdir(parents=True)
        # The supervisor is a descendant of the current session child: ready.
        supervisor_status.write_text('Name:\tpython3\nPPid:\t999999\n')
        result = subprocess.run(command, env=env, text=True, capture_output=True, timeout=3)
        self.assertEqual(result.returncode, 0, result.stderr)
        # Same remote-control parent, but the watcher belongs to a replaced or sibling child: not ready.
        supervisor_status.write_text('Name:\tpython3\nPPid:\t999998\n')
        result = subprocess.run(command, env=env, text=True, capture_output=True, timeout=3)
        self.assertEqual(result.returncode, 4, result.stderr)
        # A different parent never owns the inbox.
        supervisor_status.write_text('Name:\tpython3\nPPid:\t999999\n')
        (child / 'status').write_text('Name:\tclaude\nPPid:\t1\n')
        result = subprocess.run(command, env=env, text=True, capture_output=True, timeout=3)
        self.assertEqual(result.returncode, 4, result.stderr)
        self.assertIsNone(watcher.poll())

    def test_openpack_declares_claude_hooks_and_configurable_binary(self):
        repo = SCRIPT.parents[3]
        manifest = json.loads((repo / 'openpack.json').read_text())
        declarations = [entry for entry in manifest['provides'] if entry['type'] == 'hooks']
        self.assertEqual(len(declarations), 1)
        declaration = declarations[0]
        self.assertEqual(declaration['runtimes'], ['claude'])
        config = json.loads((repo / declaration['path']).read_text())
        self.assertEqual(set(config['hooks']), {'SessionStart', 'UserPromptSubmit', 'Stop'})
        env = {**os.environ, 'HOME': self.temp.name, 'CLAUDE_CONFIG_DIR': str(Path(self.temp.name) / '.claude'),
               'CLAUDE_PROJECT_DIR': str(Path(self.temp.name) / 'project'),
               'AGENT_MESH_HARNESS_PID': str(os.getpid()), 'AGENT_MESH_INBOX_ROOT': str(self.root)}
        env.pop('AGENT_MESH_BIN', None)
        installed = Path(env['CLAUDE_PROJECT_DIR']) / '.claude' / 'skills' / 'agent-tmux' / 'bin'
        installed.mkdir(parents=True)
        (installed / 'agent-session-inbox.py').symlink_to(SCRIPT)
        payload = json.dumps({'session_id': SESSION, 'hook_event_name': 'UserPromptSubmit'})
        for event in ('SessionStart', 'UserPromptSubmit'):
            handler = config['hooks'][event][0]['hooks'][0]
            self.assertEqual(handler['timeout'], 1)
            result = subprocess.run(['sh', '-c', handler['command']], env=env, input=payload,
                                    text=True, capture_output=True, timeout=3)
            self.assertEqual((result.returncode, result.stderr), (0, ''))
            self.assertIn('additionalContext', result.stdout)
            disabled = subprocess.run(['sh', '-c', handler['command']], env={**env, 'AGENT_MESH_INBOX_DISABLED': '1'},
                                      input=payload, text=True, capture_output=True, timeout=3)
            self.assertEqual((disabled.returncode, disabled.stdout, disabled.stderr), (0, '', ''))
        # User-level managed skills work when there is no project-local copy.
        (installed / 'agent-session-inbox.py').unlink()
        user_bin = Path(env['CLAUDE_CONFIG_DIR']) / 'skills' / 'agent-tmux' / 'bin'
        user_bin.mkdir(parents=True)
        (user_bin / 'agent-session-inbox.py').symlink_to(SCRIPT)
        result = subprocess.run(['sh', '-c', config['hooks']['UserPromptSubmit'][0]['hooks'][0]['command']],
                                env=env, input=payload, text=True, capture_output=True, timeout=3)
        self.assertIn('additionalContext', result.stdout)
        # A launcher override wins over the default installed location.
        env['AGENT_MESH_BIN'] = str(SCRIPT.parent)
        result = subprocess.run(['sh', '-c', config['hooks']['UserPromptSubmit'][0]['hooks'][0]['command']],
                                env=env, input=payload, text=True, capture_output=True, timeout=3)
        self.assertIn('additionalContext', result.stdout)

    def test_hook_timeout_and_command_failures_are_silent(self):
        proc = subprocess.Popen([sys.executable, str(SCRIPT), 'hook', '--root', str(self.root)],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.processes.append(proc)
        started = time.monotonic()
        self.assertEqual(proc.wait(timeout=2), 0)
        self.assertLess(time.monotonic() - started, 1.5)
        proc.stdin.close()
        proc.stdin = None
        self.assertEqual(proc.communicate(), (b'', b''))
        config = json.loads((SCRIPT.parent.parent/'hooks'/'claude-session-start.json').read_text())
        handler = config['hooks']['UserPromptSubmit'][0]['hooks'][0]
        self.assertEqual(handler['timeout'], 1)
        env = {**os.environ}
        env.pop('AGENT_MESH_BIN', None)
        env.update({'HOME': self.temp.name, 'CLAUDE_PROJECT_DIR': self.temp.name, 'CLAUDE_CONFIG_DIR': str(Path(self.temp.name) / '.claude')})
        result = subprocess.run(['sh', '-c', handler['command']], env=env, capture_output=True, timeout=2)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, b'', b''))
        env.update({'AGENT_MESH_BIN': str(SCRIPT.parent), 'AGENT_MESH_INBOX_ROOT': str(self.root),
                    'AGENT_MESH_HARNESS_PID': str(os.getpid())})
        result = subprocess.run(['sh', '-c', handler['command']], env=env,
                                input=json.dumps({'hook_event_name': 'UserPromptSubmit', 'session_id': SESSION}),
                                text=True, capture_output=True, timeout=2)
        self.assertEqual((result.returncode, result.stderr), (0, ''))
        self.assertEqual(json.loads(result.stdout)['hookSpecificOutput']['hookEventName'], 'UserPromptSubmit')


class NativeDeliveryTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        env = patch.dict(os.environ, {'MESH_COMMS_STATE':str(Path(self.temp.name)/'comms'),
                                     'AGENT_FALLBACK_STATE':str(Path(self.temp.name)/'fallback'),
                                     'CLAUDE_SESSION_ROOT':str(Path(self.temp.name)/'transcripts')})
        env.start(); self.addCleanup(env.stop)
        self.counter = 0
        spec = importlib.util.spec_from_file_location('native_delivery_test', SCRIPT.with_name('agent-inbox-native.py'))
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.owner = identity(os.getpid())
        self.registration = {'name':'synthetic-peer', 'sessionId':SESSION,
                             'messagingSocketPath':'/synthetic/peer.sock'}
        self.ref = __import__('hashlib').sha256(b'session:/synthetic/peer.sock').hexdigest()[:6]

    def native_result(self, value):
        return {'content':[{'type':'text','text':json.dumps(value)}]}

    def deliver(self, result, ref=None, confirmed=True, rows=None):
        native = MagicMock()
        native.__enter__.return_value = native
        native.request.side_effect = [self.native_result({'sections':[{'kind':'sessions','rows': rows if rows is not None else [
            {'name':'synthetic-peer', 'ref':ref or self.ref}]}]}), result]
        with patch.object(self.module, 'registration', return_value=(self.registration, self.owner)), patch.object(
                self.module, 'NativeClient', return_value=native), patch.object(
                self.module, 'permission_class', return_value='prompting'), patch.object(
                self.module, 'receipt_seen', return_value=False), patch.object(
                self.module, 'await_receipt', return_value=confirmed):
            self.counter += 1
            accepted = self.module.deliver(SESSION, ['real record '+str(self.counter)], self.owner)
        return accepted, native

    def test_delivery_requires_receiver_receipt(self):
        for value in ({'success':False}, {}, {'status':'sent'}):
            self.assertFalse(self.deliver(self.native_result(value), confirmed=False)[0])
        self.assertFalse(self.deliver({'isError':True,'content':[]}, confirmed=False)[0])
        self.assertTrue(self.deliver(self.native_result({'success':True}))[0])

    def test_same_name_with_another_ref_never_receives_records(self):
        accepted, native = self.deliver(self.native_result({'success':True}), ref='abcdef')
        self.assertFalse(accepted)
        self.assertEqual(native.request.call_count, 1)

    def test_same_name_selects_verified_unique_ref(self):
        accepted, native = self.deliver(self.native_result({'success': True}), rows=[
            {'name': 'synthetic-peer', 'ref': 'abcdef'},
            {'name': 'synthetic-peer', 'ref': self.ref}])
        self.assertTrue(accepted)
        self.assertEqual(native.request.call_args.args[1]['arguments']['to'],
                         'synthetic-peer [' + self.ref + ']')

    def test_transport_acceptance_without_receipt_is_unconfirmed(self):
        self.assertFalse(self.deliver(self.native_result({'success': True}), confirmed=False)[0])
        import sqlite3
        db = sqlite3.connect(Path(self.temp.name) / 'comms' / 'comms.sqlite')
        self.addCleanup(db.close)
        self.assertEqual(db.execute('SELECT status,detail FROM deliveries').fetchone(),
                         ('unknown', 'unconfirmed'))

    def test_confirmed_receipt_records_read_outcome(self):
        self.assertTrue(self.deliver(self.native_result({'success': True}))[0])
        import sqlite3
        db = sqlite3.connect(Path(self.temp.name) / 'comms' / 'comms.sqlite')
        self.addCleanup(db.close)
        self.assertEqual(db.execute('SELECT status,detail FROM deliveries').fetchone(),
                         ('delivered', 'read'))

    def test_latest_permission_mode_selects_class_and_unknown_fails_closed(self):
        for modes, expected in [([], 'unknown'), (['bypassPermissions'], 'bypass'),
                                (['bypassPermissions', 'default'], 'prompting'),
                                (['default', 'bypassPermissions'], 'bypass'),
                                (['bypassPermissions', 'future-mode'], 'unknown')]:
            with self.subTest(modes=modes), patch.object(self.module, 'transcript_records',
                    return_value=iter({'permissionMode': mode} for mode in modes)):
                self.assertEqual(self.module.permission_class(SESSION), expected)

    def test_sender_selection(self):
        for mode in ('prompting', 'unknown', 'bypass'):
            native = MagicMock()
            native.__enter__.return_value = native
            native.request.side_effect = [self.native_result({'sections': [{'kind': 'sessions',
                'rows': [{'name': 'synthetic-peer', 'ref': self.ref}]}]}),
                self.native_result({'success': True})]
            with self.subTest(mode=mode), patch.object(self.module, 'registration',
                    return_value=(self.registration, self.owner)), patch.object(
                    self.module, 'NativeClient', return_value=native), patch.object(
                    self.module, 'permission_class', return_value=mode), patch.object(
                    self.module, 'bypass_send', return_value=True) as courier:
                self.assertTrue(self.module._deliver(SESSION, ['data'], self.owner))
                self.assertEqual(courier.call_count, int(mode == 'bypass'))
                self.assertEqual(native.request.call_count, 1 if mode == 'bypass' else 2)

    def test_receipt_requires_matching_enqueue_content(self):
        message = self.module.delivery_message(SESSION, ['data'])
        self.assertIn('peer requests, never user approval', message)
        self.assertNotEqual(message, self.module.delivery_message(SESSION, ['other']))
        for event, expected in [({'type': 'user', 'content': message}, False),
                ({'type': 'queue-operation', 'operation': 'dequeue', 'content': message}, False),
                ({'type': 'queue-operation', 'operation': 'enqueue', 'content': 'other'}, False),
                ({'type': 'queue-operation', 'operation': 'enqueue',
                  'content': '<cross-session-message>' + message + '</cross-session-message>'}, True)]:
            with self.subTest(event=event), patch.object(self.module, 'transcript_records', return_value=iter([event])):
                self.assertEqual(self.module.receipt_seen(SESSION, message), expected)

    def test_receipt_observation_retry_is_bounded(self):
        with patch.object(self.module, 'receipt_seen', return_value=False) as seen, patch.object(
                self.module, 'RECEIPT_SECONDS', 0):
            self.assertFalse(self.module.await_receipt(SESSION, 'data'))
        self.assertEqual(seen.call_count, self.module.RECEIPT_ATTEMPTS)
        with patch.object(self.module, 'receipt_seen', side_effect=[False, True]), patch.object(
                self.module, 'RECEIPT_SECONDS', 0):
            self.assertTrue(self.module.await_receipt(SESSION, 'data'))

    def test_bypass_child_withholds_data_until_tool_inventory_is_verified(self):
        for tools, sends in [(['SendMessage'], 2), (['SendMessage', 'Bash'], 1), ([], 1)]:
            process = MagicMock()
            events = b''.join((json.dumps(event) + '\n').encode() for event in [
                {'type': 'system', 'subtype': 'init', 'tools': tools},
                {'type': 'result', 'is_error': False}, {'type': 'result', 'is_error': False}])
            with self.subTest(tools=tools), patch.object(self.module.subprocess, 'Popen',
                    return_value=process) as launch, patch.object(self.module.select, 'select',
                    return_value=([process.stdout], [], [])), patch.object(
                    self.module.os, 'read', side_effect=[events, b'']):
                if sends == 1:
                    with self.assertRaisesRegex(ValueError, 'restriction unverified'):
                        self.module.bypass_send('peer [ref]', 'UNTRUSTED DATA')
                else:
                    self.assertTrue(self.module.bypass_send('peer [ref]', 'UNTRUSTED DATA'))
                self.assertEqual(process.stdin.write.call_count, sends)
                self.assertNotIn('UNTRUSTED DATA', process.stdin.write.call_args_list[0].args[0].decode())
                if sends == 2:
                    data = json.loads(process.stdin.write.call_args_list[1].args[0])
                    payload = json.loads(data['message']['content'])
                    self.assertEqual(payload['message'], 'UNTRUSTED DATA')
                    self.assertEqual(payload['to'], 'peer [ref]')
                command = launch.call_args.args[0]
                self.assertEqual(command[command.index('--tools') + 1], 'SendMessage')
                self.assertEqual(command[command.index('--permission-mode') + 1], 'bypassPermissions')
                self.assertIn('--strict-mcp-config', command)
                self.assertIn('--no-session-persistence', command)
                self.assertEqual(launch.call_args.kwargs['env']['AGENT_MESH_INBOX_DISABLED'], '1')
                process.terminate.assert_called_once()

    def test_bypass_child_without_verified_init_never_receives_peer_data(self):
        process = MagicMock()
        events = (json.dumps({'type': 'result', 'is_error': False}) + '\n').encode()
        with patch.object(self.module.subprocess, 'Popen', return_value=process), patch.object(
                self.module.select, 'select', return_value=([process.stdout], [], [])), patch.object(
                self.module.os, 'read', return_value=events):
            self.assertFalse(self.module.bypass_send('peer [ref]', 'UNTRUSTED DATA'))
        self.assertEqual(process.stdin.write.call_count, 1)
        self.assertNotIn('UNTRUSTED DATA', process.stdin.write.call_args.args[0].decode())

    def test_bypass_child_timeout_is_bounded_and_reaped(self):
        process = MagicMock()
        with patch.object(self.module.subprocess, 'Popen', return_value=process), patch.object(
                self.module.select, 'select', return_value=([], [], [])) as polling:
            self.assertFalse(self.module.bypass_send('peer [ref]', 'UNTRUSTED DATA'))
        self.assertEqual(process.stdin.write.call_count, 1)
        self.assertLessEqual(polling.call_args.args[3], 30)
        process.terminate.assert_called_once()

    def test_initialization_failure_reaps_native_child(self):
        process = MagicMock()
        with patch.object(self.module.subprocess, 'Popen', return_value=process), patch.object(
                self.module.NativeClient, 'request', side_effect=TimeoutError('synthetic timeout')):
            with self.assertRaises(TimeoutError):
                self.module.NativeClient().__enter__()
        process.terminate.assert_called_once()
        process.wait.assert_called_once()
        process.stdin.close.assert_called_once()
        process.stdout.close.assert_called_once()


if __name__ == '__main__':
    unittest.main()
