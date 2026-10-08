#!/usr/bin/env python3
"""Follow selected agent sessions with a durable, replayable local outbox.

This is a read-only observer. It never sends to, resumes, or archives a session.
The caller owns the selection and decides what to do with the emitted facts.
"""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import fcntl
import importlib.util
import json
import os
import re
import sys
import tempfile
import time
from pathlib import Path
from typing import Any


WATCH_PATH = Path(__file__).with_name("agent-watch.py")
spec = importlib.util.spec_from_file_location("agent_watch", WATCH_PATH)
if spec is None or spec.loader is None:
    raise RuntimeError(f"cannot load {WATCH_PATH}")
watch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(watch)

NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$")
SESSION = re.compile(rf"^(codex|claude):({watch.SESSION_UUID})$", re.I)
MAX_LINE = 500
MAX_PER_TICK = 20


def state_dir(name: str) -> Path:
    if not NAME.fullmatch(name) or name in {".", ".."}:
        raise ValueError("name must be 1-80 safe ASCII characters")
    root = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local" / "state"))
    return root / "agent-mesh" / "follow" / name


def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(name)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, sort_keys=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def atomic_text(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(name)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(value)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def read_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


@contextlib.contextmanager
def locked(path: Path, *, nonblocking: bool = False):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    with os.fdopen(descriptor, "a+b") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | (fcntl.LOCK_NB if nonblocking else 0))
        except BlockingIOError as error:
            raise RuntimeError(f"another follower owns {path.parent.name}") from error
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def load_selection(root: Path) -> dict[str, dict[str, str]]:
    raw = read_json(root / "selection.json", {"version": 1, "sessions": {}})
    sessions = raw.get("sessions", {}) if isinstance(raw, dict) else {}
    if not isinstance(sessions, dict):
        raise ValueError("selection.json sessions must be an object")
    selected: dict[str, dict[str, str]] = {}
    for ref, entry in sessions.items():
        if not isinstance(ref, str) or not SESSION.fullmatch(ref) or not isinstance(entry, dict):
            raise ValueError("selection.json contains an invalid session entry")
        mode = str(entry.get("mode", "observe"))
        if mode not in {"steer", "observe", "child"}:
            raise ValueError(f"invalid mode for {ref}")
        selected[ref.lower()] = {
            "label": str(entry.get("label") or ref.split(":", 1)[1][:8])[:80],
            "mode": mode,
            "addedBy": str(entry.get("addedBy") or "manual")[:120],
            **({"parent": str(entry["parent"])[:100]} if entry.get("parent") else {}),
        }
    return selected


def save_selection(root: Path, selected: dict[str, dict[str, str]]) -> None:
    atomic_json(root / "selection.json", {"version": 1, "sessions": selected})


def cursor_path(root: Path, ref: str) -> Path:
    return root / "cursors" / (ref.replace(":", "-") + ".json")


def iso_epoch(value: Any) -> float:
    if not isinstance(value, str):
        return 0.0
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


def created_at(agent: str, path: Path) -> float:
    if agent == "codex":
        match = re.search(r"(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})", path.name)
        if match:
            try:
                return dt.datetime.strptime(match.group(1), "%Y-%m-%dT%H-%M-%S").replace(tzinfo=dt.timezone.utc).timestamp()
            except ValueError:
                pass
    try:
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            for _, line in zip(range(24), handle):
                try:
                    stamp = iso_epoch(json.loads(line).get("timestamp"))
                except ValueError:
                    continue
                if stamp:
                    return stamp
    except OSError:
        pass
    return 0.0


def prompt_and_origin(agent: str, path: Path) -> tuple[str, bool]:
    if agent == "claude" and "/subagents/" in str(path):
        return "", True
    try:
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            for _, line in zip(range(100), handle):
                try:
                    record = json.loads(line)
                except ValueError:
                    continue
                if agent == "codex" and record.get("type") == "session_meta":
                    source = (record.get("payload") or {}).get("source")
                    if (isinstance(source, dict) and "subagent" in source) or (isinstance(source, str) and source in {"exec", "mcp"}):
                        return "", True
                for item in watch.events_for(agent, record, ""):
                    if item.get("kind") == "human_message":
                        return watch.first_real_prompt(str(item.get("body") or "")), False
    except OSError:
        pass
    return "", False


