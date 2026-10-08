#!/usr/bin/env python3
"""Durability and lifecycle checks for the follower's local state protocol."""

import contextlib
import importlib.util
import io
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch


FOLLOW = Path(__file__).with_name("agent-follow.py")
spec = importlib.util.spec_from_file_location("agent_follow", FOLLOW)
follow = importlib.util.module_from_spec(spec)
spec.loader.exec_module(follow)

REF = "codex:00000000-0000-4000-8000-000000000001"
ENTRY = {"label": "worker", "mode": "steer", "addedBy": "test"}


class FollowerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_crash_after_outbox_fsync_before_cursor_save_deduplicates(self):
        event = {"source_event_id": "turn:0", "kind": "turn_complete", "outcome": "replied", "reply": "Done", "timestamp": "2026-10-08T12:00:00Z"}
        first, _ = follow.derive(REF, ENTRY, [event], {})
        self.assertEqual(len(follow.append_outbox(self.root, first)), 1)
        # Re-reading from the same cursor after a crash must not create a second line.
        again, _ = follow.derive(REF, ENTRY, [event], {})
        self.assertEqual(follow.append_outbox(self.root, again), [])
        rows, _ = follow.outbox(self.root)
        self.assertEqual([(row["seq"], row["kind"]) for row in rows], [(1, "REPLY")])

    def test_restart_replays_recently_printed_line(self):
        follow.append_outbox(self.root, [{"event_id": "one", "ref": REF, "kind": "ERROR", "body": "capacity", "timestamp": "2026-10-08T12:00:00Z", "selection": ENTRY}])
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(follow.print_pending(self.root), 1)
            self.assertEqual(follow.print_pending(self.root), 0)
            self.assertEqual(follow.print_pending(self.root, replay_window=120), 1)
        self.assertEqual(output.getvalue().count("ERROR capacity"), 2)

    def test_child_hides_reply_but_keeps_error_and_question(self):
        entry = {**ENTRY, "mode": "child", "parent": "parent"}
        events = [
            {"source_event_id": "q-tool", "schema": "agent-mesh.event.v2", "kind": "tool", "tool_name": "AskUserQuestion", "body": "raw input", "timestamp": "2026-10-08T12:00:00Z"},
            {"source_event_id": "q", "schema": "agent-mesh.event.v2", "kind": "question", "body": "Choose", "timestamp": "2026-10-08T12:00:00Z"},
            {"source_event_id": "a", "kind": "turn_complete", "outcome": "replied", "reply": "Handled by parent", "timestamp": "2026-10-08T12:00:01Z"},
            {"source_event_id": "e", "kind": "turn_complete", "outcome": "error", "error": {"message": "capacity"}, "timestamp": "2026-10-08T12:00:02Z"},
        ]
        lines, _ = follow.derive(REF, entry, events, {})
        self.assertEqual([line["kind"] for line in lines], ["QUESTION", "ERROR"])

    def test_partial_jsonl_line_waits_for_newline(self):
        path = self.root / "rollout-00000000-0000-4000-8000-000000000001.jsonl"
        record = {"type": "event_msg", "timestamp": "2026-10-08T12:00:00Z", "payload": {"type": "task_complete", "turn_id": "turn"}}
        path.write_text(json.dumps(record)[:-2])
        _, cursor = follow.read_records("codex", REF, path, {"path": str(path), "offset": 0, "pending": {}})
        self.assertEqual(cursor["offset"], 0)
        path.write_text(json.dumps(record) + "\n")
        events, cursor = follow.read_records("codex", REF, path, cursor)
        self.assertEqual(cursor["offset"], path.stat().st_size)
        self.assertEqual(len(events), 1)

    def test_selection_cli_round_trip(self):
        with patch.dict(os.environ, {"XDG_STATE_HOME": str(self.root)}):
            self.assertEqual(follow.main(["add", "--name", "test", REF, "--label", "Worker", "--mode", "steer"]), 0)
            selected = follow.load_selection(follow.state_dir("test"))
            self.assertEqual(selected[REF]["label"], "Worker")
            self.assertEqual(follow.main(["remove", "--name", "test", REF]), 0)
            self.assertEqual(follow.load_selection(follow.state_dir("test")), {})

    def test_warm_tick_with_twenty_selected_sessions(self):
        sessions = {}
        transcripts = {}
        for number in range(20):
            session_id = f"00000000-0000-4000-8000-{number:012d}"
            ref = f"codex:{session_id}"
            path = self.root / f"rollout-2026-10-08T12-00-00-{session_id}.jsonl"
            path.write_text(json.dumps({"type": "session_meta", "timestamp": "2026-10-08T12:00:00Z", "payload": {"type": "session_meta", "source": "vscode"}}) + "\n")
            sessions[ref] = {"label": f"worker-{number}", "mode": "observe", "addedBy": "test"}
            transcripts[ref] = path
        follow.save_selection(self.root, sessions)
        with patch.object(follow, "discover", return_value=([], transcripts, {})):
            began = time.monotonic()
            follow.tick(self.root, {}, None)
            elapsed = time.monotonic() - began
        self.assertLess(elapsed, 3.0)
        self.assertEqual(len(list((self.root / "cursors").glob("*.json"))), 20)


if __name__ == "__main__":
    unittest.main()
