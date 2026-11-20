import sys
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "bin"))
from mesh_group_store import GroupActor, GroupStore
from mesh_group_dispatch import DispatchError, dispatch, load_cloud_bindings, native_transport


class GroupDispatchTest(unittest.TestCase):
    def test_binding_file_is_private_and_read_fresh(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bindings.json"
            path.write_text('{"scope": {"orgId": "one"}}')
            path.chmod(0o600)
            self.assertEqual(load_cloud_bindings(path)["scope"]["orgId"], "one")
            path.write_text('{"scope": {"orgId": "two"}}')
            self.assertEqual(load_cloud_bindings(path)["scope"]["orgId"], "two")
            path.chmod(0o644)
            with self.assertRaises(ValueError):
                load_cloud_bindings(path)
            link = Path(tmp) / "link"
            link.symlink_to(path)
            with self.assertRaises(OSError):
                load_cloud_bindings(link)
            fifo = Path(tmp) / "pipe"
            os.mkfifo(fifo, 0o600)
            with self.assertRaises(ValueError):
                load_cloud_bindings(fifo)

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = GroupStore(Path(self.tmp.name) / "state")
        self.admin = GroupActor(manage=True)
        self.sender = GroupActor(session_id="codex:11111111-1111-4111-8111-111111111111")
        self.primary, self.reserve = "claude:22222222-2222-4222-8222-222222222222", "codex:33333333-3333-4333-8333-333333333333"
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
        receipt = '{"status":"blocked","agent":"claude","sessionId":"22222222-2222-4222-8222-222222222222",' \
                  '"correlationId":"c1","reason":"claude_managed_inbox_missing",' \
                  '"delivery":{"attempted":false}}'
        result = SimpleNamespace(returncode=78, stdout=receipt)
        with patch("mesh_group_dispatch.subprocess.run", return_value=result):
            self.assertEqual(native_transport("claude:22222222-2222-4222-8222-222222222222", "c1", "hi")["outcome"], "blocked")

    def test_bad_receipt_is_never_treated_as_proof(self):
        receipt = '{"status":"blocked","agent":"claude","sessionId":"other",' \
                  '"correlationId":"c1","delivery":{"attempted":false}}'
        result = SimpleNamespace(returncode=78, stdout=receipt)
        with patch("mesh_group_dispatch.subprocess.run", return_value=result):
            self.assertEqual(native_transport("claude:22222222-2222-4222-8222-222222222222", "c1", "hi")["outcome"], "unknown")

    def test_complete_free_ownership_and_refusal_allows_fallback(self):
        receipt = '{"status":"blocked","agent":"claude","sessionId":"22222222-2222-4222-8222-222222222222",' \
                  '"correlationId":"c1","delivery":{"attempted":false},' \
                  '"ownership":{"state":"free","writers":[],"discovery":{"complete":true}}}'
        with patch("mesh_group_dispatch.subprocess.run", return_value=SimpleNamespace(returncode=78, stdout=receipt)):
            self.assertEqual(native_transport("claude:22222222-2222-4222-8222-222222222222", "c1", "hi")["outcome"], "unavailable")

    def test_codex_absence_requires_exact_complete_pre_delivery_receipt(self):
        session = "codex:33333333-3333-4333-8333-333333333333"
        receipt = {"status": "blocked", "agent": "codex", "sessionId": session[6:],
                   "correlationId": "c1", "reason": "codex_local_transcript_absent",
                   "delivery": {"attempted": False},
                   "discovery": {"scope": "codex-local-transcripts", "complete": True}}
        def classify(data, code=78):
            with patch("mesh_group_dispatch.subprocess.run", return_value=SimpleNamespace(returncode=code, stdout=json.dumps(data))):
                return native_transport(session, "c1", "synthetic")["outcome"]
        self.assertEqual(classify(receipt), "unavailable")
        for changed in ({"discovery": {"scope": "codex-local-transcripts", "complete": False}},
                        {"discovery": {"scope": "other", "complete": True}},
                        {"reason": "other"}, {"delivery": {"attempted": True}},
                        {"sessionId": "other"}, {"correlationId": "other"}):
            self.assertNotEqual(classify({**receipt, **changed}), "unavailable")
        self.assertNotEqual(classify(receipt, 0), "unavailable")

    def test_real_local_preflight_can_fall_back_without_sending_to_codex(self):
        sessions = Path(self.tmp.name) / "sessions"
        sessions.mkdir()
        calls = []
        def transport(destination, correlation, prompt):
            calls.append(destination)
            if destination == self.reserve:
                return native_transport(destination, correlation, prompt)
            return {"outcome": "accepted", "synthetic": True}
        environment = {**os.environ, "HOME": self.tmp.name, "CODEX_HOME": str(Path(self.tmp.name) / "codex"),
                       "CODEX_SESSION_ROOT": str(sessions), "MESH_COMMS_STATE": str(Path(self.tmp.name) / "comms")}
        environment.pop("MESH_COMMS_REPLAY_FD", None)
        with patch.dict(os.environ, environment, clear=True):
            result = dispatch(self.store, self.sender, self.group, "codex-absent", "synthetic",
                              [self.reserve, self.primary], transport)
        self.assertEqual(result["status"], "accepted")
        self.assertEqual(calls, [self.reserve, self.primary])
        self.assertFalse(result["read_back"])

    def test_removed_fallback_is_not_sent_to(self):
        calls = []
        def transport(destination, correlation, prompt):
            calls.append(destination)
            self.store.remove_member(self.admin, self.group, self.reserve)
            return {"outcome": "unavailable"}
        result = dispatch(self.store, self.sender, self.group, "remove-test", "hello",
                          [self.primary, self.reserve], transport)
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(calls, [self.primary])

    def test_intent_precedes_history_and_binds_destinations(self):
        with patch.object(self.store, "append_message", side_effect=RuntimeError("crash")):
            with self.assertRaises(RuntimeError):
                self.send(["accepted"], msgid="crash-test")
        with self.assertRaises(DispatchError):
            self.send(["accepted"], msgid="crash-test", destinations=[self.reserve])
        result, calls = self.send(["accepted"], msgid="crash-test")
        self.assertEqual(result["status"], "unknown")
        self.assertEqual(calls, [])

    def test_preexisting_message_is_not_sent_without_intent(self):
        self.store.append_message(self.sender, self.group, "hello", message_id="existing")
        with self.assertRaises(DispatchError):
            self.send(["accepted"], msgid="existing")

    def test_invalid_message_does_not_reserve_its_id(self):
        with self.assertRaises(DispatchError):
            self.send(["accepted"], message=" ", msgid="validation")
        result, calls = self.send(["accepted"], msgid="validation")
        self.assertEqual(result["status"], "accepted")
        self.assertEqual(len(calls), 1)

    def test_malformed_nested_receipt_is_unknown(self):
        receipt = '{"status":"blocked","agent":"claude","sessionId":"22222222-2222-4222-8222-222222222222",' \
                  '"correlationId":"c1","delivery":[]}'
        with patch("mesh_group_dispatch.subprocess.run", return_value=SimpleNamespace(returncode=78, stdout=receipt)):
            self.assertEqual(native_transport("claude:22222222-2222-4222-8222-222222222222", "c1", "hi")["outcome"], "unknown")

    def test_invalid_destination_does_not_reserve_message_id(self):
        self.store.add_member(self.admin, self.group, "codex:not-a-uuid")
        with self.assertRaises(DispatchError):
            self.send(["accepted"], msgid="bad-target", destinations=["codex:not-a-uuid"])
        result, _ = self.send(["accepted"], msgid="bad-target")
        self.assertEqual(result["status"], "accepted")

    def test_manager_who_is_not_a_member_cannot_reserve(self):
        outsider = GroupActor(session_id="codex:44444444-4444-4444-8444-444444444444", manage=True)
        with self.assertRaises(DispatchError):
            dispatch(self.store, outsider, self.group, "outsider", "hello", [self.primary], lambda *x: None)
        result, _ = self.send(["accepted"], msgid="outsider")
        self.assertEqual(result["status"], "accepted")

    def test_invalid_unicode_does_not_reserve_id(self):
        with self.assertRaises(DispatchError):
            self.send(["accepted"], message="\ud800", msgid="invalid-unicode")
        result, _ = self.send(["accepted"], msgid="invalid-unicode")
        self.assertEqual(result["status"], "accepted")

    def test_cloud_delivery_requires_registered_session_and_bound_account(self):
        cloud = "claude-cloud:work:session_Abc123"
        self.store.add_member(self.admin, self.group, cloud)
        bindings = {"work": {"email": "example@example.invalid", "orgId": "example-org"}}
        graph = SimpleNamespace(returncode=0, stdout=json.dumps({"sessionId": cloud}))
        account = SimpleNamespace(returncode=0, stdout=json.dumps({"loggedIn": True, **bindings["work"]}))
        accepted = SimpleNamespace(returncode=0, stdout=json.dumps({
            "status": "queued", "agent": "claude", "sessionId": "session_Abc123", "correlationId": "c1"}))
        with patch("mesh_group_dispatch.subprocess.run", side_effect=[graph, account, accepted]) as run:
            outcome = native_transport(cloud, "c1", "hello", cloud_bindings=bindings)
        self.assertEqual(outcome["outcome"], "accepted")
        self.assertIn("--cloud", run.call_args_list[2].args[0])
        with patch("mesh_group_dispatch.subprocess.run", side_effect=[graph, account]) as run:
            outcome = native_transport(cloud, "c1", "hello", cloud_bindings={"work": {
                "email": "another@example.invalid", "orgId": "example-org"}})
        self.assertEqual(outcome["outcome"], "blocked")
        self.assertEqual(run.call_count, 2)
        with patch("mesh_group_dispatch.subprocess.run") as run:
            self.assertEqual(native_transport(cloud, "c1", "hello")["outcome"], "blocked")
        run.assert_not_called()
        absent = SimpleNamespace(returncode=1, stdout="{}")
        with patch("mesh_group_dispatch.subprocess.run", return_value=absent) as run:
            self.assertEqual(native_transport(cloud, "c1", "hello", cloud_bindings=bindings)["outcome"], "blocked")
        self.assertEqual(run.call_count, 1)

    def test_cloud_unverified_or_uncertain_never_causes_fallback(self):
        cloud = "claude-cloud:work:session_Abc123"
        self.store.add_member(self.admin, self.group, cloud)
        calls = []
        def transport(destination, correlation, prompt):
            calls.append(destination)
            return {"outcome": "unknown"}
        result = dispatch(self.store, self.sender, self.group, "cloud-unknown", "hello",
                          [cloud, self.reserve], transport)
        self.assertEqual(result["status"], "unknown")
        self.assertEqual(calls, [cloud])


if __name__ == "__main__":
    unittest.main()