def noise(prompt: str, config: dict[str, Any]) -> bool:
    rules = config.get("noise", {}) if isinstance(config, dict) else {}
    prefixes = rules.get("promptPrefixes", rules.get("prompt_prefixes", [])) if isinstance(rules, dict) else []
    if not isinstance(prefixes, list):
        prefixes = []
    markers = rules.get("fixtureMarkers", []) if isinstance(rules, dict) else []
    if not isinstance(markers, list):
        markers = []
    return any(prompt.startswith(str(prefix)) for prefix in prefixes) or any(str(marker) in prompt for marker in markers)


def read_records(agent: str, ref: str, path: Path, cursor: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Read complete JSONL records without loading an entire transcript."""
    size = path.stat().st_size
    offset = int(cursor.get("offset", 0))
    pending = dict(cursor.get("pending") or {})
    if cursor.get("path") != str(path) or offset > size:
        offset, pending = 0, {}
    events: list[dict[str, Any]] = []
    with path.open("rb") as handle:
        handle.seek(offset)
        while handle.tell() < size:
            line = handle.readline(size - handle.tell())
            if not line.endswith(b"\n"):
                break
            offset = handle.tell()
            try:
                record = json.loads(line.decode("utf-8", "replace"))
            except ValueError:
                continue
            if isinstance(record, dict):
                events.extend(watch.events_for(agent, record, ref.split(":", 1)[1]))
    return events, {"path": str(path), "offset": offset, "pending": pending}


def one_line(seq: int, ref: str, selection: dict[str, str], kind: str, body: str, stamp: Any) -> str:
    clock = str(stamp or "")[11:16]
    if not re.fullmatch(r"\d{2}:\d{2}", clock):
        clock = dt.datetime.now(dt.timezone.utc).strftime("%H:%M")
    label = selection.get("label") or ref.split(":", 1)[1][:8]
    mode = selection.get("mode", "observe")
    if mode == "child" and selection.get("parent"):
        label = f"{selection['parent']}›{label}"
    prefix = f"#{seq} {clock}Z [{label}|{mode}] {kind} "
    flat = " ".join(str(body).split())
    return prefix + flat[: max(0, MAX_LINE - len(prefix))]


def derive(ref: str, selected: dict[str, str], events: list[dict[str, Any]], pending: dict[str, Any], config: dict[str, Any] | None = None) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    out: list[dict[str, Any]] = []
    mode = selected.get("mode", "observe")
    follower = (config or {}).get("follower", {})
    observe_questions_only = bool(follower.get("observeQuestionAndErrorOnly", False)) if isinstance(follower, dict) else False
    for event in events:
        kind = event.get("kind")
        event_id = str(event.get("source_event_id") or "")
        if kind == "human_message":
            pending["last_human"] = str(event.get("body") or "")
            pending.pop("last_reply", None)
            pending["active"] = True
            pending.pop("stalled", None)
        elif kind == "agent_message":
            if event.get("phase") == "final":
                pending["last_reply"] = str(event.get("body") or "")
        elif kind == "question":
            out.append({"event_id": event_id, "ref": ref, "kind": "QUESTION", "body": str(event.get("body") or ""), "timestamp": event.get("timestamp"), "selection": selected})
        elif kind == "tool" and event.get("schema") != "agent-mesh.event.v2" and event.get("tool_name") in {"AskUserQuestion", "request_user_input", "request_user_input_async"}:
            out.append({"event_id": event_id, "ref": ref, "kind": "QUESTION", "body": str(event.get("body") or ""), "timestamp": event.get("timestamp"), "selection": selected})
        elif kind == "turn_complete":
            outcome = str(event.get("outcome") or "")
            error = event.get("error") or {}
            reply = event.get("reply") or pending.get("last_reply") or ""
            if outcome == "error" or error:
                body = error.get("message", "") if isinstance(error, dict) else str(error)
                line_kind = "ERROR"
            elif outcome == "no_reply" or not reply:
                body, line_kind = "turn completed without a reply", "NOREPLY"
            else:
                body, line_kind = str(reply), "REPLY"
            if (mode != "child" or line_kind != "REPLY") and (mode != "observe" or not observe_questions_only or line_kind == "ERROR"):
                out.append({"event_id": event_id, "ref": ref, "kind": line_kind, "body": body, "timestamp": event.get("timestamp"), "selection": selected})
            pending.pop("last_reply", None)
            pending["active"] = False
    return out, pending


def outbox(root: Path) -> tuple[list[dict[str, Any]], set[str]]:
    rows: list[dict[str, Any]] = []
    ids: set[str] = set()
    path = root / "outbox.jsonl"
    if not path.exists():
        return rows, ids
    with path.open("r+b") as handle:
        data = handle.read()
        complete_end = data.rfind(b"\n") + 1
        if complete_end < len(data):
            # A process killed during append can leave an incomplete final line.
            # Its cursor was not advanced; the next tick will derive it again.
            handle.truncate(complete_end)
            handle.flush()
            os.fsync(handle.fileno())
        for number, line in enumerate(data[:complete_end].splitlines(), 1):
            try:
                row = json.loads(line)
            except ValueError as error:
                raise RuntimeError(f"outbox line {number} is corrupt") from error
            if not isinstance(row, dict) or not isinstance(row.get("seq"), int) or not isinstance(row.get("event_id"), str):
                raise RuntimeError(f"outbox line {number} has invalid fields")
            if rows and row["seq"] != rows[-1]["seq"] + 1:
                raise RuntimeError(f"outbox sequence gap at line {number}")
            rows.append(row)
            ids.add(row["event_id"])
    return rows, ids


def append_outbox(root: Path, candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows, ids = outbox(root)
    seq = rows[-1]["seq"] if rows else 0
    fresh: list[dict[str, Any]] = []
    for item in candidates:
        if not item["event_id"] or item["event_id"] in ids:
            continue
        ids.add(item["event_id"])
        seq += 1
        row = {**item, "seq": seq, "emitted_at": time.time()}
        row["line"] = one_line(seq, item["ref"], item["selection"], item["kind"], item["body"], item.get("timestamp"))
        fresh.append(row)
    if fresh:
        path = root / "outbox.jsonl"
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        with os.fdopen(descriptor, "a", encoding="utf-8") as handle:
            for row in fresh:
                handle.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
    return fresh


def discover(root: Path, selected: dict[str, dict[str, str]], config: dict[str, Any], self_ref: str | None) -> tuple[list[dict[str, Any]], dict[str, Path], dict[str, float]]:
    last_run_path = root / "last-run"
    last_run = float(last_run_path.read_text()) if last_run_path.exists() else time.time()
    discoveries: list[dict[str, Any]] = []
    paths: dict[str, Path] = {}
    prior = read_json(root / "discover-cache.json", {})
    if not isinstance(prior, dict):
        prior = {}
    current: dict[str, float] = {}
    metadata = watch.codex_metadata()
    parents = watch.bridge_parents()
    rules = config.get("noise", {}) if isinstance(config.get("noise"), dict) else {}
    follower = config.get("follower", {}) if isinstance(config.get("follower"), dict) else {}
    thread_noise = set(rules.get("threadSources", ("subagent", "guardian_review", "automation", "realtime_voice")))
    source_noise = set(rules.get("sources", ("exec", "mcp")))
    bridge_children: list[tuple[str, str, str, str]] = []
    for agent in ("codex", "claude"):
        for session_id, path in watch.transcript_candidates(agent):
            ref = f"{agent}:{session_id}"
            paths[ref] = path
            try:
                mtime = path.stat().st_mtime
            except OSError:
                continue
            current[ref] = mtime
            if ref == self_ref or ref in selected:
                continue
            try:
                if mtime < last_run and created_at(agent, path) < last_run - 60:
                    continue
            except OSError:
                continue
            prompt, subagent = prompt_and_origin(agent, path)
            if subagent or noise(prompt, config):
                continue
            parent_id = parents.get(session_id)
            origin = watch.session_origin(agent, {"path": str(path), **metadata.get(session_id, {})}, parent_id)
            if origin not in {"human", "desktop-task", "bridge-worker"}:
                continue
            if agent == "codex":
                meta = metadata.get(session_id, {})
                thread_source = meta.get("thread_source")
                source = meta.get("source")
                if (isinstance(thread_source, str) and thread_source in thread_noise) or (isinstance(source, str) and source in source_noise):
                    continue
            created = created_at(agent, path)
            kind = "NEW" if created >= last_run - 60 else "RESUMED"
            if parent_id:
                bridge_children.append((ref, session_id, parent_id, prompt))
                continue
            if kind == "NEW" and not follower.get("autoNewHuman", True):
                continue
            if kind == "RESUMED" and (not follower.get("autoResumedKnown", True) or ref not in prior):
                continue
            label = f"{agent}-{session_id[:8]}"
            selected[ref] = {"label": label, "mode": "observe", "addedBy": "discovery"}
            discoveries.append({"event_id": f"discovery:{ref}:{kind}", "ref": ref, "kind": kind, "body": prompt, "timestamp": dt.datetime.now(dt.timezone.utc).isoformat(), "selection": selected[ref]})
    for ref, session_id, parent_id, prompt in bridge_children:
        parent = next((entry for key, entry in selected.items() if key.split(":", 1)[1] == parent_id), None)
        if parent is None:
            continue
        selected[ref] = {"label": f"{ref.split(':', 1)[0]}-{session_id[:8]}", "mode": "child", "parent": parent["label"], "addedBy": "bridge"}
        discoveries.append({"event_id": f"discovery:{ref}:SPAWNED", "ref": ref, "kind": "SPAWNED", "body": prompt, "timestamp": dt.datetime.now(dt.timezone.utc).isoformat(), "selection": selected[ref]})
    return discoveries, paths, current


def tick(root: Path, config: dict[str, Any], self_ref: str | None) -> int:
    with locked(root / "state.lock"):
        selected = load_selection(root)
        new, paths, discovered = discover(root, selected, config, self_ref)
        staged: list[tuple[Path, dict[str, Any]]] = []
        candidates = list(new)
        for ref, selection in selected.items():
            if ref == self_ref:
                continue
            agent, session_id = ref.split(":", 1)
            path = paths.get(ref)
            if path is None:
                continue
            cp = cursor_path(root, ref)
            cursor = read_json(cp, {})
            if not cursor:
                # Arm established sessions at EOF. A new session is read from start.
                start = 0 if any(item["ref"] == ref for item in new) else path.stat().st_size
                cursor = {"path": str(path), "offset": start, "pending": {}}
            events, next_cursor = read_records(agent, ref, path, cursor)
            lines, next_cursor["pending"] = derive(ref, selection, events, next_cursor["pending"], config)
            follower = config.get("follower", {}) if isinstance(config.get("follower"), dict) else {}
            stalled_seconds = float(follower.get("stalledMinutes", 30)) * 60
            if events:
                next_cursor["last_growth_at"] = time.time()
            elif selection.get("mode") == "steer" and next_cursor["pending"].get("active") and not next_cursor["pending"].get("stalled") and time.time() - float(next_cursor.get("last_growth_at", time.time())) >= stalled_seconds:
                next_cursor["pending"]["stalled"] = True
                lines.append({"event_id": f"stalled:{ref}:{next_cursor['offset']}", "ref": ref, "kind": "STALLED", "body": "active turn has not grown", "timestamp": dt.datetime.now(dt.timezone.utc).isoformat(), "selection": selection})
            candidates.extend(lines)
            staged.append((cp, next_cursor))
        fresh = append_outbox(root, candidates)
        save_selection(root, selected)
        atomic_json(root / "discover-cache.json", discovered)
        for path, value in staged:
            atomic_json(path, value)
        atomic_text(root / "last-run", str(time.time()) + "\n")
        return len(fresh)


def print_pending(root: Path, replay_window: int = 0, limit: int = MAX_PER_TICK) -> int:
    with locked(root / "state.lock"):
        rows, _ = outbox(root)
        printed_path = root / "printed.seq"
        printed = int(printed_path.read_text()) if printed_path.exists() else 0
        cutoff = time.time() - replay_window
        eligible = [row for row in rows if row["seq"] > printed or (replay_window and row.get("emitted_at", 0) >= cutoff)]
        count = 0
        for row in eligible[:limit]:
            print(row["line"], flush=True)
            printed = max(printed, row["seq"])
            atomic_text(printed_path, str(printed) + "\n")
            count += 1
        remaining = len(eligible) - count
        if remaining:
            print(f"FOLLOWER +{remaining} more (drain)", flush=True)
        return count


def parser() -> argparse.ArgumentParser:
    cli = argparse.ArgumentParser(description=__doc__)
    commands = cli.add_subparsers(dest="command", required=True)
    for command in ("run", "wait", "drain", "add", "remove", "list"):
        sub = commands.add_parser(command)
        sub.add_argument("--name", required=True)
        if command in {"run", "wait", "drain"}:
            sub.add_argument("--config", type=Path)
            sub.add_argument("--self", dest="self_ref")
        if command == "run":
            sub.add_argument("--interval", type=float, default=30)
            sub.add_argument("--max-runtime", type=float, default=1680)
            sub.add_argument("--replay-window", type=int, default=120)
        if command == "wait":
            sub.add_argument("--timeout", type=float, default=600)
        if command in {"add", "remove"}:
            sub.add_argument("session")
        if command == "add":
            sub.add_argument("--label")
            sub.add_argument("--mode", choices=("steer", "observe", "child"), default="observe")
        if command == "list":
            sub.add_argument("--json", action="store_true")
    return cli


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    root = state_dir(args.name)
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    root.chmod(0o700)
    if args.command in {"add", "remove"}:
        ref = args.session.lower()
        if not SESSION.fullmatch(ref):
            raise ValueError("session must be codex:<uuid> or claude:<uuid>")
        with locked(root / "state.lock"):
            selected = load_selection(root)
            if args.command == "add":
                selected[ref] = {"label": args.label or ref.split(":", 1)[1][:8], "mode": args.mode, "addedBy": "cli"}
            else:
                selected.pop(ref, None)
            save_selection(root, selected)
        return 0
    if args.command == "list":
        selected = load_selection(root)
        if args.json:
            print(json.dumps({"version": 1, "sessions": selected}, ensure_ascii=False, sort_keys=True))
        else:
            for ref, entry in selected.items():
                print(f"{ref}\t{entry['mode']}\t{entry['label']}")
        return 0
    if args.self_ref and not SESSION.fullmatch(args.self_ref):
        raise ValueError("--self must be codex:<uuid> or claude:<uuid>")
    config = read_json(args.config, {}) if args.config else {}
    if not isinstance(config, dict):
        raise ValueError("--config must contain a JSON object")
    follower = config.get("follower", {}) if isinstance(config.get("follower"), dict) else {}
    limit = int(follower.get("maxLinesPerTick", MAX_PER_TICK))
    if limit <= 0:
        raise ValueError("maxLinesPerTick must be positive")
    if args.command == "drain":
        tick(root, config, args.self_ref)
        print_pending(root, limit=limit)
        return 0
    if args.command == "wait":
        with locked(root / "engine.lock", nonblocking=True):
            deadline = time.monotonic() + args.timeout
            while True:
                tick(root, config, args.self_ref)
                if print_pending(root, limit=limit):
                    return 0
                if time.monotonic() >= deadline:
                    return 1
                time.sleep(min(2.0, max(0, deadline - time.monotonic())))
    if args.interval <= 0 or args.max_runtime <= 0:
        raise ValueError("interval and max-runtime must be positive")
    with locked(root / "engine.lock", nonblocking=True):
        started = time.monotonic()
        replay = args.replay_window
        while time.monotonic() - started < args.max_runtime:
            tick(root, config, args.self_ref)
            print_pending(root, replay, limit)
            replay = 0
            time.sleep(min(args.interval, max(0, args.max_runtime - (time.monotonic() - started))))
        print("FOLLOWER exit rearm", flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RuntimeError) as error:
        print(f"FOLLOWER degraded {error}", file=sys.stderr)
        raise SystemExit(2)
