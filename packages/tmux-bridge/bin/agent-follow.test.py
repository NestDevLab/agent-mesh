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
        environment = patch.dict(os.environ, {"XDG_STATE_HOME": str(self.root / "state")})
        environment.start()
        self.addCleanup(environment.stop)

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

    def test_bridge_child_requires_graph_edge_and_orphan_is_observed(self):
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
            found, _, _ = follow.discover(self.root, parent, {"_graph": {
                "nodes": [{"id": "owner", "agent": "claude", "runtimeUuid": parent_id}, {"id": "child", "agent": "codex", "runtimeUuid": child_id}],
                "edges": [{"from": "owner", "to": "child", "type": "spawned-by"}]}}, None)
        self.assertEqual([item["kind"] for item in found], ["SPAWNED"])
        self.assertEqual(parent[child_ref]["mode"], "child")
        self.assertEqual(parent[child_ref]["parent"], "coordinator")
        with patch.object(follow.watch, "transcript_candidates", side_effect=[[(child_id, path)], []]), \
             patch.object(follow.watch, "codex_metadata", return_value={}), \
             patch.object(follow.watch, "bridge_parents", return_value={child_id: parent_id}), \
             patch.object(follow, "created_at", return_value=time.time()), \
             patch.object(follow, "prompt_and_origin", return_value=("Implement", False)):
            orphan, _, _ = follow.discover(self.root, {}, {}, None)
        self.assertEqual([item["kind"] for item in orphan], ["SPAWNED"])
        self.assertEqual(orphan[0]["selection"]["mode"], "observe")

    def test_launch_join_and_resume_never_parentage(self):
        child = REF.split(":", 1)[1]
        other = "00000000-0000-4000-8000-000000000002"
        path = self.root / "launches.jsonl"
        rows = [
            {"event": "launch.started", "launchId": "spawn", "caller": "unknown", "threadId": None},
            {"event": "launch.thread_resolved", "launchId": "spawn", "threadId": child},
            {"event": "launch.started", "launchId": "resume", "caller": child, "threadId": other},
        ]
        path.write_text("".join(json.dumps({"schema": "agent-mesh.bridge-launch-event.v1", **row}) + "\n" for row in rows))
        with patch.dict(os.environ, {"AGENT_MESH_LAUNCH_EVENTS": str(path)}):
            self.assertEqual(follow.watch.bridge_parents(), {child: "unknown"})
        self.assertEqual(follow.watch.session_origin("codex", {}, None), "human")

    def test_bootstrap_old_idle_session_without_cache(self):
        child = REF.split(":", 1)[1]
        path = self.root / "idle.jsonl"
        path.write_text('{}\n')
        old = time.time() - 7 * 86400
        os.utime(path, (old, old))
        with patch.object(follow.watch, "transcript_candidates", side_effect=[[(child, path)], []]), \
             patch.object(follow.watch, "codex_metadata", return_value={}), \
             patch.object(follow.watch, "bridge_parents", return_value={}), \
             patch.object(follow, "created_at", return_value=old - 3600), \
             patch.object(follow, "prompt_and_origin", return_value=("Continue", False)):
            selected = {}
            events, _, _ = follow.discover(self.root, selected, {}, None)
        self.assertIn(REF, selected)
        self.assertEqual(events[0]["kind"], "RESUMED")

    def registry(self, sessions):
        path = self.root / "registry.json"
        follow.atomic_json(path, {"schema": "agent-mesh.session-registry.v1", "sessions": sessions})
        return {"registryPath": str(path)}

    def test_registry_add_close_pin_and_reentry(self):
        item = {"lastSeenAt": "2999-01-01T00:00:00Z", "domains": ["sample"]}
        config = self.registry({REF: item})
        selected = {}
        follow.reconcile(self.root, selected, config, None)
        self.assertEqual(selected[REF]["mode"], "observe")
        config = self.registry({})
        events, _, _ = follow.reconcile(self.root, selected, config, None)
        self.assertEqual([event["kind"] for event in events], ["CLOSED"])
        self.assertEqual(selected, {})
        self.assertEqual(follow.reconcile(self.root, selected, config, None)[0], [])
        selected[REF] = {**ENTRY, "addedBy": "cli"}
        self.assertEqual(follow.reconcile(self.root, selected, config, None)[0], [])
        self.assertIn(REF, selected)
        self.assertEqual(selected[REF]["mode"], "observe")

    def test_scope_and_registry_retire_discovery(self):
        config = self.registry({REF: {"lastSeenAt": "2999-01-01T00:00:00Z", "domains": ["sample"]}})
        selected = {REF: {**ENTRY, "addedBy": "discovery"}}
        follow.reconcile(self.root, selected, config, None)
        self.assertEqual(selected[REF]["addedBy"], "registry")
        config["follower"] = {"scope": {"excludeDomains": ["sample"]}}
        events, _, excluded = follow.reconcile(self.root, selected, config, None)
        self.assertIn(REF, excluded)
        self.assertEqual(events[0]["kind"], "CLOSED")
        self.assertEqual(follow.scope_reason({}, {"follower": {"scope": {"unknownDomain": "exclude"}}}), "unknown-domain")

    def test_current_and_legacy_waiting_attention_keep_old_source_members_open(self):
        for state in ("waiting-user", "waiting-joseph"):
            for source in ("graphPath", "registryPath"):
                with self.subTest(state=state, source=source):
                    item = {"id": "worker", "agent": "codex", "runtimeUuid": REF.split(":")[1],
                            "lastSeenAt": "2000-01-01T00:00:00Z", "attention": {"state": state}}
                    path = self.root / f"{source}-{state}.json"
                    payload = {"nodes": [item], "edges": []} if source == "graphPath" else {
                        "schema": "agent-mesh.session-registry.v1", "sessions": {REF: item}}
                    follow.atomic_json(path, payload)
                    selected = {}
                    follow.reconcile(self.root, selected, {source: str(path)}, None)
                    self.assertIn(REF, selected)
                    self.assertEqual(selected[REF]["addedBy"], source.removesuffix("Path"))
                    self.assertEqual(selected[REF]["mode"], "observe")
                    # Waiting attention cannot override an explicit closure.
                    item["status"] = "closed"
                    follow.atomic_json(path, payload)
                    events, _, _ = follow.reconcile(self.root, selected, {source: str(path)}, None)
                    self.assertNotIn(REF, selected)
                    self.assertEqual([event["kind"] for event in events], ["CLOSED"])

    def test_graph_fallback_deduplicates_and_requires_explicit_authority(self):
        owner = "claude:00000000-0000-4000-8000-000000000002"
        graph = {"nodes": [
            {"id": "owner", "agent": "claude", "runtimeUuid": owner.split(":")[1]},
            {"id": "old", "agent": "codex", "runtimeUuid": REF.split(":")[1], "lastSeenAt": "2000-01-01T00:00:00Z"},
            {"id": "worker", "agent": "codex", "runtimeUuid": REF.split(":")[1], "lastSeenAt": "2999-01-01T00:00:00Z", "spawnedBy": owner},
        ], "edges": []}
        path = self.root / "graph.json"
        follow.atomic_json(path, graph)
        config = {"graphPath": str(path)}
        selected = {}
        follow.reconcile(self.root, selected, config, owner)
        self.assertEqual(list(selected), [REF])
        self.assertEqual(selected[REF]["mode"], "observe")
        graph["edges"] = [{"from": "owner", "to": "worker", "type": "spawned-by"}]
        follow.atomic_json(path, graph)
        follow.reconcile(self.root, selected, config, owner)
        self.assertEqual(selected[REF]["mode"], "child")
        self.assertEqual(selected[REF]["parent"], owner.split(":")[1][:8])
        graph["edges"][0]["type"] = "delegates-to"
        follow.atomic_json(path, graph)
        follow.reconcile(self.root, selected, config, owner)
        self.assertEqual(selected[REF]["mode"], "steer")
        graph["edges"] = []
        follow.atomic_json(path, graph)
        follow.reconcile(self.root, selected, config, owner)
        self.assertEqual(selected[REF]["mode"], "observe")

    def test_non_hierarchical_and_reverse_edges_never_grant(self):
        owner = "claude:00000000-0000-4000-8000-000000000002"
        graph = {"nodes": [
            {"id": "owner", "agent": "claude", "runtimeUuid": owner.split(":")[1]},
            {"id": "worker", "agent": "codex", "runtimeUuid": REF.split(":")[1]},
        ]}
        for kind in ("linked", "watches", "spawned-by", "delegates-to"):
            graph["edges"] = [{"from": "worker", "to": "owner", "type": kind}]
            self.assertEqual(follow.authority(REF, {}, graph, owner), {"mode": "observe"})
        for kind in ("linked", "watches"):
            graph["edges"] = [{"from": "owner", "to": "worker", "type": kind}]
            self.assertEqual(follow.authority(REF, {}, graph, owner), {"mode": "observe"})

    def test_closed_id_is_stable_until_selection_is_saved(self):
        config = self.registry({REF: {"lastSeenAt": "2999-01-01T00:00:00Z"}})
        selected = {}
        follow.reconcile(self.root, selected, config, None)
        follow.save_selection(self.root, selected)
        self.registry({})
        first, _, _ = follow.reconcile(self.root, follow.load_selection(self.root), config, None)
        retry, _, _ = follow.reconcile(self.root, follow.load_selection(self.root), config, None)
        self.assertEqual(first[0]["event_id"], retry[0]["event_id"])

    def test_registry_delegation_and_predecessor_chain(self):
        owner = "claude:00000000-0000-4000-8000-000000000002"
        predecessor = "codex:00000000-0000-4000-8000-000000000003"
        graph = {"nodes": [
            {"id": "new", "agent": "claude", "runtimeUuid": owner.split(":")[1], "domainPredecessors": {"sample": "old"}},
            {"id": "old", "agent": "codex", "runtimeUuid": predecessor.split(":")[1]},
        ]}
        self.assertEqual(follow.authority(REF, {}, graph, owner, {"delegatedBy": [predecessor]}), {"mode": "observe"})
        graph["nodes"].append({"id": "worker", "agent": "codex", "runtimeUuid": REF.split(":")[1]})
        graph["edges"] = [{"from": "old", "to": "worker", "type": "delegates-to"}]
        self.assertEqual(follow.authority(REF, {}, graph, owner), {"mode": "steer"})
        self.assertEqual(follow.authority(REF, {}, {}, owner, {"spawnedBy": owner}), {"mode": "observe"})

    def test_missing_sources_preserve_membership_and_invalid_sources_fail_closed(self):
        selected = {REF: {**ENTRY, "addedBy": "graph"}}
        self.assertEqual(follow.reconcile(self.root, selected, {}, None)[0], [])
        self.assertIn(REF, selected)
        path = self.root / "invalid.json"
        path.write_text('{}')
        for config in ({"graphPath": str(path)}, {"registryPath": str(path)}):
            with self.assertRaises(ValueError):
                follow.reconcile(self.root, selected, config, None)
            self.assertIn(REF, selected)

    def test_coverage_reports_scope_reasons_without_mutating_selection(self):
        config = self.registry({REF: {"lastSeenAt": "2999-01-01T00:00:00Z", "domains": ["sample"]}})
        path = self.root / "config.json"
        follow.atomic_json(path, {**config, "follower": {"scope": {"excludeDomains": ["sample"]}}})
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            follow.main(["list", "--name", "coverage", "--config", str(path), "--coverage"])
        self.assertEqual(json.loads(output.getvalue())["coverage"][REF], {"selected": False, "excluded": "excluded-domain"})
        self.assertFalse((follow.state_dir("coverage") / "selection.json").exists())

    def test_rejected_discoveries_close_before_source_adoption(self):
        for added_by, item, scope, reason in (
            ("discovery", {"domains": ["excluded"]}, {"excludeDomains": ["excluded"]}, "excluded-domain"),
            ("bridge", {"surface": {"archived": True}}, {}, "archived"),
        ):
            with self.subTest(added_by=added_by):
                selected = {REF: {**ENTRY, "addedBy": added_by}}
                config = self.registry({REF: {"lastSeenAt": "2999-01-01T00:00:00Z", **item}})
                config["follower"] = {"scope": scope}
                closed, _, excluded = follow.reconcile(self.root, selected, config, None)
                self.assertEqual(selected, {})
                self.assertEqual([(event["kind"], event["body"]) for event in closed], [("CLOSED", reason)])
                self.assertIn(REF, excluded)
                self.registry({})
                _, _, excluded = follow.reconcile(self.root, selected, config, None)
                self.assertIn(REF, excluded)

    def test_legacy_projection_entries_migrate_during_locked_tick(self):
        follow.save_selection(self.root, {REF: {**ENTRY, "addedBy": "im-session-management"}})
        graph = self.root / "graph.json"
        follow.atomic_json(graph, {"nodes": [{"id": "worker", "agent": "codex", "runtimeUuid": REF.split(":")[1], "lastSeenAt": "2999-01-01T00:00:00Z"}], "edges": []})
        with patch.object(follow, "discover", return_value=([], {}, {})):
            follow.tick(self.root, {"graphPath": str(graph)}, None)
        selected = follow.load_selection(self.root)
        self.assertEqual(selected[REF]["addedBy"], "graph")
        self.assertEqual(selected[REF]["mode"], "observe")
        follow.atomic_json(graph, {"nodes": [], "edges": []})
        with patch.object(follow, "discover", return_value=([], {}, {})):
            follow.tick(self.root, {"graphPath": str(graph)}, None)
        self.assertEqual(follow.load_selection(self.root), {})
        self.assertEqual(follow.outbox(self.root)[0][0]["kind"], "CLOSED")

    def test_cli_rejects_control_modes_before_writing_selection(self):
        for mode in ("steer", "child"):
            with self.subTest(mode=mode), self.assertRaisesRegex(ValueError, "only --mode observe"):
                follow.main(["add", "--name", "modes", REF, "--mode", mode])
        self.assertFalse((follow.state_dir("modes") / "selection.json").exists())

    def test_invalid_source_keeps_following_and_recovers_next_tick(self):
        for source in ("graphPath", "registryPath"):
            with self.subTest(source=source):
                root = self.root / source
                path = self.root / "transcript.jsonl"
                path.write_text('{}\n')
                follow.save_selection(root, {REF: ENTRY})
                follow.atomic_json(follow.cursor_path(root, REF), {"path": str(path), "offset": 0, "pending": {}})
                bad = self.root / "bad.json"
                bad.write_text('{')
                config = {source: str(bad)}
                event = {"source_event_id": "still-observed", "kind": "turn_complete", "outcome": "error", "error": {"message": "Visible"}}
                stderr = io.StringIO()
                with patch.object(follow, "discover", return_value=([], {REF: path}, {})), \
                     patch.object(follow.watch, "events_for", return_value=[event]), \
                     contextlib.redirect_stderr(stderr):
                    self.assertEqual(follow.tick(root, config, None), 1)
                self.assertIn("reconciliation skipped", stderr.getvalue())
                self.assertIn(REF, follow.load_selection(root))
                self.assertEqual(follow.outbox(root)[0][0]["kind"], "ERROR")
                if source == "graphPath":
                    follow.atomic_json(bad, {"nodes": [], "edges": []})
                else:
                    follow.atomic_json(bad, {"schema": "agent-mesh.session-registry.v1", "sessions": {}})
                with patch.object(follow, "discover", return_value=([], {}, {})):
                    self.assertEqual(follow.tick(root, config, None), 0)
                self.assertEqual(follow.load_selection(root)[REF]["mode"], "observe")

    def test_saved_exclusions_replace_source_rejections_without_accumulating(self):
        config = self.registry({REF: {"lastSeenAt": "2999-01-01T00:00:00Z", "surface": {"archived": True}}})
        follow.reconcile(self.root, {}, config, None)
        self.assertEqual(follow.saved_exclusions(self.root), {REF})
        self.registry({})
        follow.reconcile(self.root, {}, config, None)
        self.assertEqual(follow.saved_exclusions(self.root), set())

    def test_degraded_real_discovery_follows_selection_without_leaking_exclusions(self):
        blocked_ref = "codex:00000000-0000-4000-8000-000000000002"
        new_ref = "codex:00000000-0000-4000-8000-000000000003"
        for source in ("graphPath", "registryPath"):
            for keep_snapshot in (True, False):
                with self.subTest(source=source, keep_snapshot=keep_snapshot):
                    fixture = self.root / source / str(keep_snapshot)
                    codex = fixture / "transcripts"
                    codex.mkdir(parents=True)
                    stamp = follow.dt.datetime.now(follow.dt.timezone.utc).isoformat()

                    def write_event(ref, payload):
                        path = codex / f"rollout-{ref.split(':')[1]}.jsonl"
                        with path.open("a") as handle:
                            handle.write(json.dumps({"type": "event_msg", "timestamp": stamp, "payload": payload}) + "\n")
                        return path

                    selected_path = write_event(REF, {"type": "user_message", "message": "Selected session"})
                    write_event(blocked_ref, {"type": "user_message", "message": "EXCLUDED_CONTENT_MARKER"})
                    graph = fixture / "graph.json"
                    nodes = [{"id": f"node-{number}", "agent": "codex", "runtimeUuid": ref.split(':')[1], "lastSeenAt": stamp, "domains": [domain]}
                             for number, (ref, domain) in enumerate(((REF, "sample"), (blocked_ref, "excluded")))]
                    follow.atomic_json(graph, {"nodes": nodes, "edges": []})
                    config = {"graphPath": str(graph), "follower": {"scope": {"excludeDomains": ["excluded"]}}}
                    if source == "registryPath":
                        registry = fixture / "registry.json"
                        follow.atomic_json(registry, {"schema": "agent-mesh.session-registry.v1", "sessions": {f"codex:{node['runtimeUuid']}": node for node in nodes}})
                        config["registryPath"] = str(registry)
                    root = fixture / "follower"
                    environment = {"CODEX_SESSION_ROOT": str(codex), "CODEX_STATE_DB": str(fixture / "absent.sqlite"), "CLAUDE_SESSION_ROOT": str(fixture / "claude"),
                                   "AGENT_MESH_LAUNCH_EVENTS": str(fixture / "launches.jsonl")}
                    # No watcher/discovery mocks: exercise real filesystem discovery,
                    # transcript parsing, cursors, outbox and restart state together.
                    with patch.dict(os.environ, environment):
                        self.assertEqual(follow.tick(root, config, None), 0)
                        self.assertEqual(set(follow.load_selection(root)), {REF})
                        self.assertEqual(follow.saved_exclusions(root), {blocked_ref})
                        prior_state = (root / "source-state.json").read_bytes()
                        prior_cache = follow.read_json(root / "discover-cache.json", {})
                        if not keep_snapshot:
                            (root / "source-state.json").unlink()
                        Path(config[source]).write_text('{')
                        write_event(REF, {"type": "task_complete", "turn_id": "selected-fresh", "last_agent_message": "Selected observation continues"})
                        write_event(blocked_ref, {"type": "task_complete", "turn_id": "blocked-fresh", "last_agent_message": "EXCLUDED_REPLY_MARKER"})
                        write_event(new_ref, {"type": "user_message", "message": "UNSELECTED_CONTENT_MARKER"})
                        output, stderr = io.StringIO(), io.StringIO()
                        with contextlib.redirect_stderr(stderr), contextlib.redirect_stdout(output):
                            self.assertEqual(follow.tick(root, config, None), 1)
                            follow.print_pending(root)
                        self.assertIn("reconciliation skipped", stderr.getvalue())
                        self.assertIn("Selected observation continues", output.getvalue())
                        self.assertEqual(set(follow.load_selection(root)), {REF})
                        rows, _ = follow.outbox(root)
                        self.assertEqual([(row["ref"], row["kind"]) for row in rows], [(REF, "REPLY")])
                        for marker in ("EXCLUDED_CONTENT_MARKER", "EXCLUDED_REPLY_MARKER", "UNSELECTED_CONTENT_MARKER"):
                            self.assertNotIn(marker, output.getvalue() + json.dumps(rows))
                        self.assertFalse(follow.cursor_path(root, blocked_ref).exists())
                        self.assertFalse(follow.cursor_path(root, new_ref).exists())
                        self.assertEqual(follow.read_json(root / "discover-cache.json", {})[blocked_ref], prior_cache[blocked_ref])
                        if keep_snapshot:
                            self.assertEqual((root / "source-state.json").read_bytes(), prior_state)
                            self.assertEqual(follow.saved_exclusions(root), {blocked_ref})
                        self.assertEqual(follow.read_json(follow.cursor_path(root, REF), {})["offset"], selected_path.stat().st_size)

    def test_null_registry_does_not_fall_back_and_close_graph_entries(self):
        follow.save_selection(self.root, {REF: {**ENTRY, "addedBy": "graph"}})
        registry = self.root / "null-registry.json"
        registry.write_text('null')
        graph = self.root / "empty-graph.json"
        follow.atomic_json(graph, {"nodes": [], "edges": []})
        stderr = io.StringIO()
        with patch.object(follow, "discover", return_value=([], {}, {})), contextlib.redirect_stderr(stderr):
            follow.tick(self.root, {"registryPath": str(registry), "graphPath": str(graph)}, None)
        self.assertIn(REF, follow.load_selection(self.root))
        self.assertEqual(follow.outbox(self.root)[0], [])
        self.assertIn("reconciliation skipped", stderr.getvalue())

    def test_malformed_predecessors_do_not_interrupt_following(self):
        owner = "claude:00000000-0000-4000-8000-000000000002"
        for predecessors in (None, [], "wrong", {"sample": []}):
            with self.subTest(predecessors=predecessors):
                graph = {"nodes": [{"id": "owner", "agent": "claude", "runtimeUuid": owner.split(":")[1], "domainPredecessors": predecessors}], "edges": []}
                self.assertEqual(follow.authority(REF, {}, graph, owner), {"mode": "observe"})

    def test_departed_history_is_capped_expires_and_does_not_accumulate_members(self):
        config = self.registry({})
        now = time.time()
        refs = [f"codex:00000000-0000-4000-8000-{number:012d}" for number in range(follow.MAX_TOMBSTONES + 10)]
        follow.atomic_json(self.root / "source-state.json", {"generation": 0, "seen": refs})
        follow.reconcile(self.root, {}, config, None)
        history = follow.read_json(self.root / "source-state.json", {})
        self.assertNotIn("seen", history)
        self.assertEqual(len(history["tombstones"]), follow.MAX_TOMBSTONES)
        _, _, excluded = follow.reconcile(self.root, {}, config, None)
        self.assertEqual(excluded, set(history["tombstones"]))
        with patch.object(follow.time, "time", return_value=now + follow.TOMBSTONE_SECONDS + 5):
            follow.reconcile(self.root, {}, config, None)
        self.assertEqual(follow.read_json(self.root / "source-state.json", {})["tombstones"], {})
        config = self.registry({REF: {"lastSeenAt": "2999-01-01T00:00:00Z"}})
        follow.reconcile(self.root, {}, config, None)
        self.assertEqual(follow.read_json(self.root / "source-state.json", {})["tombstones"], {})

    def test_bridge_self_caller_needs_edge_unknown_caller_is_observed(self):
        owner_id = "00000000-0000-4000-8000-000000000002"
        owner = f"claude:{owner_id}"
        child_id = REF.split(":")[1]
        path = self.root / "child.jsonl"
        path.write_text('{}\n')
        graph = {"nodes": [{"id": "owner", "agent": "claude", "runtimeUuid": owner_id}, {"id": "child", "agent": "codex", "runtimeUuid": child_id}], "edges": [{"from": "owner", "to": "child", "type": "spawned-by"}]}
        for caller, evidence, mode in ((owner_id, {}, "observe"), ("unknown", {}, "observe"), (owner_id, graph, "child")):
            with self.subTest(caller=caller, mode=mode), \
                 patch.object(follow.watch, "transcript_candidates", side_effect=[[(child_id, path)], []]), \
                 patch.object(follow.watch, "codex_metadata", return_value={}), \
                 patch.object(follow.watch, "bridge_parents", return_value={child_id: caller}), \
                 patch.object(follow, "created_at", return_value=time.time()), \
                 patch.object(follow, "prompt_and_origin", return_value=("Implement", False)):
                selected = {}
                found, _, _ = follow.discover(self.root, selected, {"_graph": evidence}, owner)
            self.assertEqual([event["kind"] for event in found], ["SPAWNED"])
            self.assertEqual(selected[REF]["mode"], mode)
            if mode == "child":
                self.assertEqual(selected[REF]["parent"], owner_id[:8])

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

    def test_resumed_cursor_survives_crash_after_selection_save(self):
        path = self.root / "session.jsonl"
        path.write_text(json.dumps({"id": "old", "body": "Already seen"}) + "\n")

        def discover(_root, selected, _config, _self_ref):
            if REF in selected:
                return [], {REF: path}, {REF: path.stat().st_mtime}
            selected[REF] = ENTRY
            return [{"event_id": f"discovery:{REF}:RESUMED", "ref": REF, "kind": "RESUMED", "body": "Start", "timestamp": "2026-10-08T12:00:00Z", "selection": ENTRY}], {REF: path}, {REF: path.stat().st_mtime}

        real_atomic_json = follow.atomic_json
        cp = follow.cursor_path(self.root, REF)
        cursor_writes = 0

        def crash_before_final_cursor(target, value):
            nonlocal cursor_writes
            if target == cp:
                cursor_writes += 1
                if cursor_writes == 2:
                    raise RuntimeError("interrupted before final cursor save")
            return real_atomic_json(target, value)

        with patch.object(follow, "discover", side_effect=discover), \
             patch.object(follow.watch, "events_for", side_effect=lambda _agent, record, _session_id: [{"source_event_id": record["id"], "kind": "turn_complete", "outcome": "replied", "reply": record["body"], "timestamp": "2026-10-08T12:00:00Z"}]):
            with patch.object(follow, "atomic_json", side_effect=crash_before_final_cursor):
                with self.assertRaisesRegex(RuntimeError, "interrupted"):
                    follow.tick(self.root, {}, None)
            self.assertEqual(follow.read_json(cp, {})["offset"], path.stat().st_size)
            with path.open("a") as handle:
                handle.write(json.dumps({"id": "new", "body": "Fresh reply"}) + "\n")
            self.assertEqual(follow.tick(self.root, {}, None), 1)
        rows, _ = follow.outbox(self.root)
        self.assertEqual([(row["kind"], row["body"]) for row in rows], [("RESUMED", "Start"), ("REPLY", "Fresh reply")])

    def test_selected_session_path_change_starts_at_new_file_end(self):
        old_path = self.root / "old.jsonl"
        old_path.write_text(json.dumps({"id": "old", "body": "Already seen"}) + "\n")
        new_path = self.root / "new.jsonl"
        new_path.write_text(json.dumps({"id": "history", "body": "Historical reply"}) + "\n")
        follow.save_selection(self.root, {REF: ENTRY})
        follow.atomic_json(follow.cursor_path(self.root, REF), {"path": str(old_path), "offset": old_path.stat().st_size, "pending": {}})

        with patch.object(follow, "discover", side_effect=lambda _root, _selected, _config, _self_ref: ([], {REF: new_path}, {REF: new_path.stat().st_mtime})), \
             patch.object(follow.watch, "events_for", side_effect=lambda _agent, record, _session_id: [{"source_event_id": record["id"], "kind": "turn_complete", "outcome": "replied", "reply": record["body"], "timestamp": "2026-10-08T12:00:00Z"}]):
            self.assertEqual(follow.tick(self.root, {}, None), 0)
            self.assertEqual(follow.read_json(follow.cursor_path(self.root, REF), {})["offset"], new_path.stat().st_size)
            with new_path.open("a") as handle:
                handle.write(json.dumps({"id": "new", "body": "Fresh reply"}) + "\n")
            self.assertEqual(follow.tick(self.root, {}, None), 1)
        rows, _ = follow.outbox(self.root)
        self.assertEqual([(row["kind"], row["body"]) for row in rows], [("REPLY", "Fresh reply")])

    def test_selection_cli_round_trip(self):
        with patch.dict(os.environ, {"XDG_STATE_HOME": str(self.root)}):
            self.assertEqual(follow.main(["add", "--name", "test", REF, "--label", "Worker", "--mode", "observe"]), 0)
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
