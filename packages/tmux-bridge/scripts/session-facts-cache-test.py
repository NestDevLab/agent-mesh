#!/usr/bin/env python3
"""Synthetic incremental transcript and metadata contract checks."""
import json
import os
import sqlite3
import subprocess
import tempfile
import unittest
from pathlib import Path

WATCHER = Path(__file__).resolve().parents[1] / "bin" / "agent-watch.py"
CODEX_ID = "01a06ccf-134d-7cf0-9611-42819810e4ed"
CLAUDE_ID = "ef6791f1-24a5-43cf-8f26-6733ecfda183"


class FactsCacheTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def discover(self, agent):
        env = dict(os.environ)
        env.update(CODEX_SESSION_ROOT=str(self.root / "codex"), CLAUDE_SESSION_ROOT=str(self.root / "claude"),
                   CODEX_STATE_DB=str(self.root / "state.sqlite"), CLAUDE_SESSION_METADATA_ROOT=str(self.root / "metadata"))
        result = subprocess.run([str(WATCHER), "--agent", agent, "--discover", "--cache", str(self.root / "cache.json"),
                                 "--format", "jsonl"], env=env, text=True, capture_output=True, check=True)
        return json.loads(result.stdout)

    def test_codex_append_and_sqlite_title(self):
        transcript = self.root / "codex" / f"rollout-{CODEX_ID}.jsonl"
        transcript.parent.mkdir()
        with sqlite3.connect(self.root / "state.sqlite") as db:
            db.execute("CREATE TABLE threads (id TEXT, name TEXT, title TEXT, cwd TEXT, source TEXT, thread_source TEXT, archived INTEGER, is_pinned INTEGER)")
            db.execute("INSERT INTO threads VALUES (?,?,?,?,?,?,?,?)", (CODEX_ID, "Project: Task", "", "/workspace", "vscode", "user", 0, 0))
        events = [
            {"type": "session_meta", "payload": {"cwd": "/workspace"}},
            {"type": "event_msg", "timestamp": "2026-10-05T10:00:00Z", "payload": {"type": "user_message", "message": "# AGENTS.md instructions\nMy request for Codex: Fix the graph"}},
            {"type": "event_msg", "timestamp": "2026-10-05T10:01:00Z", "payload": {"type": "agent_message", "phase": "final_answer", "message": "Done."}},
        ]
        transcript.write_text("".join(json.dumps(item) + "\n" for item in events))
        first = self.discover("codex")[0]
        self.assertEqual(first["human_turns"], 1)
        self.assertEqual(first["first_real_prompt"], "Fix the graph")
        self.assertEqual(first["title"], "Project: Task")
        self.assertEqual(first["last_final_at"], "2026-10-05T10:01:00Z")
        self.assertEqual(self.discover("codex")[0]["human_turns"], 1)
        with transcript.open("a") as stream:
            stream.write(json.dumps({"type": "event_msg", "timestamp": "2026-10-05T10:02:00Z", "payload": {"type": "task_complete"}}) + "\n")
        warmed = self.discover("codex")[0]
        self.assertEqual(warmed["human_turns"], 1)
        self.assertEqual(warmed["last_event_kind"], "turn_complete")
        self.assertGreater(warmed["offset"], first["offset"])

    def test_claude_pid_metadata_and_question(self):
        transcript = self.root / "claude" / f"{CLAUDE_ID}.jsonl"
        transcript.parent.mkdir()
        transcript.write_text("".join(json.dumps(item) + "\n" for item in [
            {"type": "user", "timestamp": "2026-10-05T10:00:00Z", "cwd": "/workspace", "message": {"content": "Please check this"}},
            {"type": "assistant", "timestamp": "2026-10-05T10:01:00Z", "cwd": "/workspace", "message": {"content": [{"type": "text", "text": "Shall I proceed?"}]}},
        ]))
        metadata = self.root / "metadata"
        metadata.mkdir()
        (metadata / "123.json").write_text(json.dumps({"sessionId": CLAUDE_ID, "name": "Graph review", "status": "waiting", "waitingFor": "input needed", "hostSessionId": "local_fixture", "entrypoint": "claude-desktop"}))
        facts = self.discover("claude")[0]
        self.assertEqual(facts["name"], "Graph review")
        self.assertEqual(facts["hostSessionId"], "local_fixture")
        self.assertTrue(facts["pending_question"])
        self.assertEqual(facts["human_turns"], 1)


if __name__ == "__main__":
    unittest.main()
