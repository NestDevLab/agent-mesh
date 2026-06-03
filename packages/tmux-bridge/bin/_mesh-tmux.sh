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
