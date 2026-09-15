#!/usr/bin/env python3

import json
import sqlite3
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BIN = ROOT / "bin" / "bridge-launch-record.py"


class BridgeLaunchRecordTest(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        self.events = self.root / "launches" / "events.jsonl"
        self.db = self.root / "state_5.sqlite"
        with sqlite3.connect(self.db) as connection:
            connection.executescript(
                """
                CREATE TABLE threads (
                    id TEXT PRIMARY KEY, cwd TEXT NOT NULL,
                    created_at INTEGER NOT NULL, created_at_ms INTEGER
                );
                CREATE TABLE thread_spawn_edges (
                    parent_thread_id TEXT NOT NULL,
                    child_thread_id TEXT NOT NULL PRIMARY KEY,
                    status TEXT NOT NULL
                );
                """
            )

    def tearDown(self):
        self.tempdir.cleanup()

    def run_record(self, *args):
        return subprocess.run(
            ["python3", str(BIN), "--state", str(self.events), *args],
            check=True,
            text=True,
            capture_output=True,
        )

    def read_events(self):
        return [json.loads(line) for line in self.events.read_text().splitlines()]

    def start(self, target="mesh-codex-test", launched_at="1000"):
        route = json.dumps({"nativeModel": "gpt-test", "effort": "medium"})
        self.run_record(
            "start", "--agent", "codex", "--target", target,
            "--cwd", "/workspace", "--profile", "developer",
            "--route-json", route, "--route-status", "routed",
            "--caller", "caller-thread", "--launched-at-ms", launched_at,
        )

    def test_start_writes_extensible_attribution_record(self):
        self.start()
        event = self.read_events()[0]
        self.assertEqual(event["schema"], "agent-mesh.bridge-launch-event.v1")
        self.assertEqual(event["origin"], "tmux-bridge")
        self.assertEqual(event["profile"], "developer")
        self.assertEqual(event["model"], "gpt-test")
        self.assertEqual(event["effort"], "medium")
        self.assertEqual(event["cwd"], "/workspace")
        self.assertEqual(event["caller"], "caller-thread")
        self.assertIsNone(event["threadId"])

    def test_reconcile_records_one_exact_non_child_thread(self):
        self.start()
        with sqlite3.connect(self.db) as connection:
            connection.execute(
                "INSERT INTO threads(id, cwd, created_at, created_at_ms) VALUES(?, ?, ?, ?)",
                ("11111111-1111-4111-8111-111111111111", "/workspace", 2, 2000),
            )
            connection.execute(
                "INSERT INTO threads(id, cwd, created_at, created_at_ms) VALUES(?, ?, ?, ?)",
                ("22222222-2222-4222-8222-222222222222", "/workspace", 3, 3000),
            )
            connection.execute(
                "INSERT INTO thread_spawn_edges(parent_thread_id, child_thread_id, status) VALUES(?, ?, ?)",
                ("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "active"),
            )
        result = self.run_record(
            "reconcile", "--agent", "codex", "--target", "mesh-codex-test",
            "--codex-db", str(self.db), "--attempts", "1",
        )
        self.assertEqual(result.stdout.strip(), "11111111-1111-4111-8111-111111111111")
        event = self.read_events()[-1]
        self.assertEqual(event["event"], "launch.thread_resolved")
        self.assertEqual(event["candidateCount"], 1)

    def test_reconcile_marks_multiple_candidates_ambiguous(self):
        self.start()
        with sqlite3.connect(self.db) as connection:
            connection.executemany(
                "INSERT INTO threads(id, cwd, created_at, created_at_ms) VALUES(?, ?, ?, ?)",
                [
                    ("11111111-1111-4111-8111-111111111111", "/workspace", 2, 2000),
                    ("33333333-3333-4333-8333-333333333333", "/workspace", 3, 3000),
                ],
            )
        result = self.run_record(
            "reconcile", "--agent", "codex", "--target", "mesh-codex-test",
            "--codex-db", str(self.db), "--attempts", "1",
        )
        self.assertEqual(result.stdout, "")
        event = self.read_events()[-1]
        self.assertEqual(event["event"], "launch.thread_ambiguous")
        self.assertEqual(event["candidateCount"], 2)
        self.assertIsNone(event["threadId"])


if __name__ == "__main__":
    unittest.main()
