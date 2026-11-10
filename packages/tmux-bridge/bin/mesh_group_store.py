"""Local Agent Mesh group and conversation API. The caller authenticates actors."""

from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
import errno
import fcntl
import os
from pathlib import Path
import re
import sqlite3
import stat
from uuid import uuid4

from mesh_group_import import graph_import_plan


_SESSION_ID = re.compile(r"[a-z][a-z0-9_-]{0,63}:[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,254}")
_ROLE_KEY = re.compile(r"[a-z0-9][a-z0-9_.:/-]{0,127}")
_GROUP_ID = re.compile(r"group_[a-f0-9]{32}")
_VERSION = 1
_SCHEMA = (
    """CREATE TABLE groups (
        group_id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        role_key TEXT,
        source_ref TEXT UNIQUE,
        created_at TEXT NOT NULL
    )""",
    """CREATE TABLE members (
        group_id TEXT NOT NULL REFERENCES groups(group_id),
        session_id TEXT NOT NULL,
        added_at TEXT NOT NULL,
        PRIMARY KEY (group_id, session_id)
    )""",
    "CREATE INDEX members_by_session ON members(session_id, group_id)",
    """CREATE TABLE ledger_links (
        group_id TEXT NOT NULL REFERENCES groups(group_id),
        ref TEXT NOT NULL,
        lead INTEGER NOT NULL CHECK (lead IN (0, 1)),
        PRIMARY KEY (group_id, ref)
    )""",
    "CREATE INDEX links_by_ref ON ledger_links(ref, group_id)",
    "CREATE UNIQUE INDEX one_lead_per_ref ON ledger_links(ref) WHERE lead = 1",
    """CREATE TABLE messages (
        group_id TEXT NOT NULL REFERENCES groups(group_id),
        seq INTEGER NOT NULL,
        message_id TEXT NOT NULL,
        author_session_id TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (group_id, seq),
        UNIQUE (group_id, message_id)
    )""",
    "CREATE TABLE graph_imports (source TEXT PRIMARY KEY NOT NULL, plan_digest TEXT NOT NULL)",
)


class GroupAccessError(ValueError):
    """An actor cannot access the requested operation or group."""


class GroupConflictError(ValueError):
    """The requested change conflicts with existing group state."""


def _matched(value, pattern, label):
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise ValueError(f"invalid {label}")
    return value


def _one_line(value, limit, label):
    if (not isinstance(value, str) or not 0 < len(value) <= limit or value != value.strip()
            or not value.isprintable()):
        raise ValueError(f"invalid {label}")
    return value


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


@dataclass(frozen=True)
class GroupActor:
    """Authority established by a trusted host or authenticated adapter, never request fields."""

    session_id: str | None = None
    manage: bool = False

    def __post_init__(self):
        if self.session_id is not None:
            _matched(self.session_id, _SESSION_ID, "session id")
        if type(self.manage) is not bool:
            raise ValueError("invalid group management grant")


