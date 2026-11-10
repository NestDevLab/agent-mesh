"""Exercise the group CLI and independent connections to the canonical store."""

from concurrent.futures import ThreadPoolExecutor
import fcntl
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
from threading import Event, get_ident
import unittest
from unittest.mock import patch

BIN = Path(__file__).resolve().parents[1] / "bin"
sys.dont_write_bytecode = True
sys.path.insert(0, str(BIN))
from mesh_group_store import GroupAccessError, GroupActor, GroupConflictError, GroupStore


class MeshGroupsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = Path(self.tmp.name) / "groups"
        self.store = GroupStore(self.state)
        self.admin = GroupActor(manage=True)
        self.first = GroupActor(session_id="runtime-a:session-1")
        self.second = GroupActor(session_id="runtime-b:session-2")

    def cli(self, *args, message=None, success=True):
        result = subprocess.run([sys.executable, str(BIN / "agent-mesh"), "group", *args, "--json"],
                                input=message, text=True, capture_output=True, timeout=10,
                                env={**os.environ, "MESH_GROUPS_STATE": str(self.state)})
        if success:
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(result.stdout, "")
        return result.stderr

    def test_cli_uses_a_persistent_store_and_current_membership(self):
        self.assertEqual(self.cli("list"), {"groups": []})
        self.assertFalse(self.state.exists())
        created = self.cli("create", "Release planning", "--role", "release:coordinator")
        group = created["group_id"]
        self.assertIn("already assigned", self.cli("create", "Competing role", "--role",
                                                  "release:coordinator", success=False))
        other = self.cli("create", "Release planning")["group_id"]
        self.assertNotEqual(group, other)
        self.assertTrue(self.cli("add", group, self.first.session_id)["changed"])
        self.assertFalse(self.cli("add", group, self.first.session_id)["changed"])
        self.assertEqual(self.cli("get", group)["role_key"], "release:coordinator")
        self.assertEqual([g["group_id"] for g in self.cli("list", "--as-session", self.first.session_id)["groups"]], [group])
        self.assertIn("not available", self.cli("history", group, success=False))
        self.assertIn("not available", self.cli("get", other, "--as-session", self.first.session_id, success=False))
        self.assertIn("not authorized", self.cli("add", group, self.second.session_id,
                                                 "--as-session", self.first.session_id, success=False))
        text = "Planning has started.\nCheck the shared notes."
        appended = self.cli("append", group, "--as-session", self.first.session_id, "--message-id", "planning-note", message=text)
        self.assertFalse(appended["duplicate"])
        self.assertEqual(appended["message"]["message"], text)
        self.assertEqual(appended["message"]["author_session_id"], self.first.session_id)
        self.cli("add", group, self.second.session_id)
        self.cli("remove", group, self.first.session_id)
        self.assertIn("not available", self.cli("history", group, "--as-session", self.first.session_id, success=False))
        self.assertIn("not available", self.cli("append", group, "--as-session", self.first.session_id, message="stale", success=False))
        self.assertEqual(self.cli("history", group, "--as-session", self.second.session_id)["messages"], [appended["message"]])
        self.assertEqual(self.store.get_group(self.admin, group)["role_key"], "release:coordinator")
        self.assertEqual(self.state.stat().st_mode & 0o777, 0o700)
        self.assertEqual(self.store.path.stat().st_mode & 0o777, 0o600)

    def test_one_lead_per_ref_and_transfer_checks_the_current_group(self):
        first, second, third = (self.store.create_group(self.admin, name)["group_id"] for name in ("One", "Two", "Three"))
        self.store.add_member(self.admin, first, self.first.session_id)
        self.assertTrue(self.cli("link", first, "tracker:release", "--lead")["lead"])
        self.assertFalse(self.cli("link", second, "tracker:release")["lead"])
        self.assertFalse(self.cli("link", third, "tracker:release")["lead"])
        self.assertTrue(self.cli("link", first, "tracker:handoff", "--lead")["lead"])
        self.assertFalse(self.cli("link", first, "tracker:release")["changed"])
        self.assertIn("already has a lead", self.cli("link", second, "tracker:release", "--lead", success=False))
        self.assertIn("clear or transfer", self.cli("unlink", first, "tracker:release", success=False))
        self.assertEqual(len(self.cli("list", "--ledger-ref", "tracker:release")["groups"]), 3)
        self.assertEqual(len(self.cli("list", "--ledger-ref", "tracker:release", "--as-session", self.first.session_id)["groups"]), 1)
        self.assertTrue(self.cli("remove", first, self.first.session_id)["changed"])
        self.assertTrue(self.cli("get", first)["ledger_links"][1]["lead"])

        def transfer(target):
            try:
                return GroupStore(self.state).transfer_ledger_lead(self.admin, "tracker:release", from_group_id=first, to_group_id=target)
            except GroupConflictError as exc:
                return str(exc)

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(transfer, (second, third)))
        winners = [result["group_id"] for result in results if isinstance(result, dict)]
        self.assertEqual(len(winners), 1)
        self.assertIn("expected ledger lead is no longer current", results)
        groups = self.store.list_groups(self.admin, ledger_ref="tracker:release")
        self.assertEqual([g["group_id"] for g in groups if {"ref": "tracker:release", "lead": True} in g["ledger_links"]], winners)
        self.assertTrue(self.cli("link", winners[0], "tracker:release", "--clear-lead")["changed"])
        self.assertTrue(self.cli("unlink", winners[0], "tracker:release")["changed"])
        self.assertEqual(len(self.store.list_groups(self.admin, ledger_ref="tracker:release")), 2)

    def test_concurrent_history_append_is_ordered_and_retry_safe(self):
        group = self.store.create_group(self.admin, "Conversation")["group_id"]
        for actor in (self.first, self.second):
            self.store.add_member(self.admin, group, actor.session_id)

        def append(message_id):
            return self.cli("append", group, "--as-session", self.first.session_id,
                            "--message-id", message_id, message=f"Message {message_id}")

        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(append, ["retry"] * 6 + ["separate-a", "separate-b"]))
        self.assertEqual(sum(not result["duplicate"] for result in results), 3)
        self.assertTrue(all(result["message"] == results[0]["message"] for result in results[:6]))
        with self.assertRaises(GroupConflictError):
            self.store.append_message(self.second, group, "Message retry", message_id="retry")
        with self.assertRaises(GroupConflictError):
            self.store.append_message(self.first, group, "Changed payload", message_id="retry")
        page = self.store.history(self.second, group, limit=2)
        self.assertTrue(page["has_more"])
        self.assertEqual([msg["seq"] for msg in page["messages"]], [1, 2])
        rest = self.store.history(self.second, group, after=page["next_after"])
        self.assertFalse(rest["has_more"])
        self.assertEqual([msg["seq"] for msg in rest["messages"]], [3])
        with self.assertRaises(GroupAccessError):
            self.store.history(self.admin, group)

    def test_private_state_rejects_symlink_and_untrusted_permissions(self):
        outside = Path(self.tmp.name) / "outside"
        outside.mkdir(mode=0o700)
        self.state.symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "private and owned"):
            self.store.create_group(self.admin, "Group")
        self.assertEqual(list(outside.iterdir()), [])
        self.state.unlink()
        self.state.mkdir(mode=0o700)
        self.state.chmod(0o755)
        with self.assertRaisesRegex(ValueError, "private and owned"):
            self.store.list_groups(self.admin)

    def test_group_creation_cannot_drop_another_connection_write_lock(self):
        self.store.create_group(self.admin, "Initial")
        ready, resume = Event(), Event()
        connect = sqlite3.connect

        def pause_before_connect(*args, **kwargs):
            ready.set()
            if not resume.wait(10):
                raise TimeoutError("group creator was not resumed")
            return connect(*args, **kwargs)

        with ThreadPoolExecutor(max_workers=1) as pool:
            with self.store._transaction(write=True):
                with patch.object(sqlite3, "connect", side_effect=pause_before_connect):
                    future = pool.submit(GroupStore(self.state).create_group, self.admin, "Next")
                    try:
                        self.assertTrue(ready.wait(5), "creator did not reach SQLite connection")
                        # A process outside this interpreter observes the actual
                        # kernel lock, independent of SQLite's process bookkeeping.
                        probe = subprocess.run([sys.executable, "-c", """
import sqlite3, sys
with sqlite3.connect(sys.argv[1], timeout=0, isolation_level=None) as db:
    try:
        db.execute('BEGIN IMMEDIATE')
    except sqlite3.OperationalError as exc:
        if str(exc) != 'database is locked':
            raise
        print('busy')
    else:
        print('acquired')
""", str(self.store.path)], check=True, capture_output=True, text=True, timeout=5)
                        self.assertEqual(probe.stdout.strip(), "busy")
                    finally:
                        resume.set()
            self.assertEqual(future.result(timeout=5)["name"], "Next")

    def test_bootstrap_keeps_other_connections_out_until_creation_descriptor_closes(self):
        opened, resume, waiting, connected = Event(), Event(), Event(), Event()
        first = {}
        open_file, close_file, flock, connect = os.open, os.close, fcntl.flock, sqlite3.connect

        def observe_creation(path, flags, *args, **kwargs):
            fd = open_file(path, flags, *args, **kwargs)
            if path == self.store.path.name and flags & os.O_CREAT:
                first.update(fd=fd, thread=get_ident())
            return fd

        def pause_before_close(fd):
            if fd == first.get("fd") and not opened.is_set():
                opened.set()
                if not resume.wait(10):
                    close_file(fd)
                    raise TimeoutError("initial descriptor was not released")
            close_file(fd)

        def observe_lock(*args):
            if opened.is_set() and get_ident() != first["thread"]:
                waiting.set()
            return flock(*args)

        def observe_connect(*args, **kwargs):
            if get_ident() != first["thread"]:
                connected.set()
            return connect(*args, **kwargs)

        with ThreadPoolExecutor(max_workers=2) as pool, \
                patch.object(os, "open", side_effect=observe_creation), \
                patch.object(os, "close", side_effect=pause_before_close), \
                patch.object(fcntl, "flock", side_effect=observe_lock), \
                patch.object(sqlite3, "connect", side_effect=observe_connect):
            initial = pool.submit(self.store.create_group, self.admin, "Initial")
            try:
                self.assertTrue(opened.wait(5), "initial descriptor was not opened")
                second = pool.submit(GroupStore(self.state).create_group, self.admin, "Concurrent")
                self.assertTrue(waiting.wait(5), "second creator did not reach the bootstrap lock")
                self.assertFalse(connected.wait(0.2), "second creator reached SQLite before the raw descriptor closed")
            finally:
                resume.set()
            self.assertEqual(initial.result(timeout=5)["name"], "Initial")
            self.assertEqual(second.result(timeout=5)["name"], "Concurrent")
        self.assertEqual({group["name"] for group in self.store.list_groups(self.admin)}, {"Initial", "Concurrent"})

    @staticmethod
    def graph_snapshot():
        first = "codex:deadc0de-a1b2-4433-8b5c-baddfacecafe"
        second = "claude:feedcafe-c2d3-4312-a2e9-deadbeefcafe"

        def link(ref, role, session, until=None, evidence=()):
            return {"ref": ref, "role": role, "session": session, "until": until, "evidence": list(evidence)}

        return {"schema": "agent-mesh.session-graph.v1", "migrated": True, "links": [
            link("group:release-director", "discusses", first, evidence=("area:release",)),
            link("group:release-director", "discusses", second),
            link("area:release", "owns", first, evidence=("group:release-director",)),
            link("area:release", "owns", second, evidence=("group:release-director",)),
            link("area:release-director", "owns", second),
            link("group:handoff", "discusses", second),
            link("group:handoff", "discusses", first, "2026-01-01T00:00:00Z"),
            link("tracker:unrelated", "works-on", first),
        ]}

    def test_graph_import_is_explicit_stable_and_preserves_original_graph(self):
        snapshot = self.graph_snapshot()
        path = Path(self.tmp.name) / "snapshot.json"
        role_map = Path(self.tmp.name) / "roles.json"
        bindings = {"group:release-director": "release:director"}
        role_map.write_text(json.dumps(bindings))
        original = json.dumps(snapshot).encode()
        path.write_bytes(original)
        args = ("import-graph", "--snapshot", str(path), "--source", "legacy", "--role-map", str(role_map))
        preview = self.cli(*args)
        self.assertEqual(preview["status"], "ready")
        self.assertFalse(self.state.exists())
        digest = preview["plan_digest"]
        reverse = {**snapshot, "links": list(reversed(snapshot["links"]))}
        self.assertEqual(self.store.import_graph(self.admin, reverse, "legacy", role_bindings=bindings)["plan_digest"], digest)
        self.assertIn("does not match", self.cli(*args, "--apply", "--plan-digest", "wrong", success=False))
        self.assertFalse(self.state.exists())
        self.assertEqual(self.cli(*args, "--apply", "--plan-digest", digest)["status"], "imported")
        release = self.cli("list", "--source-ref", "group:release-director")["groups"][0]
        proposed = next(group for group in preview["groups"] if group["source_ref"] == "group:release-director")
        self.assertEqual(release["group_id"], proposed["group_id"])
        self.assertEqual(release["ledger_links"], [{"ref": "area:release", "lead": True}])
        self.assertEqual(len(proposed["area_owners"]["area:release"]), 2)
        self.assertEqual(release["role_key"], "release:director")
        self.assertEqual(self.cli("list", "--ledger-ref", "tracker:unrelated")["groups"], [])
        self.cli("remove", release["group_id"], release["members"][0]["session_id"])
        self.assertEqual(self.cli(*args, "--apply", "--plan-digest", digest)["status"], "already_imported")
        reread = self.cli("get", release["group_id"])
        self.assertEqual(len(reread["members"]), 1)
        self.assertEqual(reread["role_key"], "release:director")
        self.assertEqual(path.read_bytes(), original)

    def test_graph_import_rejects_ambiguity_and_rolls_back_on_late_failure(self):
        snapshot = self.graph_snapshot()
        ambiguous = {**snapshot, "links": [*snapshot["links"],
                     {"ref": "group:release-director", "role": "discusses", "session": "pending:unresolved", "until": None}]}
        self.assertEqual(self.store.import_graph(self.admin, ambiguous, "legacy")["status"], "conflict")
        current = self.store.create_group(self.admin, "Current")
        self.store.link_ledger(self.admin, current["group_id"], "area:release", lead=True)
        blocked = self.store.import_graph(self.admin, snapshot, "legacy")
        self.assertEqual(blocked["destination_conflicts"], ["ledger reference area:release already has a lead"])
        with self.assertRaises(GroupConflictError):
            self.store.import_graph(self.admin, snapshot, "legacy", expected_digest=blocked["plan_digest"])
        self.store.link_ledger(self.admin, current["group_id"], "area:release", lead=False)

        connect = self.store._connect

        def deny_receipt(**kwargs):
            db = connect(**kwargs)
            db.set_authorizer(lambda action, table, *_: sqlite3.SQLITE_DENY
                              if action == sqlite3.SQLITE_INSERT and table == "graph_imports" else sqlite3.SQLITE_OK)
            return db

        with patch.object(self.store, "_connect", side_effect=deny_receipt), self.assertRaises(sqlite3.DatabaseError):
            self.store.import_graph(self.admin, snapshot, "legacy", expected_digest=blocked["plan_digest"])
        self.assertEqual([row["name"] for row in self.store.list_groups(self.admin)], ["Current"])
        self.assertEqual(self.store.import_graph(self.admin, snapshot, "legacy",
                                               expected_digest=blocked["plan_digest"])["status"], "imported")

    def test_graph_import_rejects_nonreciprocal_evidence_and_competing_roles(self):
        snapshot = self.graph_snapshot()
        one_way = {**snapshot, "links": [{**link, "evidence": []} if link["ref"] == "area:release" else link
                                        for link in snapshot["links"]]}
        invalid = self.store.import_graph(self.admin, one_way, "legacy")
        self.assertEqual(invalid["status"], "conflict")
        self.assertIn("nonreciprocal group/area evidence: group:release-director and area:release", invalid["conflicts"])

        competing = {**snapshot, "links": [
            {**link, "evidence": [*link["evidence"], "group:handoff"]} if link["ref"] == "area:release" else
            {**link, "evidence": ["area:release"]} if link["ref"] == "group:handoff" else link
            for link in snapshot["links"]
        ]}
        invalid = self.store.import_graph(self.admin, competing, "legacy")
        self.assertEqual(invalid["status"], "conflict")
        self.assertTrue(any("more than one group" in conflict for conflict in invalid["conflicts"]))
        invalid = self.store.import_graph(self.admin, snapshot, "legacy", role_bindings={
            "group:release-director": "release:director", "group:handoff": "release:director"})
        self.assertEqual(invalid["status"], "conflict")
        self.assertTrue(any("bound to more than one group" in conflict for conflict in invalid["conflicts"]))
        self.assertFalse(self.state.exists())

        self.store.create_group(self.admin, "Existing", role_key="release:director")
        invalid = self.store.import_graph(self.admin, snapshot, "legacy",
                                          role_bindings={"group:release-director": "release:director"})
        self.assertEqual(invalid["destination_conflicts"], ["role release:director already belongs to a group"])


if __name__ == "__main__":
    unittest.main()
