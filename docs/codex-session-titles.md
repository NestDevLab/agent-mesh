# Codex Session Titles

## Preferred: launch title through the bridge

Codex CLI 0.143.0 does not expose a `--title` or `--name` flag on `codex`,
`codex resume`, `codex app-server`, or `codex remote-control`. Codex Desktop
does track a user-facing thread name internally, and the generated app-server
protocol includes `thread/name/set`, but that path is not exposed as a stable
bridge-friendly CLI operation.

For bridge-created Codex sessions, use:

```bash
TARGET=$($BIN/agent-session.sh --agent codex \
  --title "agent-mesh: review tmux adapter" \
  new "$WORKTREE" mesh-codex-review)
```

The bridge stores the title as pending runtime state for that tmux target.
`agent-send.sh` consumes it once and prepends it as the first line of the first
real prompt. Codex Desktop derives the visible title from the first user message,
so this gives a readable title without editing Codex's SQLite state and without
restarting the Desktop app.

Limits:

- The title appears when the first prompt is sent, not while the session is still
  empty.
- The title line is part of the first user message, so choose a short descriptive
  phrase that is safe to include in context.
- Extra Codex CLI flags still go after `--`; if Codex adds an official title flag
  later, prefer passing that through instead.

## Fallback: rename through Codex state DB

Use this only for already-created sessions when the launch-title path was not
available. Codex Desktop caches thread metadata; after editing the database, the
new title is visible in Desktop only after restarting the app.

Current observed storage:

- DB: `${CODEX_HOME:-$HOME/.codex}/state_5.sqlite`
- Table: `threads`
- Key: `threads.id` is the session/thread UUID
- Title: `threads.title`
- Useful context column: `threads.first_user_message`

Safe fallback procedure:

```bash
DB="${CODEX_HOME:-$HOME/.codex}/state_5.sqlite"
THREAD_ID="019f..."
NEW_TITLE="agent-mesh: readable title"
BACKUP="${DB}.$(date -u +%Y%m%dT%H%M%SZ).bak"

sqlite3 "$DB" "VACUUM INTO '$BACKUP';"

python3 - "$DB" "$THREAD_ID" "$NEW_TITLE" <<'PY'
import sqlite3
import sys

db, thread_id, title = sys.argv[1:4]
with sqlite3.connect(db) as conn:
    cur = conn.execute(
        "UPDATE threads SET title=? WHERE id=?",
        (title, thread_id),
    )
    if cur.rowcount != 1:
        raise SystemExit(f"expected one thread update, got {cur.rowcount}")
    row = conn.execute(
        "SELECT id, title, first_user_message FROM threads WHERE id=?",
        (thread_id,),
    ).fetchone()
    print(row)
PY
```

Do this only when no Codex turn is actively writing that thread. Keep the backup
until the title is verified, then restart Codex Desktop to clear its cached view.
