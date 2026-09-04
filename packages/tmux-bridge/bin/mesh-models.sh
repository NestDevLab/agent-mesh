#!/usr/bin/env bash
# mesh-models.sh — Report app-nudged models and bridge-pin deprecation status.
#
# Usage:
#   mesh-models.sh [--agent <type> | --all] [--json] [--refresh]
#
# This command is report-only: it never changes an agent config, a mesh pin, or
# a harness configuration file. Its only mutation is the seen-model cache under
# ${XDG_STATE_HOME:-$HOME/.local/state}/agent-mesh/models-seen/.
#
# Cache policy: ordinary text runs add app-nudged models to the seen set after
# reporting NEW-TO-MESH entries. --refresh explicitly replaces that set with the
# current probe result. --json is read-only unless paired with --refresh, so a
# scheduled reader cannot accidentally consume novelties before a human sees them.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENTS_DIR="${AGENT_MESH_AGENTS_DIR:-$SCRIPT_DIR/../agents}"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/agent-mesh/models-seen"

AS_JSON="false"
REFRESH="false"
ALL="false"
AGENT_FILTER=""

usage() {
    sed -n '/^# mesh-models.sh/,/^$/p' "$0" | sed 's/^# \{0,1\}//'
}

die() {
    echo "ERROR: $*" >&2
    exit 1
}

