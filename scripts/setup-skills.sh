#!/bin/bash
# setup-skills.sh — Install agent-mesh skills into the local AI runtime.
#
# Usage:
#   ./scripts/setup-skills.sh [--dry-run] [--skills-dir <path>]
#
# Auto-detects the skills directory by probing known runtime locations.
# Installs each skill as a local directory copy and materializes openpack assets
# (tmux-bridge bin/ and agents/, plus the Mesh policy core) into the skill
# directory. This keeps Hermes
# skill loaders inside their trusted skills tree while preserving the bridge
# executables needed by the skill.
#
# Privacy: this script contains no secrets, host paths, IDs, or private config.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILLS_SRC="$REPO_ROOT/skills"
DRY_RUN=false
SKILLS_DIR=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run)    DRY_RUN=true; shift ;;
        --skills-dir) SKILLS_DIR="$2"; shift 2 ;;
        *) echo "Unknown argument: $1" >&2; exit 1 ;;
    esac
done

# ── Auto-detect skills directory ──────────────────────────────────────────────
if [[ -z "$SKILLS_DIR" ]]; then
    CANDIDATES=(
        "/opt/discode/runner-agent/resources/skills"
        "${HOME}/.claude/resources/skills"
        "${HOME}/.local/share/claude/skills"
    )
    for c in "${CANDIDATES[@]}"; do
        if [[ -d "$c" ]]; then
            SKILLS_DIR="$c"
            break
        fi
    done
fi

if [[ -z "$SKILLS_DIR" ]]; then
    echo "ERROR: could not auto-detect skills directory." >&2
    echo "Pass --skills-dir <path> explicitly." >&2
    exit 1
fi

echo "Repo root     : $REPO_ROOT"
echo "Skills source : $SKILLS_SRC"
echo "Skills target : $SKILLS_DIR"
[[ "$DRY_RUN" == "true" ]] && echo "(dry-run — no changes will be made)"
echo ""

copy_tree() {
    local src="$1"
    local dest="$2"
    if [[ "$DRY_RUN" == "true" ]]; then
        return 0
    fi
    mkdir -p "$dest"
    cp -a "$src"/. "$dest"/
}

# ── Check source scripts without mutating the repo ────────────────────────────
echo "→ Checking tmux-bridge source scripts"
for f in "$REPO_ROOT"/packages/tmux-bridge/bin/*.sh; do
    if [[ -x "$f" ]]; then
        echo "  ✓ $(basename "$f") executable"
    else
        echo "  ! $(basename "$f") not executable in repo; installed copy will be chmodded"
    fi
done
echo ""

# ── Install skills and materialized assets ────────────────────────────────────
echo "→ Installing skills"
mkdir -p "$SKILLS_DIR"
for skill_path in "$SKILLS_SRC"/*/; do
    skill_name=$(basename "$skill_path")
    dest="$SKILLS_DIR/$skill_name"

    if [[ -L "$dest" ]]; then
        echo "  ~ $skill_name (replacing symlink with trusted local copy)"
        [[ "$DRY_RUN" == "false" ]] && rm "$dest"
    elif [[ -d "$dest" ]]; then
        echo "  ~ $skill_name (updating existing local copy)"
    elif [[ -e "$dest" ]]; then
        echo "  ⚠ $skill_name — target exists and is not a directory/symlink; skipping"
        continue
    else
        echo "  + $skill_name → $dest"
    fi

    copy_tree "$skill_path" "$dest"

    if [[ "$skill_name" == "agent-tmux" ]]; then
        echo "    + materialize tmux-bridge bin/, agents/, and Mesh policy assets"
        copy_tree "$REPO_ROOT/packages/tmux-bridge/bin" "$dest/bin"
        copy_tree "$REPO_ROOT/packages/tmux-bridge/agents" "$dest/agents"
        copy_tree "$REPO_ROOT/packages/tmux-bridge/lib" "$dest/lib"
        if [[ "$DRY_RUN" == "false" ]]; then
            mkdir -p "$dest/lib"
            cp "$REPO_ROOT/packages/core/src/policy.js" "$dest/lib/policy.js"
            cp "$REPO_ROOT/packages/core/src/session-link.js" "$dest/lib/session-link.js"
            chmod +x "$dest"/bin/*.sh "$dest"/bin/*.py "$dest"/bin/*.mjs 2>/dev/null || true
        fi
    fi
done
echo ""

# ── Summary ───────────────────────────────────────────────────────────────────
if [[ "$DRY_RUN" == "true" ]]; then
    echo "Dry-run complete. Re-run without --dry-run to apply."
else
    echo "Setup complete."
    echo ""
    echo "Available agent configs:"
    for conf in "$REPO_ROOT"/packages/tmux-bridge/agents/*.conf; do
        agent=$(basename "$conf" .conf)
        bin_name=$(grep '^AGENT_BIN=' "$conf" | cut -d= -f2 | tr -d '"')
        available="✗ not found"
        command -v "$bin_name" &>/dev/null && available="✓ $(command -v "$bin_name")"
        printf "  [%-12s] %s\n" "$available" "$agent ($bin_name)"
    done
    echo ""
    echo "Set AGENT_MESH_ROOT=\"$REPO_ROOT\" in your shell profile to use the bridge."
fi
