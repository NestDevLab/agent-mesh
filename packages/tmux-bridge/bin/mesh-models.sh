#!/usr/bin/env bash
# mesh-models.sh — Report advertised harness models and advisory mesh pin drift.
#
# Usage:
#   mesh-models.sh [--agent <type> | --all] [--json] [--refresh]
#
# This command is report-only: it never changes an agent config, a mesh pin, or
# a harness configuration file. Its only mutation is the seen-model cache under
# ${XDG_STATE_HOME:-$HOME/.local/state}/agent-mesh/models-seen/.
#
# Cache policy: ordinary text runs add advertised models to the seen set after
# reporting NEW entries. --refresh explicitly replaces that set with the current
# probe result. --json is read-only unless paired with --refresh, so a scheduled
# reader cannot accidentally consume novelties before a human sees them.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENTS_DIR="$SCRIPT_DIR/../agents"
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
    PIN_STATUS="none"

    local pin_env="${AGENT_PIN_ENABLE_ENV:-}"
    local pin_value=""
    local model_env="${AGENT_PIN_MODEL_ENV:-}"
    local model_value=""

    [[ -n "$pin_env" ]] || return 0
    pin_value="${!pin_env-}"
    if [[ "$pin_value" == "0" ]]; then
        PIN_STATUS="disabled"
        return
    fi

    CURRENT_PIN="${AGENT_PIN_DEFAULT_MODEL:-}"
    [[ -n "$model_env" ]] && model_value="${!model_env-}"
    [[ -n "$model_value" ]] && CURRENT_PIN="$model_value"
    [[ -n "$CURRENT_PIN" ]] && PIN_STATUS="enabled"
}

split_model_token() {
    local model="$1"
    MODEL_FAMILY=""
    MODEL_MAJOR=""
    MODEL_MINOR=""
    MODEL_VARIANT=""
    if [[ "$model" =~ ^(.+)-([0-9]+)(\.([0-9]+))?(-(.+))?$ ]]; then
        MODEL_FAMILY="${BASH_REMATCH[1]}"
        MODEL_MAJOR="${BASH_REMATCH[2]}"
        MODEL_MINOR="${BASH_REMATCH[4]:-0}"
        MODEL_VARIANT="${BASH_REMATCH[6]:-}"
    fi
}

assess_stale_pin() {
    local pin="$1"
    shift

    STALE_PIN="not-applicable"
    STALE_NOTE="no bridge pin configured"
    [[ -n "$pin" ]] || return 0

    STALE_PIN="current"
    STALE_NOTE="no newer family hint"
    split_model_token "$pin"
    local pin_family="$MODEL_FAMILY"
    local pin_major="$MODEL_MAJOR"
    local pin_minor="$MODEL_MINOR"
    local candidate candidate_family candidate_major candidate_minor candidate_variant

    for candidate in "$@"; do
        [[ "$candidate" == "$pin" ]] && continue
        split_model_token "$candidate"
        candidate_family="$MODEL_FAMILY"
        candidate_major="$MODEL_MAJOR"
        candidate_minor="$MODEL_MINOR"
        candidate_variant="$MODEL_VARIANT"

        if [[ -n "$pin_family" && "$candidate_family" == "$pin_family" ]]; then
            if (( 10#$candidate_major > 10#$pin_major )) \
                || { (( 10#$candidate_major == 10#$pin_major )) \
                    && (( 10#$candidate_minor > 10#$pin_minor )); }; then
                STALE_PIN="review"
                STALE_NOTE="advisory: $candidate has a higher $pin_family version than $pin"
                return
            fi
            if (( 10#$candidate_major == 10#$pin_major )) \
                && (( 10#$candidate_minor == 10#$pin_minor )) \
                && [[ -n "$candidate_variant" ]]; then
                STALE_PIN="review"
                STALE_NOTE="advisory: $candidate is a different $pin_family-$pin_major.$pin_minor variant; review"
                return
            fi
        elif [[ -n "$pin_family" && "$candidate" == "$pin_family-"* ]]; then
            STALE_PIN="review"
            STALE_NOTE="advisory: $candidate may be related to $pin; review"
            return
        fi
    done
}

emit_json_item() {
    local agent="$1" probe="$2" pin="$3" pin_status="$4" stale="$5" note="$6" cache_action="$7"
    local advertised_blob="$8" new_blob="$9"

    python3 - "$agent" "$probe" "$pin" "$pin_status" "$stale" "$note" "$cache_action" \
        "$advertised_blob" "$new_blob" <<'PY'
import json
import sys

def lines(value):
    return [line for line in value.splitlines() if line]

agent, probe, pin, pin_status, stale, note, cache_action, advertised, new = sys.argv[1:]
print(json.dumps({
    "agent": agent,
    "probe": probe,
    "advertised_models": lines(advertised),
    "new_models": lines(new),
    "pinned_model": pin or None,
    "pin_status": pin_status,
    "stale_pin": stale,
    "stale_pin_note": note,
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
    advertised=()
    if [[ -z "${AGENT_MODELS_PROBE_CMD:-}" ]]; then
        probe_status="unavailable"
    else
        if ! probe_output="$(bash -c "$AGENT_MODELS_PROBE_CMD")"; then
            die "model probe failed for agent '$agent'"
        fi
        while IFS= read -r model; do
            [[ -n "$model" ]] && advertised+=("$model")
        done <<< "$probe_output"
        dedupe_models advertised "${advertised[@]}"
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

        for model in "${advertised[@]}"; do
            found="false"
            for seen_model in "${seen[@]}"; do
                [[ "$model" == "$seen_model" ]] && { found="true"; break; }
            done
            [[ "$found" == "true" ]] || new+=("$model")
        done

        if [[ "$AS_JSON" != "true" || "$REFRESH" == "true" ]]; then
            if [[ "$REFRESH" == "true" ]]; then
                write_seen_models "$cache_file" "${advertised[@]}" \
                    || die "could not refresh seen-model cache for agent '$agent'"
                cache_action="refreshed"
            else
                write_seen_models "$cache_file" "${seen[@]}" "${advertised[@]}" \
                    || die "could not update seen-model cache for agent '$agent'"
                cache_action="updated"
            fi
        else
            cache_action="read-only"
        fi
    fi

    if [[ "$probe_status" == "available" ]]; then
        assess_stale_pin "$CURRENT_PIN" "${advertised[@]}"
    else
        STALE_PIN="not-applicable"
        STALE_NOTE="no probe available"
    fi

    advertised_blob="$(printf '%s\n' "${advertised[@]}")"
    new_blob="$(printf '%s\n' "${new[@]}")"
    if [[ "$AS_JSON" == "true" ]]; then
        JSON_ITEMS+=("$(emit_json_item "$agent" "$probe_status" "$CURRENT_PIN" "$PIN_STATUS" \
            "$STALE_PIN" "$STALE_NOTE" "$cache_action" "$advertised_blob" "$new_blob")")
    else
        if [[ "$probe_status" == "unavailable" ]]; then
            printf '%s: no probe available\n' "$agent"
        else
            printf '%s:\n' "$agent"
            printf '  ADVERTISED: %s\n' "$(join_models "${advertised[@]}")"
        fi
        printf '  NEW: %s\n' "$(join_models "${new[@]}")"
        printf '  PINNED: %s\n' "${CURRENT_PIN:-none}"
        printf '  STALE-PIN: %s (%s)\n' "$STALE_PIN" "$STALE_NOTE"
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
