#!/usr/bin/env bash
# agent-spawn.sh — one governed Limen route-and-launch entry point.
#
# This command delegates to agent-session.sh, which delegates route, lease,
# renewal, and completion lifecycle work to mesh-capacity-dispatch.mjs. Do not
# replace that dispatcher with direct Limen calls here.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROFILE=""
LIMEN_CONFIG=""
ARGS=("$@")

while [[ $# -gt 0 ]]; do
    case "$1" in
        --profile)
            [[ $# -ge 2 && -n "${2:-}" ]] || { echo "ERROR: --profile requires a non-empty value" >&2; exit 1; }
            PROFILE="$2"
            shift 2
            ;;
        --limen-config)
            [[ $# -ge 2 && -n "${2:-}" ]] || { echo "ERROR: --limen-config requires a non-empty value" >&2; exit 1; }
            LIMEN_CONFIG="$2"
            shift 2
            ;;
        --)
            break
            ;;
        *)
            shift
            ;;
    esac
done

[[ -n "$PROFILE" && -n "$LIMEN_CONFIG" ]] || {
    echo "usage: agent-spawn.sh --agent codex|claude --profile ROLE_OR_PROFILE --limen-config POLICY new|resume ..." >&2
    exit 2
}

exec "$SCRIPT_DIR/agent-session.sh" "${ARGS[@]}"
