#!/usr/bin/env python3
"""Focused regression test for agent-idle-expiry.py on an isolated tmux socket."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
BRIDGE_DIR = SCRIPT_DIR.parent
BIN_DIR = BRIDGE_DIR / "bin"
AGENTS_DIR = BRIDGE_DIR / "agents"
SESSION_BIN = BIN_DIR / "agent-session.sh"
REAPER_BIN = BIN_DIR / "agent-idle-expiry.py"


def run(command: list[str], env: dict[str, str], *, expected: int = 0) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(command, text=True, capture_output=True, env=env, check=False)
    if result.returncode != expected:
        raise AssertionError(
            f"expected exit {expected}, got {result.returncode}: {' '.join(command)}\nstdout={result.stdout}\nstderr={result.stderr}"
        )
    return result


def has_session(socket: str, target: str, env: dict[str, str]) -> bool:
    return subprocess.run(["tmux", "-L", socket, "has-session", "-t", target], env=env, capture_output=True).returncode == 0


def send(socket: str, target: str, command: str, env: dict[str, str]) -> None:
    run(["tmux", "-L", socket, "send-keys", "-t", target, command, "Enter"], env)


def main() -> int:
    if shutil.which("tmux") is None:
        raise AssertionError("tmux is required")
    socket = f"mesh-idle-expiry-test-{os.getpid()}"
    agent = f"idle-expiry-test-{os.getpid()}"
    conf = AGENTS_DIR / f"{agent}.conf"
    env = os.environ.copy()
    env["MESH_TMUX_SOCKET"] = socket
    env["TMUX_SESSION_PREFIX"] = "mesh"
    conf.write_text(
        "\n".join(
            [
                'AGENT_BIN="bash"',
                'AGENT_SUBMIT_KEY="Enter"',
                'AGENT_PROMPT_CHAR="REAPER>"',
                'AGENT_WORKING_PATTERN="WORKING"',
                'AGENT_IDLE_PATTERN="REAPER>"',
                'AGENT_APPROVAL_PATTERN="Press enter to confirm"',
                'AGENT_ALIVE_PROCESS_PATTERN="^bash$"',
                'AGENT_RESUME_CMD="env PS1=\'REAPER> \' bash --noprofile --norc -i"',
                'AGENT_HAS_CWD_PICKER="false"',
                'AGENT_PICKER_PATTERN=""',
                'AGENT_NEW_CMD="env PS1=\'REAPER> \' bash --noprofile --norc -i"',
                'AGENT_SESSION_DIR="${TMPDIR:-/tmp}"',
                "AGENT_SESSION_CWD_EXTRACTOR='printf \"%s\\n\" \"$PWD\"'",
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    with tempfile.TemporaryDirectory(prefix="agent-mesh-idle-expiry-") as temporary:
        state = Path(temporary) / "state.json"
        guard = Path(temporary) / "delivery.guard"

        def start(label: str) -> str:
            target = f"mesh-{agent}-{label}"
            return run([str(SESSION_BIN), "--agent", agent, "new", temporary, target], env).stdout.strip()

        def reap(*extra: str) -> subprocess.CompletedProcess[str]:
            return run(
                [
                    str(REAPER_BIN),
                    "--agent",
                    agent,
                    "--state",
                    str(state),
                    "--idle-seconds",
                    "0",
                    "--grace-seconds",
                    "0",
                    "--max-check-gap-seconds",
                    "30",
                    *extra,
                ],
                env,
            )

        try:
            # Inspection is default and must not create or alter runtime state.
            expiring = start("expire")
            report = reap("--target", expiring)
            assert "grace" in report.stdout, report.stdout
            assert not state.exists(), "dry-run created state"
            reap("--execute", "--target", expiring)
            assert has_session(socket, expiring, env), "first execute must only arm the grace checkpoint"
            closed = reap("--execute", "--target", expiring)
            assert "closed" in closed.stdout, closed.stdout
            assert not has_session(socket, expiring, env), "eligible idle session was not closed"
            persisted = json.loads(state.read_text(encoding="utf-8"))
            assert any(item.get("phase") == "closed" for item in persisted["targets"].values())

            # Working, approval, and error states all suppress expiry even with a
            # zero threshold. These keys run only on this isolated test socket.
            working = start("working")
            send(socket, working, "printf 'WORKING\\n'", env)
            assert "working" in reap("--execute", "--target", working).stdout
            assert has_session(socket, working, env), "working session was reaped"

            approval = start("approval")
            send(socket, approval, "printf 'Press enter to confirm\\n'", env)
            assert "approval-pending" in reap("--execute", "--target", approval).stdout
            assert has_session(socket, approval, env), "approval-pending session was reaped"

            errored = start("error")
            send(socket, errored, "printf 'error\\n'", env)
            assert "error" in reap("--execute", "--target", errored).stdout
            assert has_session(socket, errored, env), "error session was reaped"

            guarded = start("guarded")
            guard.write_text("delivery in flight\n", encoding="utf-8")
            guarded_report = reap("--execute", "--target", guarded, "--delivery-guard", str(guard))
            assert "delivery-guard-present" in guarded_report.stdout
            assert has_session(socket, guarded, env), "delivery-guarded session was reaped"

            multi_pane = start("multi-pane")
            run(["tmux", "-L", socket, "split-window", "-d", "-t", multi_pane], env)
            multi_report = reap("--execute", "--target", multi_pane)
            assert "exactly-one-pane" in multi_report.stdout
            assert has_session(socket, multi_pane, env), "multi-pane session was reaped"
        finally:
            for target in [
                f"mesh-{agent}-working",
                f"mesh-{agent}-approval",
                f"mesh-{agent}-error",
                f"mesh-{agent}-guarded",
                f"mesh-{agent}-multi-pane",
            ]:
                subprocess.run([str(SESSION_BIN), "--agent", agent, "kill", target], env=env, capture_output=True)
            subprocess.run(["tmux", "-L", socket, "kill-server"], env=env, capture_output=True)
            conf.unlink(missing_ok=True)

    print("PASS: idle expiry lifecycle regression test")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
