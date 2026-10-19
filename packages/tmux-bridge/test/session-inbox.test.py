#!/usr/bin/env python3
"""Hermetic hook, privacy, restart and singleton checks."""
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

    def hook(self, agent="claude", session="synthetic-session"):
        return subprocess.run([sys.executable, str(SCRIPT), "hook", "--root", str(self.root),
                               "--agent", agent], input=json.dumps({"session_id": session}),
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
