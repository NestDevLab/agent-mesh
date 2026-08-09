# _mesh-tmux.sh — shared tmux invocation for the agent-mesh bridge.
# Sourced by agent-session.sh / agent-send.sh / agent-read.sh. Not executable.
#
# Why this exists: the bridge must NOT use the user's default tmux server.
# Sharing the default server means a) the user's own tmux usage and b) concurrent
# smoke tests can race against live agent sessions — and because tmux defaults to
# `exit-empty on`, the moment that shared server has zero sessions it self-
# destructs, taking every live agent session with it. (That is exactly the
# incident this guard prevents.)
#
# Fix: route all mesh tmux calls through a DEDICATED named socket and disable
# exit-empty so the server never self-terminates when transiently empty.
#
# Override the socket name with MESH_TMUX_SOCKET (e.g. tests use a throwaway one).

: "${MESH_TMUX_SOCKET:=mesh}"

# Wrapper: every bridge tmux call goes through the dedicated socket.
mtmux() {
    tmux -L "$MESH_TMUX_SOCKET" "$@"
}

# Make the dedicated server refuse to self-destruct when it becomes empty.
#
# IMPORTANT: this must be called AFTER at least one session exists. A bare
# `start-server` on an empty server cannot help — with the default
# `exit-empty on`, tmux starts and then immediately exits because it has no
# session, so the option can never be set on it. Once a session exists the
# server is alive and the option sticks (and persists across later emptiness).
mesh_tmux_harden() {
    mtmux set-option -s exit-empty off 2>/dev/null || true
}

# Print pane lines that are new since the previous capture. The caller chooses
# the output file descriptor: agent-send uses stderr (2), agent-read uses
# stdout (1). Working/spinner lines and unchanged repaint content are omitted.
mesh_stream_pane_delta() {
    local current="$1" previous="$2" output_fd="${3:-1}" line
    [[ "$current" == "$previous" ]] && return 0
    while IFS= read -r line; do
        [[ -z "$line" ]] && continue
        if [[ -n "${AGENT_WORKING_PATTERN:-}" ]] \
           && grep -Eq "$AGENT_WORKING_PATTERN" <<<"$line"; then
            continue
        fi
        if [[ -n "$previous" ]] && grep -Fqx -- "$line" <<<"$previous"; then
            continue
        fi
        printf '%s\n' "$line" >&"$output_fd"
    done <<< "$current"
}

# True when the pane's visible tail shows a pending interactive approval
# dialog (AGENT_APPROVAL_PATTERN; agents without one always return false).
# Tail-anchored on the last non-blank lines: a pending dialog ends with its
# confirm footer, while answered-dialog text higher up the pane must not
# re-trigger. Callers treat this state as blocked-on-a-human — never answer
# the dialog by sending keys.
mesh_pane_approval_pending() {
    [[ -n "${AGENT_APPROVAL_PATTERN:-}" ]] || return 1
    printf '%s\n' "$1" \
        | grep -vE '^[[:space:]]*$' \
        | tail -n "${AGENT_APPROVAL_TAIL_LINES:-5}" \
        | grep -qE "$AGENT_APPROVAL_PATTERN"
}

# Small per-target bridge state. Keep it outside the repo: this is runtime glue
# such as a pending launch title that should be consumed by the first send.
mesh_state_dir() {
    local base
    if [[ -n "${XDG_RUNTIME_DIR:-}" ]]; then
        base="$XDG_RUNTIME_DIR/agent-mesh"
    else
        base="${TMPDIR:-/tmp}/agent-mesh-$(id -u)"
    fi
    mkdir -p "$base"
    printf '%s\n' "$base"
}

mesh_state_key() {
    printf '%s' "$1" | tr -cs 'A-Za-z0-9_.-' '_' | sed 's/^_//; s/_$//'
}

mesh_pending_title_file() {
    local target="$1" key
    key="$(mesh_state_key "${MESH_TMUX_SOCKET}-${target}")"
    printf '%s/pending-title-%s.txt\n' "$(mesh_state_dir)" "$key"
}
