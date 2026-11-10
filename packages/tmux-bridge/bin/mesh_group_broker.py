#!/usr/bin/env python3
"""Host-side private Unix socket broker for authenticated group conversations."""
import argparse
import json
import os
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


def run_operation(store, request, *, inbox_root=None):
    if not isinstance(request, dict):
        raise ValueError("invalid broker request")
    action = request.get("action")
    fields = {
        "list": {"action", "actor"},
        "history": {"action", "actor", "group", "after", "limit"},
        "append": {"action", "actor", "group", "message_id", "message"},
        "send": {"action", "actor", "group", "message_id", "message", "destinations"},
    }
    if not isinstance(action, str) or action not in fields or set(request) != fields[action]:
        raise ValueError("invalid broker operation fields")
    actor = GroupActor(session_id=request["actor"])
    if not actor.session_id or not cloud_is_registered(actor.session_id):
        raise ValueError("session is not registered")
    if action == "list":
        return {"groups": store.list_groups(actor)}
    if action == "history":
        return store.history(actor, request["group"], after=request["after"], limit=request["limit"])
    if action == "append":
        return store.append_message(actor, request["group"], request["message"], message_id=request["message_id"])
    destinations = request["destinations"]
    if not isinstance(destinations, list) or not 1 <= len(destinations) <= 4:
        raise ValueError("one to four destinations required")
    if inbox_root is None:
        return dispatch(store, actor, request["group"], request["message_id"], request["message"], destinations)
    from mesh_group_dispatch import native_transport
    return dispatch(store, actor, request["group"], request["message_id"], request["message"], destinations,
                    lambda dest, correlation, text: native_transport(dest, correlation, text, inbox_root=inbox_root))


class Broker(socketserver.ThreadingUnixStreamServer):
    # On graceful shutdown, retain the socket until admitted operations finish.
    daemon_threads = False

    def __init__(self, socket_path, state_dir, inbox_root=None):
        self.store = GroupStore(state_dir)
        self.inbox_root = inbox_root
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
            result = run_operation(self.server.store, json.loads(data), inbox_root=self.server.inbox_root)
            output = {"ok": True, "result": result}
        except (ValueError, OSError) as error:
            output = {"ok": False, "error": str(error)}
        self.wfile.write((json.dumps(output, ensure_ascii=True) + "\n").encode())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--socket", type=Path, required=True)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--managed-inbox-root", type=Path)
    args = parser.parse_args()
    def terminate(_signal, _frame):
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, terminate)
    with Broker(args.socket, args.state, args.managed_inbox_root) as broker:
        broker.serve_forever()


if __name__ == "__main__":
    main()