class GroupStore:
    """Durable groups for one host; all authorization and state changes share a transaction."""

    def __init__(self, state_dir):
        self.state_dir = Path(state_dir).absolute()
        self.path = self.state_dir / "groups.sqlite3"

    def _connect(self, *, write, initialize):
        if initialize:
            self.state_dir.mkdir(parents=True, mode=0o700, exist_ok=True)
        try:
            directory = os.open(self.state_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        except FileNotFoundError:
            return None
        except OSError as error:
            if error.errno in (errno.ENOTDIR, errno.ELOOP):
                raise ValueError("group state directory must be private and owned") from error
            raise
        try:
            info = os.fstat(directory)
            if info.st_uid != os.getuid() or info.st_mode & 0o077:
                raise ValueError("group state directory must be private and owned")
            # Closing a raw descriptor for the database inode can drop SQLite's
            # POSIX locks in the same process. Open an inode ourselves only when
            # creating it, and prevent a second connection until it is closed.
            # The directory lock is independent of SQLite's transaction locks.
            fcntl.flock(directory, fcntl.LOCK_EX)
            if initialize:
                try:
                    created = os.open(self.path.name, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW,
                                      0o600, dir_fd=directory)
                except FileExistsError:
                    pass
                else:
                    os.close(created)
            for suffix in ("", "-journal", "-wal", "-shm"):
                try:
                    info = os.stat(self.path.name + suffix, dir_fd=directory, follow_symlinks=False)
                except FileNotFoundError:
                    if suffix == "":
                        return None
                    continue
                if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                        or info.st_mode & 0o077 or info.st_nlink != 1):
                    raise ValueError("group database files must be private, owned regular files")
            return sqlite3.connect(self.path.as_uri() + ("?mode=rw" if write else "?mode=ro"),
                                   uri=True, timeout=5, isolation_level=None)
        finally:
            os.close(directory)

    @contextmanager
    def _transaction(self, *, write=False, initialize=False):
        db = self._connect(write=write, initialize=initialize)
        if db is None:
            yield None
            return
        try:
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA foreign_keys = ON")
            if write:
                db.execute("PRAGMA synchronous = FULL")
            db.execute("BEGIN IMMEDIATE" if write else "BEGIN")
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version == 0 and not db.execute("SELECT 1 FROM sqlite_master LIMIT 1").fetchone():
                if not initialize:
                    yield None
                    return
                for statement in _SCHEMA:
                    db.execute(statement)
                db.execute(f"PRAGMA user_version = {_VERSION}")
            elif version != _VERSION:
                raise ValueError("unsupported group database schema")
            yield db
            db.commit()
        finally:
            db.close()

    @staticmethod
    def _require_manager(actor):
        if not actor.manage:
            raise GroupAccessError("group management is not authorized")

    @staticmethod
    def _require_group(db, group_id, actor, *, conversation=False):
        _matched(group_id, _GROUP_ID, "group id")
        if db is None:
            raise GroupAccessError("group is not available to this actor")
        if not conversation and actor.manage:
            group = db.execute("SELECT * FROM groups WHERE group_id = ?", (group_id,)).fetchone()
        else:
            group = db.execute(
                "SELECT g.* FROM groups g JOIN members m USING (group_id) "
                "WHERE g.group_id = ? AND m.session_id = ?", (group_id, actor.session_id)
            ).fetchone()
        if group is None:
            raise GroupAccessError("group is not available to this actor")
        return group

    @staticmethod
    def _describe(db, group):
        key = (group["group_id"],)
        return {
            **dict(group),
            "members": [dict(row) for row in db.execute(
                "SELECT session_id, added_at FROM members WHERE group_id = ? ORDER BY session_id", key
            )],
            "ledger_links": [{"ref": row["ref"], "lead": bool(row["lead"])} for row in db.execute(
                "SELECT ref, lead FROM ledger_links WHERE group_id = ? ORDER BY ref", key
            )],
        }

    def create_group(self, actor, name, *, role_key=None):
        self._require_manager(actor)
        _one_line(name, 160, "group name")
        if role_key is not None:
            _matched(role_key, _ROLE_KEY, "role key")
        group_id = f"group_{uuid4().hex}"
        with self._transaction(write=True, initialize=True) as db:
            db.execute("INSERT INTO groups (group_id, name, role_key, created_at) VALUES (?, ?, ?, ?)",
                       (group_id, name, role_key, _now()))
            return self._describe(db, self._require_group(db, group_id, actor))

    def get_group(self, actor, group_id):
        with self._transaction() as db:
            return self._describe(db, self._require_group(db, group_id, actor))

    def list_groups(self, actor, *, ledger_ref=None, source_ref=None):
        if ledger_ref is not None:
            _one_line(ledger_ref, 256, "ledger reference")
        if source_ref is not None:
            _one_line(source_ref, 256, "source reference")
        with self._transaction() as db:
            if db is None:
                return []
            rows = db.execute(
                "SELECT g.* FROM groups g "
                "WHERE (? OR EXISTS (SELECT 1 FROM members m WHERE m.group_id = g.group_id AND m.session_id = ?)) "
                "AND (? IS NULL OR EXISTS (SELECT 1 FROM ledger_links l WHERE l.group_id = g.group_id AND l.ref = ?)) "
                "AND (? IS NULL OR g.source_ref = ?) ORDER BY g.created_at, g.group_id",
                (actor.manage, actor.session_id, ledger_ref, ledger_ref, source_ref, source_ref)
            )
            return [self._describe(db, row) for row in rows]

    def import_graph(self, actor, snapshot, source, *, expected_digest=None):
        """Preview, or atomically import, a reviewed legacy snapshot without writing the graph."""
        self._require_manager(actor)
        plan = graph_import_plan(snapshot, source)
        digest = plan["plan_digest"]
        apply = expected_digest is not None
        if apply and expected_digest != digest:
            raise GroupConflictError("graph import plan digest does not match; preview again")
        if plan["conflicts"]:
            if apply:
                raise GroupConflictError("graph import has source conflicts; review the preview")
            return {**plan, "status": "conflict", "destination_conflicts": []}

        with self._transaction(write=apply, initialize=apply) as db:
            destination = []
            if db is not None:
                previous = db.execute("SELECT plan_digest FROM graph_imports WHERE source = ?", (source,)).fetchone()
                if previous is not None and previous["plan_digest"] == digest:
                    return {**plan, "status": "already_imported", "destination_conflicts": []}
                if previous is not None:
                    destination.append("graph source was already imported with a different plan")
                for group in plan["groups"]:
                    if db.execute("SELECT 1 FROM groups WHERE group_id = ? OR source_ref = ?",
                                  (group["group_id"], group["source_ref"])).fetchone():
                        destination.append(f"group already exists for {group['source_ref']}")
                    for link in group["ledger_links"]:
                        if self._ledger_lead(db, link["ref"]) is not None:
                            destination.append(f"ledger reference {link['ref']} already has a lead")
            if destination:
                if apply:
                    raise GroupConflictError("graph import has destination conflicts; review the preview")
                return {**plan, "status": "conflict", "destination_conflicts": destination}
            if not apply:
                return {**plan, "status": "ready", "destination_conflicts": []}
            at = _now()
            for group in plan["groups"]:
                key = group["group_id"]
                db.execute("INSERT INTO groups (group_id, name, source_ref, created_at) VALUES (?, ?, ?, ?)",
                           (key, group["name"], group["source_ref"], at))
                db.executemany("INSERT INTO members VALUES (?, ?, ?)",
                               ((key, session, at) for session in group["members"]))
                db.executemany("INSERT INTO ledger_links VALUES (?, ?, ?)",
                               ((key, link["ref"], link["lead"]) for link in group["ledger_links"]))
            db.execute("INSERT INTO graph_imports VALUES (?, ?)", (source, digest))
            return {**plan, "status": "imported", "destination_conflicts": []}

    def add_member(self, actor, group_id, session_id):
        self._require_manager(actor)
        _matched(session_id, _SESSION_ID, "session id")
        with self._transaction(write=True) as db:
            group = self._require_group(db, group_id, actor)
            cursor = db.execute("INSERT INTO members VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
                                (group_id, session_id, _now()))
            return {"group": self._describe(db, group), "changed": cursor.rowcount == 1}

    def remove_member(self, actor, group_id, session_id):
        self._require_manager(actor)
        _matched(session_id, _SESSION_ID, "session id")
        with self._transaction(write=True) as db:
            group = self._require_group(db, group_id, actor)
            cursor = db.execute("DELETE FROM members WHERE group_id = ? AND session_id = ?",
                                (group_id, session_id))
            return {"group": self._describe(db, group), "changed": cursor.rowcount == 1}

    def link_ledger(self, actor, group_id, ref, *, lead=None):
        self._require_manager(actor)
        _one_line(ref, 256, "ledger reference")
        if lead is not None and type(lead) is not bool:
            raise ValueError("ledger lead must be a boolean")
        with self._transaction(write=True) as db:
            self._require_group(db, group_id, actor)
            existing = db.execute("SELECT lead FROM ledger_links WHERE group_id = ? AND ref = ?",
                                  (group_id, ref)).fetchone()
            if lead:
                incumbent = self._ledger_lead(db, ref)
                if incumbent is not None and incumbent["group_id"] != group_id:
                    raise GroupConflictError("ledger reference already has a lead; use an explicit lead transfer")
            if existing is None:
                if lead is False:
                    raise GroupConflictError("ledger link does not exist")
                lead = bool(lead)
                db.execute("INSERT INTO ledger_links VALUES (?, ?, ?)", (group_id, ref, lead))
                changed = True
            else:
                current = bool(existing["lead"])
                lead = current if lead is None else lead
                changed = lead != current
                if changed:
                    db.execute("UPDATE ledger_links SET lead = ? WHERE group_id = ? AND ref = ?",
                               (lead, group_id, ref))
            return {"group_id": group_id, "ref": ref, "lead": lead, "changed": changed}

    @staticmethod
    def _ledger_lead(db, ref):
        return db.execute("SELECT group_id FROM ledger_links WHERE ref = ? AND lead = 1",
                          (ref,)).fetchone()

    def transfer_ledger_lead(self, actor, ref, *, from_group_id, to_group_id):
        self._require_manager(actor)
        _one_line(ref, 256, "ledger reference")
        _matched(from_group_id, _GROUP_ID, "expected lead group id")
        _matched(to_group_id, _GROUP_ID, "target lead group id")
        with self._transaction(write=True) as db:
            self._require_group(db, to_group_id, actor)
            incumbent = self._ledger_lead(db, ref)
            if incumbent is None or incumbent["group_id"] != from_group_id:
                raise GroupConflictError("expected ledger lead is no longer current")
            if not db.execute("SELECT 1 FROM ledger_links WHERE group_id = ? AND ref = ?",
                              (to_group_id, ref)).fetchone():
                raise GroupConflictError("target group must already be linked to the ledger reference")
            changed = from_group_id != to_group_id
            if changed:
                db.execute("UPDATE ledger_links SET lead = 0 WHERE group_id = ? AND ref = ?",
                           (from_group_id, ref))
                db.execute("UPDATE ledger_links SET lead = 1 WHERE group_id = ? AND ref = ?",
                           (to_group_id, ref))
            return {"group_id": to_group_id, "ref": ref, "lead": True, "changed": changed}

    def unlink_ledger(self, actor, group_id, ref):
        self._require_manager(actor)
        _one_line(ref, 256, "ledger reference")
        with self._transaction(write=True) as db:
            self._require_group(db, group_id, actor)
            incumbent = self._ledger_lead(db, ref)
            if incumbent is not None and incumbent["group_id"] == group_id:
                raise GroupConflictError("clear or transfer the ledger lead before unlinking")
            cursor = db.execute("DELETE FROM ledger_links WHERE group_id = ? AND ref = ?", (group_id, ref))
            return {"group_id": group_id, "ref": ref, "changed": cursor.rowcount == 1}

    def append_message(self, actor, group_id, message, *, message_id=None):
        if (not isinstance(message, str) or not 0 < len(message) <= 32_000
                or not message.strip() or "\0" in message):
            raise ValueError("message must contain 1 to 32000 characters and no NUL")
        message_id = uuid4().hex if message_id is None else _one_line(message_id, 128, "message id")
        with self._transaction(write=True) as db:
            self._require_group(db, group_id, actor, conversation=True)
            previous = db.execute("SELECT * FROM messages WHERE group_id = ? AND message_id = ?",
                                  (group_id, message_id)).fetchone()
            if previous is not None:
                if previous["message"] != message or previous["author_session_id"] != actor.session_id:
                    raise GroupConflictError("message id conflicts with an existing group message")
                return {"message": dict(previous), "duplicate": True}
            seq = db.execute("SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE group_id = ?",
                             (group_id,)).fetchone()[0]
            record = {"group_id": group_id, "seq": seq, "message_id": message_id,
                      "author_session_id": actor.session_id, "message": message, "created_at": _now()}
            db.execute("INSERT INTO messages VALUES (:group_id, :seq, :message_id, :author_session_id, "
                       ":message, :created_at)", record)
            return {"message": record, "duplicate": False}

    def history(self, actor, group_id, *, after=0, limit=50):
        if type(after) is not int or not 0 <= after < 2 ** 63:
            raise ValueError("history cursor must be a nonnegative sequence")
        if type(limit) is not int or not 1 <= limit <= 100:
            raise ValueError("history limit must be between 1 and 100")
        with self._transaction() as db:
            self._require_group(db, group_id, actor, conversation=True)
            rows = [dict(row) for row in db.execute(
                "SELECT * FROM messages WHERE group_id = ? AND seq > ? ORDER BY seq LIMIT ?",
                (group_id, after, limit + 1)
            )]
            messages = rows[:limit]
            return {"messages": messages, "next_after": messages[-1]["seq"] if messages else after,
                    "has_more": len(rows) > limit}
