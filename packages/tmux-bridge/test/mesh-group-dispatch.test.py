import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "bin"))
from mesh_group_store import GroupActor, GroupStore
from mesh_group_dispatch import DispatchError, dispatch, native_transport


class GroupDispatchTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = GroupStore(Path(self.tmp.name) / "state")
        self.admin = GroupActor(manage=True)
        self.sender = GroupActor(session_id="codex:sender")
        self.primary, self.reserve = "claude:primary", "codex:reserve"
        self.group = self.store.create_group(self.admin, "Example")["group_id"]
        for member in (self.sender.session_id, self.primary, self.reserve):
            self.store.add_member(self.admin, self.group, member)

    def send(self, outcomes, message="hello", msgid="msg-1", destinations=None):
        calls = []
        def transport(destination, correlation, prompt):
            calls.append((destination, correlation, prompt))
            return {"outcome": outcomes[len(calls) - 1]}
        result = dispatch(self.store, self.sender, self.group, msgid, message,
                          destinations or [self.primary, self.reserve], transport)
        return result, calls

    def test_accepted_once_and_duplicate(self):
        first, calls = self.send(["accepted"])
        self.assertEqual(first["status"], "accepted")
        self.assertEqual(len(calls), 1)
        self.assertFalse(first["read_back"])
        again, calls = self.send(["accepted"])
        self.assertTrue(again["duplicate"])
        self.assertEqual(calls, [])
        self.assertEqual(len(self.store.history(self.sender, self.group)["messages"]), 1)

    def test_only_proven_unavailable_invokes_fallback(self):
        result, calls = self.send(["unavailable", "accepted"])
        self.assertEqual(result["status"], "accepted")
        self.assertEqual([c[0] for c in calls], [self.primary, self.reserve])
        self.assertNotEqual(calls[0][1], calls[1][1])

    def test_unknown_or_held_never_falls_back(self):
        for i, state in enumerate(("unknown", "held", "blocked")):
            result, calls = self.send([state], msgid=f"msg-{i + 2}")
            self.assertEqual(result["status"], state)
            self.assertEqual(len(calls), 1)
            _, repeated = self.send(["accepted"], msgid=f"msg-{i + 2}")
            self.assertEqual(repeated, [])

    def test_changed_content_or_recipients_do_not_retry(self):
        self.send(["accepted"])
        with self.assertRaises(ValueError):
            self.send(["accepted"], message="changed")
        with self.assertRaises(DispatchError):
            self.send(["accepted"], destinations=[self.reserve])

    def test_non_member_cannot_receive(self):
        with self.assertRaises(DispatchError):
            self.send(["accepted"], destinations=["codex:other"])

    def test_missing_inbox_is_blocked_not_proof_of_unavailability(self):
        receipt = '{"status":"blocked","agent":"claude","sessionId":"primary",' \
                  '"correlationId":"c1","reason":"claude_managed_inbox_missing",' \
                  '"delivery":{"attempted":false}}'
        result = SimpleNamespace(returncode=78, stdout=receipt)
        with patch("mesh_group_dispatch.subprocess.run", return_value=result):
            self.assertEqual(native_transport("claude:primary", "c1", "hi")["outcome"], "blocked")

    def test_bad_receipt_is_never_treated_as_proof(self):
        receipt = '{"status":"blocked","agent":"claude","sessionId":"other",' \
                  '"correlationId":"c1","delivery":{"attempted":false}}'
        result = SimpleNamespace(returncode=78, stdout=receipt)
        with patch("mesh_group_dispatch.subprocess.run", return_value=result):
            self.assertEqual(native_transport("claude:primary", "c1", "hi")["outcome"], "unknown")

    def test_complete_free_ownership_and_refusal_allows_fallback(self):
        receipt = '{"status":"blocked","agent":"claude","sessionId":"primary",' \
                  '"correlationId":"c1","delivery":{"attempted":false},' \
                  '"ownership":{"state":"free","writers":[],"discovery":{"complete":true}}}'
        with patch("mesh_group_dispatch.subprocess.run", return_value=SimpleNamespace(returncode=78, stdout=receipt)):
            self.assertEqual(native_transport("claude:primary", "c1", "hi")["outcome"], "unavailable")


if __name__ == "__main__":
    unittest.main()
