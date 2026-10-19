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
from unittest.mock import patch

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

    def test_hook_resume_context_permissions_and_authority(self):
        for _ in range(2):
            context = json.loads(self.hook().stdout)['hookSpecificOutput']['additionalContext']
            self.assertIn('run_in_background=true', context)
            self.assertIn('never user approval', context)
            self.assertIn('do not expand permissions', context)
            self.assertIn('--owner-pid', context)
            self.assertIn('AGENT_MESH_INBOX_DUPLICATE do-not-relaunch', context)
            self.assertIn('do not relaunch it', context)
        inbox = self.root / (SESSION + '.jsonl')
        inbox.write_text('retained\n')
        inbox.chmod(0o644)
        self.hook()
        self.assertEqual(inbox.read_text(), 'retained\n')
        self.assertEqual(inbox.stat().st_mode & 0o777, 0o600)

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
        self.assertIn('Start', self.hook(event='UserPromptSubmit').stdout)

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
        self.assertIn('Start', self.hook(session='other-session', event='UserPromptSubmit').stdout)
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

    def test_openpack_declares_claude_hooks_and_configurable_binary(self):
        repo = SCRIPT.parents[3]
        manifest = json.loads((repo / 'openpack.json').read_text())
        declarations = [entry for entry in manifest['provides'] if entry['type'] == 'hooks']
        self.assertEqual(len(declarations), 1)
        declaration = declarations[0]
        self.assertEqual(declaration['runtimes'], ['claude'])
        config = json.loads((repo / declaration['path']).read_text())
        self.assertEqual(set(config['hooks']), {'SessionStart', 'UserPromptSubmit'})
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


if __name__ == '__main__':
    unittest.main()