join_models() {
    local IFS=", "
    if [[ $# -eq 0 ]]; then
        printf 'none'
    else
        printf '%s' "$*"
    fi
}

read_seen_models() {
    local cache_file="$1"
    [[ -e "$cache_file" ]] || return 0
    [[ -r "$cache_file" ]] || {
        echo "cache is unreadable: $cache_file" >&2
        return 1
    }

    python3 - "$cache_file" <<'PY'
import json
import sys

try:
    with open(sys.argv[1], encoding="utf-8") as handle:
        data = json.load(handle)
except (OSError, json.JSONDecodeError) as exc:
    raise SystemExit(f"invalid models cache: {exc}")

models = data.get("models") if isinstance(data, dict) else None
if not isinstance(models, list) or not all(isinstance(model, str) for model in models):
    raise SystemExit("invalid models cache: expected an object with a string models array")

for model in models:
    if model:
        print(model)
PY
}

write_seen_models() {
    local cache_file="$1"
    shift

    python3 - "$cache_file" "$@" <<'PY'
import json
import os
from pathlib import Path
import sys
import tempfile

path = Path(sys.argv[1])
models = sorted(set(model for model in sys.argv[2:] if model))
path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
try:
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        json.dump({"models": models}, handle, sort_keys=True)
        handle.write("\n")
    os.replace(temporary, path)
except BaseException:
    try:
        os.unlink(temporary)
    except OSError:
        pass
    raise
PY
}

dedupe_models() {
    local -n destination="$1"
    shift
    if [[ $# -eq 0 ]]; then
        destination=()
        return
    fi
    mapfile -t destination < <(printf '%s\n' "$@" | awk 'NF' | LC_ALL=C sort -u)
}

resolve_pin() {
    CURRENT_PIN=""
    PIN_MODE="none"

    local pin_env="${AGENT_PIN_ENABLE_ENV:-}"
    local pin_value=""
    local model_env="${AGENT_PIN_MODEL_ENV:-}"
    local model_value=""

    [[ -n "$pin_env" ]] || return 0
    pin_value="${!pin_env-}"
    if [[ "$pin_value" == "0" ]]; then
        PIN_MODE="disabled"
        return
    fi

    CURRENT_PIN="${AGENT_PIN_DEFAULT_MODEL:-}"
    [[ -n "$model_env" ]] && model_value="${!model_env-}"
    [[ -n "$model_value" ]] && CURRENT_PIN="$model_value"
    [[ -n "$CURRENT_PIN" ]] && PIN_MODE="enabled"
}

parse_model_probe() {
    local probe_output="$1"
    [[ -n "${probe_output//[[:space:]]/}" ]] || return 0

    python3 - "$probe_output" <<'PY'
import json
import sys

try:
    payload = json.loads(sys.argv[1])
except json.JSONDecodeError as exc:
    raise SystemExit(f"invalid model probe output: {exc}")

if not isinstance(payload, dict):
    raise SystemExit("invalid model probe output: expected an object")

nudged = payload.get("nudged_new_models", [])
if not isinstance(nudged, list) or not all(isinstance(model, str) for model in nudged):
    raise SystemExit("invalid model probe output: nudged_new_models must be a string array")
for model in sorted(set(filter(None, nudged))):
    print(f"nudge\t{model}")

desktop = payload.get("desktop_selected_model")
if desktop is not None:
    if not isinstance(desktop, str):
        raise SystemExit("invalid model probe output: desktop_selected_model must be a string or null")
    if desktop:
        print(f"desktop\t{desktop}")

migrations = payload.get("model_migrations", {})
if not isinstance(migrations, dict) or not all(
    isinstance(old, str) and isinstance(new, str) for old, new in migrations.items()
):
    raise SystemExit("invalid model probe output: model_migrations must be a string map")
for old, new in sorted(migrations.items()):
    if old and new:
        print(f"migration\t{old}\t{new}")
PY
}

assess_pin_status() {
    local pin="$1"
    shift

    PIN_HEALTH_STATUS="not-applicable"
    PIN_HEALTH_NOTE="no bridge pin configured"
    PIN_MIGRATION_TARGET=""
    [[ -n "$pin" ]] || return 0

    local migration
    for migration in "$@"; do
        if [[ "$migration" == "$pin"$'\t'* ]]; then
            PIN_MIGRATION_TARGET="${migration#*$'\t'}"
            PIN_HEALTH_STATUS="deprecated"
            PIN_HEALTH_NOTE="$pin -> $PIN_MIGRATION_TARGET (deprecated)"
            return
        fi
    done

    PIN_HEALTH_STATUS="ok"
    PIN_HEALTH_NOTE="no deprecation signal"
}

emit_json_item() {
    local agent="$1" probe="$2" pin="$3" pin_mode="$4" pin_status="$5" pin_note="$6"
    local pin_target="$7" cache_action="$8" nudged_blob="$9" new_blob="${10}" desktop_model="${11}"

    python3 - "$agent" "$probe" "$pin" "$pin_mode" "$pin_status" "$pin_note" "$pin_target" \
        "$cache_action" "$nudged_blob" "$new_blob" "$desktop_model" <<'PY'
import json
import sys

def lines(value):
    return [line for line in value.splitlines() if line]

agent, probe, pin, pin_mode, pin_status, pin_note, pin_target, cache_action, nudged, new, desktop = sys.argv[1:]
print(json.dumps({
    "agent": agent,
    "probe": probe,
    "nudged_new_models": lines(nudged),
    "new_nudged_models": lines(new),
    "desktop_selected_model": desktop or None,
    "pinned_model": pin or None,
    "pin_mode": pin_mode,
    "pin_status": pin_status,
    "pin_status_note": pin_note,
    "pin_migration_target": pin_target or None,
    "cache_action": cache_action,
}, separators=(",", ":")))
PY
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --agent)
            [[ $# -ge 2 ]] || die "--agent requires a type"
            [[ -z "$AGENT_FILTER" ]] || die "--agent may be supplied once"
            AGENT_FILTER="$2"
            shift 2
            ;;
        --all)
            ALL="true"
            shift
            ;;
        --json)
            AS_JSON="true"
            shift
            ;;
        --refresh)
            REFRESH="true"
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            die "unknown argument '$1'"
            ;;
    esac
done

[[ "$ALL" != "true" || -z "$AGENT_FILTER" ]] || die "--all cannot be combined with --agent"

TARGETS=()
if [[ -n "$AGENT_FILTER" ]]; then
    [[ "$AGENT_FILTER" =~ ^[A-Za-z0-9_.-]+$ ]] || die "invalid agent '$AGENT_FILTER'"
    [[ -r "$AGENTS_DIR/$AGENT_FILTER.conf" ]] || die "no readable config for agent '$AGENT_FILTER'"
    TARGETS=("$AGENT_FILTER")
else
    shopt -s nullglob
    for conf in "$AGENTS_DIR"/*.conf; do
        [[ -r "$conf" ]] || die "agent config is unreadable: $conf"
        TARGETS+=("$(basename "$conf" .conf)")
    done
    shopt -u nullglob
    [[ ${#TARGETS[@]} -gt 0 ]] || die "no agent configs found"
fi

JSON_ITEMS=()
for agent in "${TARGETS[@]}"; do
    conf="$AGENTS_DIR/$agent.conf"
    [[ -r "$conf" ]] || die "no readable config for agent '$agent'"

    unset AGENT_MODELS_PROBE_CMD AGENT_PIN_DEFAULT_MODEL AGENT_PIN_MODEL_ENV AGENT_PIN_ENABLE_ENV
    # shellcheck source=/dev/null
    source "$conf"

    resolve_pin
    probe_status="available"
    nudged=()
    migrations=()
    desktop_selected_model=""
    if [[ -z "${AGENT_MODELS_PROBE_CMD:-}" ]]; then
        probe_status="unavailable"
    else
        if ! probe_output="$(bash -c "$AGENT_MODELS_PROBE_CMD")"; then
            die "model probe failed for agent '$agent'"
        fi
        if ! probe_records="$(parse_model_probe "$probe_output")"; then
            die "invalid model probe output for agent '$agent'"
        fi
        while IFS=$'\t' read -r kind model target; do
            [[ -n "$kind" ]] || continue
            case "$kind" in
                nudge) [[ -n "$model" ]] && nudged+=("$model") ;;
                desktop) desktop_selected_model="$model" ;;
                migration) [[ -n "$model" && -n "$target" ]] && migrations+=("$model"$'\t'"$target") ;;
                *) die "invalid model probe record for agent '$agent'" ;;
            esac
        done <<< "$probe_records"
        dedupe_models nudged "${nudged[@]}"
    fi

    seen=()
    new=()
    cache_action="not-applicable"
    if [[ "$probe_status" == "available" ]]; then
        cache_file="$STATE_DIR/$agent.json"
        if ! seen_output="$(read_seen_models "$cache_file")"; then
            die "could not read seen-model cache for agent '$agent'"
        fi
        while IFS= read -r model; do
            [[ -n "$model" ]] && seen+=("$model")
        done <<< "$seen_output"
        dedupe_models seen "${seen[@]}"

        for model in "${nudged[@]}"; do
            found="false"
            for seen_model in "${seen[@]}"; do
                [[ "$model" == "$seen_model" ]] && { found="true"; break; }
            done
            [[ "$found" == "true" ]] || new+=("$model")
        done

        if [[ "$AS_JSON" != "true" || "$REFRESH" == "true" ]]; then
            if [[ "$REFRESH" == "true" ]]; then
                write_seen_models "$cache_file" "${nudged[@]}" \
                    || die "could not refresh seen-model cache for agent '$agent'"
                cache_action="refreshed"
            else
                write_seen_models "$cache_file" "${seen[@]}" "${nudged[@]}" \
                    || die "could not update seen-model cache for agent '$agent'"
                cache_action="updated"
            fi
        else
            cache_action="read-only"
        fi
    fi

    if [[ "$probe_status" == "available" ]]; then
        assess_pin_status "$CURRENT_PIN" "${migrations[@]}"
    else
        PIN_HEALTH_STATUS="unknown"
        PIN_HEALTH_NOTE="no deprecation probe available"
        PIN_MIGRATION_TARGET=""
    fi

    nudged_blob="$(printf '%s\n' "${nudged[@]}")"
    new_blob="$(printf '%s\n' "${new[@]}")"
    if [[ "$AS_JSON" == "true" ]]; then
        JSON_ITEMS+=("$(emit_json_item "$agent" "$probe_status" "$CURRENT_PIN" "$PIN_MODE" \
            "$PIN_HEALTH_STATUS" "$PIN_HEALTH_NOTE" "$PIN_MIGRATION_TARGET" "$cache_action" \
            "$nudged_blob" "$new_blob" "$desktop_selected_model")")
    else
        if [[ "$probe_status" == "unavailable" ]]; then
            printf '%s: no probe available\n' "$agent"
        else
            printf '%s:\n' "$agent"
            printf '  NUDGED-NEW: %s\n' "$(join_models "${nudged[@]}")"
            printf '  DESKTOP-SELECTED: %s\n' "${desktop_selected_model:-none}"
        fi
        printf '  NEW-TO-MESH: %s\n' "$(join_models "${new[@]}")"
        printf '  PINNED: %s\n' "${CURRENT_PIN:-none}"
        if [[ "$PIN_HEALTH_STATUS" == "deprecated" ]]; then
            printf '  STALE-PIN: %s\n' "$PIN_HEALTH_NOTE"
        else
            printf '  PIN-STATUS: %s (%s)\n' "$PIN_HEALTH_STATUS" "$PIN_HEALTH_NOTE"
        fi
        printf '  CACHE: %s\n' "$cache_action"
    fi
done

if [[ "$AS_JSON" == "true" ]]; then
    printf '{"agents":['
    for index in "${!JSON_ITEMS[@]}"; do
        [[ "$index" -eq 0 ]] || printf ','
        printf '%s' "${JSON_ITEMS[$index]}"
    done
    printf ']}\n'
fi
