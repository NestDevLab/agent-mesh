#!/usr/bin/env python3
"""Host-side private Unix socket broker for authenticated group conversations."""
import argparse
import json
import os
import re
from pathlib import Path
import socket
import socketserver
import signal
import stat
import struct
import subprocess
import sys

sys.dont_write_bytecode = True
from mesh_group_dispatch import dispatch
from mesh_group_store import GroupActor, GroupStore
from ledger_item_lock import LeaseError, operation as lock_operation

MAX_REQUEST = 131072


def cloud_is_registered(session):
    if not session.startswith("claude-cloud:"):
        return not session.startswith("codex-cloud:")
    try:
        result = subprocess.run(["node", str(Path(__file__).with_name("mesh-graph.mjs")),
                                 "cloud", "get", "--session", session], stdin=subprocess.DEVNULL,
                                capture_output=True, text=True, timeout=10, check=False)
        response = json.loads(result.stdout)
        return result.returncode == 0 and response.get("sessionId") == session
    except (OSError, ValueError, AttributeError, subprocess.TimeoutExpired):
        return False


def run_operation(store, request, *, inbox_root=None, cloud_bindings_path=None):
    if not isinstance(request, dict):
        raise ValueError("invalid broker request")
    action = request.get("action")
    fields = {
        "list": {"action", "actor"},
        "history": {"action", "actor", "group", "after", "limit"},
        "append": {"action", "actor", "group", "message_id", "message"},
        "send": {"action", "actor", "group", "message_id", "message", "destinations"},
        "lock_inspect": {"action", "actor", "group", "ref"},
        "lock_acquire": {"action", "actor", "group", "ref", "fence", "ttl"},
        "lock_check": {"action", "actor", "group", "ref", "fence", "lease_id"},
        "lock_renew": {"action", "actor", "group", "ref", "fence", "lease_id", "ttl"},
        "lock_release": {"action", "actor", "group", "ref", "fence", "lease_id"},
        "admin_list": {"action"},
        "admin_create": {"action", "name", "request_id", "role_key"},
        "admin_add": {"action", "group", "session"},
        "admin_remove": {"action", "group", "session"},
        "admin_link": {"action", "group", "ref", "lead"},
        "admin_unlink": {"action", "group", "ref"},
        "admin_transfer_lead": {"action", "ref", "from_group", "to_group"},
    }
    if not isinstance(action, str) or action not in fields or set(request) != fields[action]:
        raise ValueError("invalid broker operation fields")
    if action.startswith("admin_"):
        manager = GroupActor(manage=True)
        if action == "admin_list":
            return {"groups": store.list_groups(manager)}
        if action == "admin_create":
            return store.ensure_group(manager, request["name"], request["request_id"], role_key=request["role_key"])
        if action in ("admin_add", "admin_remove"):
            session = request["session"]
            if not isinstance(session, str):
                raise ValueError("invalid session")
            provider = session.partition(":")[0]
            if action == "admin_add" and provider.endswith("-cloud") and (
                provider != "claude-cloud" or not cloud_is_registered(session)
            ):
                raise ValueError("an open cloud graph registration is required")
            operation = store.add_member if action == "admin_add" else store.remove_member
            return operation(manager, request["group"], session)
        ref = request["ref"]
        if not isinstance(ref, str) or len(ref) > 256 or not re.fullmatch(
            r"[a-z][a-z0-9-]{0,63}:[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}", ref
        ):
            raise ValueError("ledger ref is not compatible with groups, graph and leases")
        if action == "admin_link":
            return store.link_ledger(manager, request["group"], ref, lead=request["lead"])
        if action == "admin_unlink":
            return store.unlink_ledger(manager, request["group"], ref)
        return store.transfer_ledger_lead(manager, ref, from_group_id=request["from_group"],
                                          to_group_id=request["to_group"])
    actor = GroupActor(session_id=request["actor"])
    if not actor.session_id or not cloud_is_registered(actor.session_id):
        raise ValueError("session is not registered")
    if action.startswith("lock_"):
        name = action.removeprefix("lock_")
        ref = request["ref"]
        try:
            # Hold a write reservation on the group database so revocation or
            # unlink cannot race the authorization and the lock operation.
            with store.guard_item_link(actor, request["group"], ref):
                args = {} if name == "inspect" else {"owner": actor.session_id, "fence": request["fence"]}
                if name in ("check", "renew", "release"):
                    args["lease_id"] = request["lease_id"]
                if name in ("acquire", "renew"):
                    args["ttl"] = request["ttl"]
                return lock_operation(name, ref, **args)
        except LeaseError:
            raise ValueError("item lease is unavailable") from None
    if action == "list":
        return {"groups": store.list_groups(actor)}
    if action == "history":
        return store.history(actor, request["group"], after=request["after"], limit=request["limit"])
    if action == "append":
        return store.append_message(actor, request["group"], request["message"], message_id=request["message_id"])
    destinations = request["destinations"]
    if not isinstance(destinations, list) or not 1 <= len(destinations) <= 4:
        raise ValueError("one to four destinations required")
    if cloud_bindings_path is not None:
        from mesh_group_dispatch import native_transport
        def transport(dest, correlation, text):
            if not dest.startswith("claude-cloud:"):
                return native_transport(dest, correlation, text, inbox_root=inbox_root)
            # Read immediately before each cloud attempt: a previous local
            # attempt can take time and an operator may revoke the binding.
            try:
                from mesh_group_dispatch import load_cloud_bindings
                bindings = load_cloud_bindings(cloud_bindings_path)
            except (ImportError, OSError, ValueError):
                return {"outcome": "blocked", "reason": "cloud_binding_unavailable"}
            return native_transport(dest, correlation, text, inbox_root=inbox_root,
                                    cloud_bindings=bindings)
        return dispatch(store, actor, request["group"], request["message_id"], request["message"], destinations,
                        transport)
    if inbox_root is None:
        return dispatch(store, actor, request["group"], request["message_id"], request["message"], destinations)
    from mesh_group_dispatch import native_transport
    return dispatch(store, actor, request["group"], request["message_id"], request["message"], destinations,
                    lambda dest, correlation, text: native_transport(dest, correlation, text, inbox_root=inbox_root))


