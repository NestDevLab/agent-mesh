"""Exercise the group CLI and independent connections to the canonical store."""

from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

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


if __name__ == "__main__":
    unittest.main()
