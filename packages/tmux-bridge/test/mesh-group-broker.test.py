import builtins
import json
import socket
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "bin"))
import mesh_group_dispatch
from mesh_group_broker import Broker, run_operation
from mesh_group_store import GroupActor, GroupStore

ACTOR = "codex:11111111-1111-4111-8111-111111111111"
OTHER = "claude:22222222-2222-4222-8222-222222222222"
OUTSIDER = "codex:33333333-3333-4333-8333-333333333333"


class GroupBrokerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.store = GroupStore(self.root / "state")
        admin = GroupActor(manage=True)
        self.group = self.store.create_group(admin, "Example")["group_id"]
        for member in (ACTOR, OTHER):
            self.store.add_member(admin, self.group, member)

    def test_membership_and_idempotent_append(self):
        request = {"action": "append", "actor": ACTOR, "group": self.group,
                   "message_id": "one", "message": "hello"}
        self.assertFalse(run_operation(self.store, request)["duplicate"])
        self.assertTrue(run_operation(self.store, request)["duplicate"])
        with self.assertRaises(ValueError):
            run_operation(self.store, {**request, "actor": OUTSIDER})
        with self.assertRaises(ValueError):
            run_operation(self.store, {**request, "extra": True})
        history = run_operation(self.store, {"action": "history", "actor": OTHER, "group": self.group,
                                            "after": 0, "limit": 10})
        self.assertEqual([m["message"] for m in history["messages"]], ["hello"])

    def test_cloud_actor_requires_an_open_registration(self):
        cloud = "claude-cloud:example:session_Abc123"
        self.store.add_member(GroupActor(manage=True), self.group, cloud)
        with patch("mesh_group_broker.cloud_is_registered", return_value=False):
            with self.assertRaisesRegex(ValueError, "not registered"):
                run_operation(self.store, {"action": "list", "actor": cloud})

    def test_send_forwards_only_group_member_actor(self):
        request = {"action": "send", "actor": ACTOR, "group": self.group, "message_id": "two",
                   "message": "work", "destinations": [OTHER]}
        with patch("mesh_group_broker.dispatch", return_value={"status": "accepted"}) as send:
            self.assertEqual(run_operation(self.store, request), {"status": "accepted"})
            self.assertEqual(send.call_args.args[1].session_id, ACTOR)
        with self.assertRaises(ValueError):
            run_operation(self.store, {**request, "destinations": []})
        with self.assertRaises(ValueError):
            run_operation(self.store, {**request, "actor": OUTSIDER})

    def test_local_delivery_does_not_require_cloud_binding(self):
        request = {"action": "send", "actor": ACTOR, "group": self.group, "message_id": "cloud",
                   "message": "work", "destinations": [OTHER]}
        # The gateway can be installed before the optional cloud transport.
        real_import = builtins.__import__
        def without_cloud(name, *args, **kwargs):
            if name == "mesh_group_dispatch" and len(args) > 2 and "load_cloud_bindings" in (args[2] or ()):
                raise ImportError("optional dependency missing")
            return real_import(name, *args, **kwargs)
        with patch("mesh_group_dispatch.native_transport", return_value={"outcome": "accepted"}) as send, \
             patch("builtins.__import__", side_effect=without_cloud):
            result = run_operation(self.store, request, cloud_bindings_path=self.root / "bindings")
        self.assertEqual(result["status"], "accepted")
        send.assert_called_once()

    def test_cloud_bindings_are_refreshed_and_passed_to_transport(self):
        cloud = "claude-cloud:example:session_Abc123"
        request = {"action": "send", "actor": ACTOR, "group": self.group, "message_id": "cloud-one",
                   "message": "work", "destinations": [cloud]}
        bindings = [{"example": {"orgId": "one"}}, {"example": {"orgId": "two"}}]
        def invoke_transport(*args):
            return {"status": args[-1](cloud, "correlation", "message")["outcome"]}
        with patch("mesh_group_dispatch.load_cloud_bindings", side_effect=bindings, create=True) as load, \
             patch("mesh_group_dispatch.native_transport", return_value={"outcome": "accepted"}) as send, \
             patch("mesh_group_broker.dispatch", side_effect=invoke_transport):
            first = run_operation(self.store, request, cloud_bindings_path=self.root / "bindings")
            second = run_operation(self.store, {**request, "message_id": "cloud-two"},
                                   cloud_bindings_path=self.root / "bindings")
        self.assertEqual([first["status"], second["status"]], ["accepted", "accepted"])
        self.assertEqual(load.call_count, 2)
        self.assertEqual(send.call_args_list[0].kwargs["cloud_bindings"], bindings[0])
        self.assertEqual(send.call_args_list[1].kwargs["cloud_bindings"], bindings[1])

    @unittest.skipUnless(hasattr(mesh_group_dispatch, "load_cloud_bindings"), "optional cloud transport not present")
    def test_cloud_destination_with_installed_transport(self):
        cloud = "claude-cloud:example:session_Abc123"
        self.store.add_member(GroupActor(manage=True), self.group, cloud)
        binding_path = self.root / "bindings.json"
        binding_path.write_text('{"example": {"email": "example", "orgId": "org"}}')
        binding_path.chmod(0o600)
        request = {"action": "send", "actor": ACTOR, "group": self.group,
                   "message_id": "cloud-real-adapter", "message": "work", "destinations": [cloud]}
        def fake_native(args, **_kwargs):
            self.assertIn("--cloud", args)
            correlation = args[args.index("--correlation-id") + 1]
            return SimpleNamespace(returncode=0, stdout=json.dumps({
                "status": "queued", "agent": "claude", "sessionId": "session_Abc123",
                "correlationId": correlation,
            }))
        with patch("mesh_group_dispatch._cloud_authorized", return_value=True), \
             patch("mesh_group_dispatch.subprocess.run", side_effect=fake_native) as run:
            result = run_operation(self.store, request, cloud_bindings_path=binding_path)
        self.assertEqual(result["status"], "accepted")
        self.assertFalse(result["read_back"])
        self.assertEqual(run.call_count, 1)

    @unittest.skipUnless(hasattr(mesh_group_dispatch, "load_cloud_bindings"), "optional cloud transport not present")
    def test_missing_cloud_binding_blocks_without_fallback(self):
        cloud = "claude-cloud:example:session_Abc123"
        self.store.add_member(GroupActor(manage=True), self.group, cloud)
        request = {"action": "send", "actor": ACTOR, "group": self.group,
                   "message_id": "cloud-missing", "message": "work", "destinations": [cloud, OTHER]}
        with patch("mesh_group_dispatch.native_transport") as send:
            result = run_operation(self.store, request, cloud_bindings_path=self.root / "missing")
        self.assertEqual(result["status"], "blocked")
        send.assert_not_called()

    def test_private_socket_round_trip_and_cleanup(self):
        path = self.root / "broker.sock"
        broker = Broker(path, self.root / "state")
        thread = threading.Thread(target=broker.serve_forever, daemon=True)
        thread.start()
        try:
            with self.assertRaises(OSError):
                Broker(path, self.root / "state")
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                client.connect(str(path))
                client.sendall((json.dumps({"action": "list", "actor": ACTOR}) + "\n").encode())
                with client.makefile("rb") as stream:
                    result = json.loads(stream.readline())
            self.assertTrue(result["ok"])
            self.assertEqual(result["result"]["groups"][0]["group_id"], self.group)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        finally:
            broker.shutdown()
            broker.server_close()
            thread.join(timeout=5)
        self.assertFalse(path.exists())

    def test_shutdown_waits_for_admitted_request(self):
        path = self.root / "drain.sock"
        broker = Broker(path, self.root / "state")
        server_thread = threading.Thread(target=broker.serve_forever, daemon=True)
        server_thread.start()
        entered, release, closed = threading.Event(), threading.Event(), threading.Event()
        def slow_operation(*_args, **_kwargs):
            entered.set()
            if not release.wait(5):
                raise ValueError("test timed out")
            return {"groups": []}
        with patch("mesh_group_broker.run_operation", side_effect=slow_operation):
            try:
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                    client.connect(str(path))
                    client.sendall((json.dumps({"action": "list", "actor": ACTOR}) + "\n").encode())
                    self.assertTrue(entered.wait(5))
                    broker.shutdown()
                    def close():
                        broker.server_close()
                        closed.set()
                    closer = threading.Thread(target=close, daemon=True)
                    closer.start()
                    self.assertFalse(closed.wait(0.1))
                    release.set()
                    self.assertTrue(closed.wait(5))
                    closer.join(timeout=5)
            finally:
                release.set()
                broker.shutdown()
                broker.server_close()
                server_thread.join(timeout=5)
        self.assertFalse(path.exists())


if __name__ == "__main__":
    unittest.main()
