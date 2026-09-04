#!/usr/bin/env bash
# agent-spawn.sh — one governed Limen route-and-launch entry point.
#
# This command delegates to agent-session.sh, which delegates route, lease,
# renewal, and completion lifecycle work to mesh-capacity-dispatch.mjs. Do not
# replace that dispatcher with direct Limen calls here.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROFILE=""
MODEL=""
EFFORT=""
LIMEN_CONFIG=""
FORCE="false"
ARGS=("$@")

while [[ $# -gt 0 ]]; do
    case "$1" in
        --profile)
            [[ $# -ge 2 && -n "${2:-}" ]] || { echo "ERROR: --profile requires a non-empty value" >&2; exit 1; }
            PROFILE="$2"
            shift 2
            ;;
        --model)
            [[ $# -ge 2 && -n "${2:-}" ]] || { echo "ERROR: --model requires a non-empty value" >&2; exit 1; }
            MODEL="$2"
            shift 2
            ;;
        --effort)
            [[ $# -ge 2 && -n "${2:-}" ]] || { echo "ERROR: --effort requires a non-empty value" >&2; exit 1; }
            EFFORT="$2"
            shift 2
            ;;
        --limen-config)
            [[ $# -ge 2 && -n "${2:-}" ]] || { echo "ERROR: --limen-config requires a non-empty value" >&2; exit 1; }
            LIMEN_CONFIG="$2"
            shift 2
            ;;
        --force)
            FORCE="true"
            shift
            ;;
        --)
            break
            ;;
        *)
            shift
            ;;
    esac
done

if [[ -n "$PROFILE" && ( -n "$MODEL" || -n "$EFFORT" ) ]]; then
    echo "ERROR: --profile cannot be combined with --model or --effort" >&2
    exit 2
fi
if [[ ( -n "$MODEL" && -z "$EFFORT" ) || ( -z "$MODEL" && -n "$EFFORT" ) ]]; then
    echo "ERROR: exact persistent routing requires both --model and --effort" >&2
    exit 2
fi
[[ -n "$PROFILE" || ( -n "$MODEL" && -n "$EFFORT" ) ]] || {
    echo "usage: agent-spawn.sh --agent codex|claude (--profile ROLE_OR_PROFILE | --model MODEL --effort EFFORT) --limen-config POLICY [--force] new|resume ..." >&2
    exit 2
}
[[ -n "$LIMEN_CONFIG" ]] || {
    echo "ERROR: governed persistent routing requires --limen-config; Limen policy selection must be explicit" >&2
    exit 2
}
if [[ "$FORCE" == "true" && ( -z "$MODEL" || -z "$EFFORT" || -n "$PROFILE" ) ]]; then
    echo "ERROR: --force requires the exact --model and --effort pair" >&2
    exit 2
fi

exec "$SCRIPT_DIR/agent-session.sh" "${ARGS[@]}"
