#!/usr/bin/env python3
"""Decide whether a Codex thread may be resumed in tmux, and verify a tmux release."""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

SAFE_ID = re.compile(r"^[A-Za-z0-9_-]+$")
EXIT_ARCHIVED = 3
EXIT_WRITER = 4
EXIT_DESKTOP = 6
SCRIPT_DIR = Path(__file__).resolve().parent


def codex_home() -> Path:
    return Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")


def proc_root() -> Path:
    return Path(os.environ.get("AGENT_WRITER_PROC_ROOT") or "/proc")


def state_db(home: Path) -> Path | None:
    explicit = os.environ.get("CODEX_STATE_DB")
    if explicit:
        return Path(explicit)
    candidates = sorted(home.glob("state_*.sqlite"), key=lambda p: int(re.sub(r"\D", "", p.stem) or 0))
    return candidates[-1] if candidates else None


def thread_row(home: Path, session: str) -> tuple[dict | None, str | None]:
    """Return (row, problem); a missing or changed schema is a problem, never a verdict."""
    path = state_db(home)
    if path is None or not path.is_file():
        return None, "no Codex state database"
    try:
        with sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=1) as db:
            db.row_factory = sqlite3.Row
            columns = {row["name"] for row in db.execute("PRAGMA table_info(threads)")}
            needed = {"id", "archived", "source", "is_pinned", "thread_section_id"}
            if not needed <= columns:
                return None, "Codex threads schema has no Desktop visibility columns"
            row = db.execute(
                "SELECT id, archived, source, is_pinned, thread_section_id FROM threads WHERE id = ?",
                (session,),
            ).fetchone()
            return (dict(row) if row else None), None
    except sqlite3.Error as error:
        return None, f"Codex state database unreadable ({type(error).__name__})"


def rollout_files(root: Path, session: str, recursive: bool) -> list[Path]:
    if not root.is_dir():
        return []
    pattern = f"*{session}*.jsonl*"
    found = root.rglob(pattern) if recursive else root.glob(pattern)
    return [p for p in found if p.is_file()]


def writers(session: str) -> list[dict]:
    result = subprocess.run(
        ["node", str(SCRIPT_DIR / "session-writer-status.mjs"), "--agent", "codex", "--session", session, "--json"],
        capture_output=True, text=True, timeout=30,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "writer status failed")
    return json.loads(result.stdout)["writers"]


def desktop_sources() -> set[str]:
    return {s for s in os.environ.get("AGENT_DESKTOP_THREAD_SOURCES", "vscode").split(",") if s}


def resume_check(args: argparse.Namespace) -> int:
    session = args.session
    home = codex_home()
    target = args.target or "<target>"
    row, problem = thread_row(home, session)
    live = [p for p in rollout_files(home / "sessions", session, True) if p.name.endswith(".jsonl")]
    archived = bool(row and row["archived"]) or (
        not live and bool(rollout_files(home / "archived_sessions", session, False)))
    if archived:
        print(f"ERROR: Codex session '{session}' is archived. Restore it with `codex unarchive {session}` "
              "and retry. Codex Desktop may load it right after; if writer-status then shows an app-server "
              f"writer, send work with `codex queue --thread {session} --message <text>` instead.", file=sys.stderr)
        return EXIT_ARCHIVED
    try:
        current = writers(session)
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"ERROR: cannot inspect writers for Codex thread '{session}': {error}", file=sys.stderr)
        return EXIT_WRITER
    served = [w for w in current if w.get("role") == "app-server"]
    if served:
        pids = ", ".join(str(w["pid"]) for w in served)
        print(f"ERROR: Codex thread '{session}' is loaded by a Codex app-server (pid {pids}), e.g. Codex Desktop. "
              f"Don't resume it in tmux; send work through the app-server: "
              f"`codex queue --thread {session} --message <text>`.", file=sys.stderr)
        return EXIT_WRITER
    if current:
        pids = ", ".join(str(w["pid"]) for w in current)
        print(f"ERROR: Codex thread '{session}' already has a CLI writer (pid {pids}). Reuse that session, "
              "or release its tmux target with `agent-session.sh --agent codex release <target>`.", file=sys.stderr)
        return EXIT_WRITER
    if problem:
        print(f"WARN: {problem}; cannot tell whether '{session}' is visible in Codex Desktop", file=sys.stderr)
        return 0
    visible = bool(row) and (row["source"] in desktop_sources() or bool(row["is_pinned"])
                             or row["thread_section_id"] is not None)
    if not visible:
        return 0
    release = f"agent-session.sh --agent codex release {target} {session}"
    if not args.allow_desktop_thread:
        print(f"ERROR: Codex thread '{session}' is visible in Codex Desktop and idle. A tmux resume keeps it "
              f"attached to the tmux CLI and Desktop can't drive it until that ends. Prefer "
              f"`codex queue --thread {session} --message <text>`. To resume anyway, pass "
              f"--allow-desktop-thread and release it right after use: `{release}`.", file=sys.stderr)
        return EXIT_DESKTOP
    print(f"WARN: resuming Desktop-visible Codex thread '{session}' in tmux; release it right after use: "
          f"`{release}`", file=sys.stderr)
    return 0


