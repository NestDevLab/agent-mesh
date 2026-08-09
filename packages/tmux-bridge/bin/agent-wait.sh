#!/bin/bash
# agent-wait.sh — Block until an AI agent CLI turn finishes (or the session dies).
#
# Usage:
#   agent-wait.sh --agent <NAME> <TMUX_TARGET> [--timeout SECONDS] [--poll SECONDS] [--settle SECONDS] [--stall SECONDS]
#
# --agent defaults to "codex".
# Prints ONE final state line and exits:
#   idle      -> turn finished (ready for next prompt)   exit 0
#   error     -> error pattern detected on the pane      exit 0
#   dead      -> tmux session no longer exists           exit 3
#   progress  -> checkpoint reached, pane changed recently  exit 4
#   approval-pending -> agent blocked on an interactive approval dialog exit 6
#   stalled   -> checkpoint reached, no recent pane activity exit 124
#
# Why this exists: the Monitor tool proved unreliable at watching the bridge's
# dedicated tmux socket. This is the proven mechanism — a plain poll loop run via
# `run_in_background` that fires exactly one completion event. It also breaks on
# session death, so it never hangs the way a bare `until grep` loop does when the
# pane disappears. The timeout is a checkpoint, not a hard "give up": if the
# other agent is still producing output, return progress so the caller LLM can
# decide whether to keep waiting, report status to the user, or intervene.
#
# Turn-done detection (in priority order):
#   1. session gone                          -> dead
#   2. AGENT_DONE_PATTERN present (if set)    -> idle   (explicit marker, e.g. "Worked for")
#   3. was working, now not working          -> idle   (working->idle transition)
#   4. error pattern while not working       -> error

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENTS_DIR="$SCRIPT_DIR/../agents"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/_mesh-tmux.sh"

AGENT_NAME="codex"
TIMEOUT=1800
POLL=8
SETTLE=20
STALL=300
ARGS=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --agent)   AGENT_NAME="$2"; shift 2 ;;
        --timeout) TIMEOUT="$2";    shift 2 ;;
        --poll)    POLL="$2";       shift 2 ;;
        --settle)  SETTLE="$2";     shift 2 ;;
        --stall)   STALL="$2";      shift 2 ;;
        *)         ARGS+=("$1");    shift ;;
    esac
done
set -- "${ARGS[@]:-}"

CONF="$AGENTS_DIR/${AGENT_NAME}.conf"
[[ -f "$CONF" ]] || { echo "ERROR: no config for agent '$AGENT_NAME'" >&2; exit 1; }
# shellcheck source=/dev/null
source "$CONF"

TARGET="${1:-}"
[[ -z "$TARGET" ]] && { echo "ERROR: TMUX_TARGET required" >&2; exit 1; }

# Optional explicit "turn done" marker (set in the agent .conf). Empty = unused.
DONE_PATTERN="${AGENT_DONE_PATTERN:-}"

start="$(date +%s)"
seen_working=0
last_activity="$start"
last_hash=""

while true; do
    now="$(date +%s)"
    if ! mtmux has-session -t "$TARGET" 2>/dev/null; then
        echo "dead"; exit 3
    fi

    pane="$(mtmux capture-pane -t "$TARGET" -p 2>/dev/null || true)"
    pane_hash="$(printf '%s' "$pane" | cksum | awk '{print $1 ":" $2}')"
    if [[ -z "$last_hash" ]]; then
        last_hash="$pane_hash"
    elif [[ "$pane_hash" != "$last_hash" ]]; then
        last_hash="$pane_hash"
        last_activity="$now"
    fi

    # A pending approval dialog blocks the turn indefinitely: only a human can
    # answer it, so report it instead of letting the wait ride to a checkpoint.
    if mesh_pane_approval_pending "$pane"; then
        echo "approval-pending"; exit 6
    fi

    if echo "$pane" | grep -qE "$AGENT_WORKING_PATTERN"; then
        seen_working=1
    else
        # Not currently working — decide whether the turn is actually done.
        if [[ -n "$DONE_PATTERN" ]] && echo "$pane" | grep -qE "$DONE_PATTERN"; then
            echo "idle"; exit 0
        fi
        if [[ "$seen_working" -eq 1 ]]; then
            echo "idle"; exit 0
        fi
        if echo "$pane" | grep -qiE "error|failed|exception"; then
            echo "error"; exit 0
        fi
        # Not seen working yet: give a short settle window for the turn to start,
        # then (if a done marker exists and shows) treat as done; otherwise keep
        # waiting until timeout rather than returning prematurely.
        if [[ -n "$DONE_PATTERN" ]] && (( now - start > SETTLE )) \
           && echo "$pane" | grep -qE "$DONE_PATTERN"; then
            echo "idle"; exit 0
        fi
    fi

    if (( now - start > TIMEOUT )); then
        inactive=$(( now - last_activity ))
        if (( inactive <= STALL )); then
            echo "progress elapsed=$(( now - start )) inactive=${inactive}"; exit 4
        fi
        echo "stalled elapsed=$(( now - start )) inactive=${inactive}"; exit 124
    fi
    sleep "$POLL"
done
