#!/usr/bin/env python3
"""Hermetic hook, privacy, restart and singleton checks."""
import fcntl
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import tempfile
import time
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "bin" / "agent-session-inbox.py"


class SessionInboxTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "inboxes"
        self.processes = []

    def tearDown(self):
        for proc in self.processes:
            if proc.poll() is None:
                proc.terminate()
            proc.communicate(timeout=5)
        self.temp.cleanup()

    def hook(self, agent="claude", session="synthetic-session", event="SessionStart"):
        return subprocess.run([sys.executable, str(SCRIPT), "hook", "--root", str(self.root),
                               "--agent", agent], input=json.dumps({"session_id": session, "hook_event_name": event}),
                              text=True, capture_output=True, check=True)

    def watcher(self, env=None):
        proc = subprocess.Popen([sys.executable, str(SCRIPT), "watch", "--root", str(self.root),
                                 "--session", "synthetic-session", "--retry-seconds", "0.05"],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
        self.processes.append(proc)
        return proc

    def test_hook_new_resume_and_codex_context(self):
        for agent in ("claude", "codex"):
            for _ in range(2):
                result = json.loads(self.hook(agent).stdout)["hookSpecificOutput"]
                self.assertEqual(result["hookEventName"], "SessionStart")
                self.assertIn("watch", result["additionalContext"])
                if agent == "claude":
                    self.assertIn("run_in_background=true", result["additionalContext"])
        inbox = self.root / "synthetic-session.jsonl"
        self.assertEqual(inbox.stat().st_mode & 0o777, 0o600)
        inbox.write_text("retained\n")
        inbox.chmod(0o644)
        self.hook()
        self.assertEqual(inbox.read_text(), "retained\n")
        self.assertEqual(inbox.stat().st_mode & 0o777, 0o600)

    def test_reject_traversal_and_symlink_fail_open(self):
        self.assertEqual(self.hook(session="../outside").stdout, "")
        self.root.mkdir(exist_ok=True)
        target = Path(self.temp.name) / "target"
        target.write_text("unchanged")
        (self.root / "synthetic-session.jsonl").symlink_to(target)
        self.assertEqual(self.hook().stdout, "")
        self.assertEqual(target.read_text(), "unchanged")

    def test_singleton_silence_event_and_resume_cursor(self):
        self.hook()
        first = self.watcher()
        time.sleep(0.2)
        self.assertIn("already active", self.hook().stdout)
        self.assertEqual(self.hook(event="UserPromptSubmit").stdout, "")
        duplicate = self.watcher()
        self.assertEqual(duplicate.communicate(timeout=3), ("", ""))
        self.assertIsNone(first.poll())
        self.assertFalse(select.select([first.stdout], [], [], 0.15)[0])
        inbox = self.root / "synthetic-session.jsonl"
        with inbox.open("a") as stream:
            stream.write('noise\n{"schema":"wrong","prompt":"ignore"}\n')
            stream.flush()
        time.sleep(0.15)
        self.assertIsNone(first.poll())
        record = {"schema": "agent-mesh.monitor-inbox.v1", "prompt": "real event", "deliveryId": "test"}
        with inbox.open("a") as stream:
            stream.write(json.dumps(record) + "\n")
        output, errors = first.communicate(timeout=5)
        self.assertEqual(errors, "")
        self.assertIn("real event", output)
        self.assertEqual(output.count("AGENT_MESH_INBOX"), 1)
        resumed = self.watcher()
        self.assertFalse(select.select([resumed.stdout], [], [], 0.3)[0])
        self.assertIsNone(resumed.poll())

    def test_prompt_fallback_without_session_start_and_stale_lock(self):
        for agent in ("claude", "codex"):
            missing = self.hook(agent, event="UserPromptSubmit")
            self.assertEqual(missing.stderr, "")
            result = json.loads(missing.stdout)["hookSpecificOutput"]
            self.assertEqual(result["hookEventName"], "UserPromptSubmit")
            start = json.loads(self.hook(agent).stdout)["hookSpecificOutput"]
            self.assertEqual(result["additionalContext"], start["additionalContext"])
            stale = self.root / "synthetic-session.watch.lock"
            stale.touch(mode=0o600)
            self.assertIn("Start", self.hook(agent, event="UserPromptSubmit").stdout)
        self.assertEqual((self.root / "synthetic-session.jsonl").stat().st_mode & 0o777, 0o600)

    def test_live_prompt_probe_is_silent_and_read_only(self):
        self.hook()
        inbox = self.root / "synthetic-session.jsonl"
        lock = self.root / "synthetic-session.watch.lock"
        inbox.write_text("retained\n")
        inbox.chmod(0o640)
        with lock.open("w") as descriptor:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            before = {p.name: p.stat() for p in self.root.iterdir()}
            for agent in ("claude", "codex"):
                for _ in range(2):
                    result = self.hook(agent, event="UserPromptSubmit")
                    self.assertEqual((result.stdout, result.stderr), ("", ""))
                # A lock held for another identity cannot suppress activation.
                self.assertIn("Start", self.hook(agent, session="other-session", event="UserPromptSubmit").stdout)
            for name, original in before.items():
                current = (self.root / name).stat()
                self.assertEqual((current.st_mtime_ns, current.st_mode),
                                 (original.st_mtime_ns, original.st_mode))
        self.assertIn("Start", self.hook(event="UserPromptSubmit").stdout)
        self.assertEqual(inbox.read_text(), "retained\n")

    def test_hook_timeout_and_errors_never_block_or_emit(self):
        proc = subprocess.Popen([sys.executable, str(SCRIPT), "hook", "--root", str(self.root)],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.addCleanup(lambda: proc.kill() if proc.poll() is None else None)
        started = time.monotonic()
        # Keep stdin open without sending a payload; the internal budget must win.
        self.assertEqual(proc.wait(timeout=2), 0)
        self.assertLess(time.monotonic() - started, 1.5)
        proc.stdin.close()
        self.assertEqual((proc.stdout.read(), proc.stderr.read()), (b"", b""))
        proc.stdout.close()
        proc.stderr.close()
        result = self.hook(session="../invalid", event="UserPromptSubmit")
        self.assertEqual((result.stdout, result.stderr), ("", ""))
        self.root.write_text("not a directory")
        result = self.hook(event="UserPromptSubmit")
        self.assertEqual((result.stdout, result.stderr), ("", ""))

    def test_prompt_hook_fragments_are_bounded_and_fail_open(self):
        for agent in ("claude", "codex"):
            config = json.loads((SCRIPT.parent.parent / "hooks" / f"{agent}-session-start.json").read_text())
            handlers = config["hooks"]["UserPromptSubmit"][0]["hooks"]
            self.assertEqual(len(handlers), 1)
            handler = handlers[0]
            self.assertEqual(handler["timeout"], 1)
            # An absent binary configuration must also be a silent success.
            env = {**os.environ}
            env.pop("AGENT_MESH_BIN", None)
            result = subprocess.run(["sh", "-c", handler["command"]], env=env,
                                    capture_output=True, timeout=2)
            self.assertEqual((result.returncode, result.stdout, result.stderr), (0, b"", b""))
            env.update({"AGENT_MESH_BIN": str(SCRIPT.parent), "AGENT_MESH_INBOX_ROOT": str(self.root)})
            result = subprocess.run(["sh", "-c", handler["command"]], env=env,
                                    input=json.dumps({"session_id": "configured-session",
                                                      "hook_event_name": "UserPromptSubmit"}),
                                    text=True, capture_output=True, timeout=2)
            self.assertEqual((result.returncode, result.stderr), (0, ""))
            self.assertEqual(json.loads(result.stdout)["hookSpecificOutput"]["hookEventName"], "UserPromptSubmit")

    def test_reader_failure_restarts_without_noise(self):
        self.hook()
        bin_dir = Path(self.temp.name) / "bin"
        bin_dir.mkdir()
        counter = bin_dir / "attempts"
        fake = bin_dir / "node"
        fake.write_text("#!/bin/sh\necho attempt >> \"$TEST_COUNTER\"\necho 'FOLLOWER exit rearm'\nexit 1\n")
        fake.chmod(0o700)
        proc = self.watcher({**os.environ, "PATH": str(bin_dir) + ":" + os.environ["PATH"],
                             "TEST_COUNTER": str(counter)})
        limit = time.monotonic() + 3
        while (not counter.exists() or len(counter.read_text().splitlines()) < 2) and time.monotonic() < limit:
            time.sleep(0.02)
        self.assertGreaterEqual(len(counter.read_text().splitlines()), 2)
        self.assertIsNone(proc.poll())
        self.assertFalse(select.select([proc.stdout], [], [], 0.1)[0])


if __name__ == "__main__":
    unittest.main()