def parent_pid(pid: int) -> int | None:
    try:
        for line in (proc_root() / str(pid) / "status").read_text().splitlines():
            if line.startswith("PPid:"):
                return int(line.split()[1])
    except (OSError, ValueError, IndexError):
        return None
    return None


def descendants(roots: set[int]) -> set[int]:
    found = set(roots)
    for entry in proc_root().iterdir():
        if not entry.name.isdigit():
            continue
        pid, chain = int(entry.name), []
        while pid and pid not in found and len(chain) < 64:
            chain.append(pid)
            pid = parent_pid(pid) or 0
        if pid in found:
            found.update(chain)
    return found


def held_threads(pids: set[int], home: Path) -> set[str]:
    locks = os.path.realpath(home / "thread-writer-locks")
    threads = set()
    for pid in pids:
        fd_dir = proc_root() / str(pid) / "fd"
        try:
            entries = list(fd_dir.iterdir())
        except OSError:
            continue
        for fd in entries:
            try:
                target = os.path.realpath(os.readlink(fd))
            except OSError:
                continue
            if os.path.dirname(target) == locks and target.endswith(".lock"):
                threads.add(os.path.basename(target)[:-5])
    return threads


def pane_scan(args: argparse.Namespace) -> int:
    pids = descendants(set(args.pane_pid))
    print(json.dumps({"pids": sorted(pids), "threads": sorted(held_threads(pids, codex_home()))}))
    return 0


def alive(pid: int) -> bool:
    return (proc_root() / str(pid)).is_dir()


def release_verify(args: argparse.Namespace) -> int:
    deadline = time.monotonic() + args.timeout
    pending = set(args.pid)
    while pending and time.monotonic() < deadline:
        pending = {pid for pid in pending if alive(pid)}
        if pending:
            time.sleep(0.2)
    if pending:
        print(f"ERROR: tmux target processes still running after {args.timeout}s: "
              + ", ".join(map(str, sorted(pending))), file=sys.stderr)
        return EXIT_WRITER
    status = 0
    for session in args.session:
        try:
            current = writers(session)
        except (OSError, ValueError, KeyError, RuntimeError, subprocess.SubprocessError) as error:
            print(f"ERROR: cannot inspect writers for '{session}': {error}", file=sys.stderr)
            status = EXIT_WRITER
            continue
        cli = [w for w in current if w.get("role") != "app-server"]
        if cli:
            print(f"ERROR: thread {session} still has a CLI writer (pid "
                  + ", ".join(str(w["pid"]) for w in cli) + ")", file=sys.stderr)
            status = EXIT_WRITER
        elif current:
            print(f"thread {session}: loaded by the Codex app-server; Desktop can drive it")
        else:
            print(f"thread {session}: no writer")
    return status


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    check = sub.add_parser("resume-check")
    check.add_argument("--session", required=True)
    check.add_argument("--target")
    check.add_argument("--allow-desktop-thread", action="store_true")
    scan = sub.add_parser("pane-scan")
    scan.add_argument("--pane-pid", type=int, action="append", required=True)
    verify = sub.add_parser("release-verify")
    verify.add_argument("--pid", type=int, action="append", default=[])
    verify.add_argument("--session", action="append", default=[])
    verify.add_argument("--timeout", type=float, default=10)
    args = parser.parse_args()
    sessions = getattr(args, "session", None) or []
    for value in [sessions] if isinstance(sessions, str) else sessions:
        if not SAFE_ID.fullmatch(value):
            parser.error("--session contains unsafe characters")
    return {"resume-check": resume_check, "pane-scan": pane_scan, "release-verify": release_verify}[args.command](args)


if __name__ == "__main__":
    raise SystemExit(main())