class Broker(socketserver.ThreadingUnixStreamServer):
    # On graceful shutdown, retain the socket until admitted operations finish.
    daemon_threads = False

    def __init__(self, socket_path, state_dir, inbox_root=None, cloud_bindings_path=None):
        self.store = GroupStore(state_dir)
        self.inbox_root = inbox_root
        self.cloud_bindings_path = cloud_bindings_path
        self.socket_path = Path(socket_path)
        self.socket_identity = None
        info = self.socket_path.parent.stat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError("socket directory must be private and owned")
        old_umask = os.umask(0o177)
        try:
            super().__init__(str(self.socket_path), Handler)
        finally:
            os.umask(old_umask)
        self.socket_identity = self.socket_path.lstat().st_ino

    def server_close(self):
        super().server_close()
        try:
            info = self.socket_path.lstat()
            if self.socket_identity is not None and stat.S_ISSOCK(info.st_mode) and info.st_uid == os.getuid() and info.st_ino == self.socket_identity:
                self.socket_path.unlink()
        except FileNotFoundError:
            pass


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        try:
            if not hasattr(socket, "SO_PEERCRED"):
                raise ValueError("peer credentials are unavailable")
            _, uid, _ = struct.unpack("3i", self.request.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            if uid != os.getuid():
                raise ValueError("unauthorized socket peer")
            self.request.settimeout(15)
            data = self.rfile.readline(MAX_REQUEST + 1)
            if not data.endswith(b"\n") or len(data) > MAX_REQUEST:
                raise ValueError("invalid broker request size")
            result = run_operation(self.server.store, json.loads(data), inbox_root=self.server.inbox_root,
                                   cloud_bindings_path=self.server.cloud_bindings_path)
            output = {"ok": True, "result": result}
        except (ValueError, OSError) as error:
            output = {"ok": False, "error": str(error)}
        self.wfile.write((json.dumps(output, ensure_ascii=True) + "\n").encode())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--socket", type=Path, required=True)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--managed-inbox-root", type=Path)
    parser.add_argument("--cloud-bindings", type=Path, help="private cloud account binding file")
    args = parser.parse_args()
    def terminate(_signal, _frame):
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, terminate)
    with Broker(args.socket, args.state, args.managed_inbox_root, args.cloud_bindings) as broker:
        broker.serve_forever()


if __name__ == "__main__":
    main()
