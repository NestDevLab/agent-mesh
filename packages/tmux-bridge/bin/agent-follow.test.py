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
        self.assertEqual((self.root / "outbox.jsonl").stat().st_mode & 0o777, 0o600)

    def test_restart_replays_recently_printed_line(self):
        follow.append_outbox(self.root, [{"event_id": "one", "ref": REF, "kind": "ERROR", "body": "capacity", "timestamp": "2026-10-08T12:00:00Z", "selection": ENTRY}])
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(follow.print_pending(self.root), 1)
            self.assertEqual(follow.print_pending(self.root), 0)
            self.assertEqual(follow.print_pending(self.root, replay_window=120), 1)
        self.assertEqual(output.getvalue().count("ERROR capacity"), 2)

    def test_torn_outbox_tail_is_repaired_before_rederived_event(self):
        item = {"event_id": "turn-one", "ref": REF, "kind": "REPLY", "body": "First", "timestamp": "2026-10-08T12:00:00Z", "selection": ENTRY}
        follow.append_outbox(self.root, [item])
        with (self.root / "outbox.jsonl").open("ab") as handle:
            handle.write(b'{"event_id":"turn-two","seq":')
        second = {**item, "event_id": "turn-two", "body": "Second"}
        follow.append_outbox(self.root, [second])
        rows, _ = follow.outbox(self.root)
        self.assertEqual([(row["seq"], row["event_id"]) for row in rows], [(1, "turn-one"), (2, "turn-two")])

    def test_bridge_child_is_folded_and_orphan_is_not_auto_human(self):
        parent_id = "11111111-1111-4111-8111-111111111111"
        child_id = "22222222-2222-4222-8222-222222222222"
        child_ref = f"codex:{child_id}"
        path = self.root / f"rollout-2026-10-08T12-00-00-{child_id}.jsonl"
        path.write_text('{}\n')
        parent = {f"claude:{parent_id}": {"label": "coordinator", "mode": "steer", "addedBy": "test"}}
        candidates = [[(child_id, path)], []]
        with patch.object(follow.watch, "transcript_candidates", side_effect=candidates), \
             patch.object(follow.watch, "codex_metadata", return_value={}), \
             patch.object(follow.watch, "bridge_parents", return_value={child_id: parent_id}), \
             patch.object(follow, "created_at", return_value=time.time()), \
             patch.object(follow, "prompt_and_origin", return_value=("Implement", False)):
            found, _, _ = follow.discover(self.root, parent, {}, None)
        self.assertEqual([item["kind"] for item in found], ["SPAWNED"])
        self.assertEqual(parent[child_ref]["mode"], "child")
        self.assertEqual(parent[child_ref]["parent"], "coordinator")
        with patch.object(follow.watch, "transcript_candidates", side_effect=[[(child_id, path)], []]), \
             patch.object(follow.watch, "codex_metadata", return_value={}), \
             patch.object(follow.watch, "bridge_parents", return_value={child_id: parent_id}), \
             patch.object(follow, "created_at", return_value=time.time()), \
             patch.object(follow, "prompt_and_origin", return_value=("Implement", False)):
            orphan, _, _ = follow.discover(self.root, {}, {}, None)
        self.assertEqual(orphan, [])

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

    def test_discovered_resumed_session_starts_after_history(self):
        session_id = REF.split(":", 1)[1]
        path = self.root / f"rollout-2026-10-08T12-00-00-{session_id}.jsonl"
        path.write_text(json.dumps({"id": "old", "body": "Already seen"}) + "\n")
        follow.atomic_text(self.root / "last-run", str(time.time() - 10))
        follow.atomic_json(self.root / "discover-cache.json", {REF: path.stat().st_mtime})

        def event_for_record(_agent, record, _session_id):
            return [{"source_event_id": record["id"], "kind": "turn_complete", "outcome": "replied", "reply": record["body"], "timestamp": "2026-10-08T12:00:00Z"}]

        with patch.object(follow.watch, "transcript_candidates", side_effect=lambda agent: [(session_id, path)] if agent == "codex" else []), \
             patch.object(follow.watch, "codex_metadata", return_value={}), \
             patch.object(follow.watch, "bridge_parents", return_value={}), \
             patch.object(follow.watch, "session_origin", return_value="human"), \
             patch.object(follow.watch, "events_for", side_effect=event_for_record), \
             patch.object(follow, "created_at", return_value=time.time() - 3600), \
             patch.object(follow, "prompt_and_origin", return_value=("Start", False)):
            self.assertEqual(follow.tick(self.root, {}, None), 1)
            rows, _ = follow.outbox(self.root)
            self.assertEqual([row["kind"] for row in rows], ["RESUMED"])
            self.assertEqual(follow.read_json(follow.cursor_path(self.root, REF), {})["offset"], path.stat().st_size)
            with path.open("a") as handle:
                handle.write(json.dumps({"id": "new", "body": "Fresh reply"}) + "\n")
            self.assertEqual(follow.tick(self.root, {}, None), 1)
        rows, _ = follow.outbox(self.root)
        self.assertEqual([(row["kind"], row["body"]) for row in rows], [("RESUMED", "Start"), ("REPLY", "Fresh reply")])

    def test_discovered_new_human_session_reads_from_start(self):
        session_id = REF.split(":", 1)[1]
        path = self.root / f"rollout-2026-10-08T12-00-00-{session_id}.jsonl"
        path.write_text(json.dumps({"id": "first", "body": "First reply"}) + "\n")
        follow.atomic_text(self.root / "last-run", str(time.time() - 10))
        with patch.object(follow.watch, "transcript_candidates", side_effect=lambda agent: [(session_id, path)] if agent == "codex" else []), \
             patch.object(follow.watch, "codex_metadata", return_value={}), \
             patch.object(follow.watch, "bridge_parents", return_value={}), \
             patch.object(follow.watch, "session_origin", return_value="human"), \
             patch.object(follow.watch, "events_for", side_effect=lambda _agent, record, _session_id: [{"source_event_id": record["id"], "kind": "turn_complete", "outcome": "replied", "reply": record["body"], "timestamp": "2026-10-08T12:00:00Z"}]), \
             patch.object(follow, "created_at", return_value=time.time()), \
             patch.object(follow, "prompt_and_origin", return_value=("Start", False)):
            self.assertEqual(follow.tick(self.root, {}, None), 2)
        rows, _ = follow.outbox(self.root)
        self.assertEqual([(row["kind"], row["body"]) for row in rows], [("NEW", "Start"), ("REPLY", "First reply")])

    def test_resumed_session_uses_saved_cursor(self):
        path = self.root / "session.jsonl"
        old_line = json.dumps({"id": "old", "body": "Already seen"}) + "\n"
        path.write_text(old_line + json.dumps({"id": "new", "body": "Unread reply"}) + "\n")
        follow.atomic_json(follow.cursor_path(self.root, REF), {"path": str(path), "offset": len(old_line.encode()), "pending": {}})

        def resumed(_root, selected, _config, _self_ref):
            selected[REF] = ENTRY
            item = {"event_id": f"discovery:{REF}:RESUMED", "ref": REF, "kind": "RESUMED", "body": "Start", "timestamp": "2026-10-08T12:00:00Z", "selection": ENTRY}
            return [item], {REF: path}, {REF: path.stat().st_mtime}

        with patch.object(follow, "discover", side_effect=resumed), \
             patch.object(follow.watch, "events_for", side_effect=lambda _agent, record, _session_id: [{"source_event_id": record["id"], "kind": "turn_complete", "outcome": "replied", "reply": record["body"], "timestamp": "2026-10-08T12:00:00Z"}]):
            self.assertEqual(follow.tick(self.root, {}, None), 2)
        rows, _ = follow.outbox(self.root)
        self.assertEqual([(row["kind"], row["body"]) for row in rows], [("RESUMED", "Start"), ("REPLY", "Unread reply")])

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
