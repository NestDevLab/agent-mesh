# Managed idle-session expiry

`bin/agent-idle-expiry.py` is a small, stateful expiry pass for persistent
Agent Mesh sessions. It is deliberately not a daemon and installs no scheduler.
An operator may invoke it periodically from an approved scheduler; adding that
scheduler is a separate runtime-operation decision.

It only considers sessions on the bridge's dedicated `MESH_TMUX_SOCKET` (default
`mesh`) whose names match the bridge-owned `<prefix>-<agent>` or
`<prefix>-<agent>-…` convention. The default agent set is `codex` and `claude`.
Each candidate must have exactly one pane, a configured live agent process, and
a successful `agent-read.sh --status` result. It never uses tmux key injection.

## Lifecycle

1. Each periodic `--execute` pass reads the agent-specific bridge classifier.
   `working`, `approval-pending`, and `error` reset the idle observation; none
   can be expired. An unreadable pane, missing live agent process, multi-pane
   session, invalid state file, or status uncertainty also prevents expiry.
2. For `idle`, it stores `idle_since` only after a successful observation. The
   next observation must arrive within `--max-check-gap-seconds`; otherwise the
   clock starts again. This is continuous *observed* idleness, not a tmux-only
   creation-time timer.
3. After `--idle-seconds`, the target enters a grace checkpoint. A later pass
   after `--grace-seconds` re-reads the pane identity and status before closing.
4. The reaper persists `close-pending` before calling the managed
   `agent-session.sh … kill` path, then confirms that the target disappeared.
   If dispatch or confirmation is uncertain, it records `close-uncertain` and
   never retries automatically for that pane identity.

The managed close removes the single tmux session/pane but does not delete the
Codex or Claude transcript. A later `agent-session.sh --agent … resume <id>`
can reopen the persisted conversation.

## Inspection and execution

Inspection is the default and never writes state or closes anything:

```bash
BIN=packages/tmux-bridge/bin
$BIN/agent-idle-expiry.py --json
$BIN/agent-idle-expiry.py --agent codex --target mesh-codex-review
```

An approved periodic job uses `--execute`. The default is a five-hour threshold,
five-minute grace, and a 15-minute maximum sampling gap; run often enough to
stay within that gap (for example, every five minutes):

```bash
$BIN/agent-idle-expiry.py --execute
```

Use `--state <path>` to choose the runtime state file. By default it is
`$XDG_STATE_HOME/agent-mesh/idle-expiry.json` (or
`~/.local/state/agent-mesh/idle-expiry.json`) and is atomically written with
mode `0600`; its lock file prevents concurrent expiry passes. Do not put this
state in the repository.

| Option / environment | Default | Meaning |
|---|---:|---|
| `--idle-seconds` / `MESH_IDLE_EXPIRY_SECONDS` | `18000` | Required continuously observed idle time |
| `--grace-seconds` / `MESH_IDLE_EXPIRY_GRACE_SECONDS` | `300` | Delay before the final re-check |
| `--max-check-gap-seconds` / `MESH_IDLE_EXPIRY_MAX_CHECK_GAP_SECONDS` | `900` | Largest allowed gap between observations |
| `--agent` | `codex`, `claude` | Configured agent type; repeatable |
| `--target` | all managed targets | Restrict to named managed target; repeatable |
| `--delivery-guard` / `MESH_IDLE_EXPIRY_DELIVERY_GUARD` | unset | Existing file blocks all expiry passes for possible delivery uncertainty |
| `--execute` | off | Persist observations and allow one managed close |

`--dry-run` explicitly requests inspection-only behavior. There is intentionally
no force or automatic retry option: resolve a `close-uncertain` record by
inspecting the session and state, then use an explicit operator action if needed.

## Validation

Run the focused isolated-socket regression test:

```bash
python3 packages/tmux-bridge/scripts/idle-expiry-test.py
```

It proves inspection is non-writing, a continuously idle single pane closes only
after the grace checkpoint, and working, approval-pending, error, delivery-guard,
and multi-pane targets remain open.
