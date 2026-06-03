#!/bin/bash
# setup-skills.sh — Install agent-mesh skills into the local AI runtime.
#
# Usage:
#   ./scripts/setup-skills.sh [--dry-run] [--skills-dir <path>]
#
# Auto-detects the skills directory by probing known runtime locations.
# Creates a symlink for each skill found in ./skills/.
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

# ── Make scripts executable ───────────────────────────────────────────────────
echo "→ Checking tmux-bridge scripts"
for f in "$REPO_ROOT"/packages/tmux-bridge/bin/*.sh; do
    if [[ ! -x "$f" ]]; then
        echo "  chmod +x $(basename "$f")"
        [[ "$DRY_RUN" == "false" ]] && chmod +x "$f"
    else
        echo "  ✓ $(basename "$f") already executable"
    fi
done
echo ""

# ── Install skill symlinks ────────────────────────────────────────────────────
echo "→ Installing skill symlinks"
for skill_path in "$SKILLS_SRC"/*/; do
    skill_name=$(basename "$skill_path")
    dest="$SKILLS_DIR/$skill_name"

    if [[ -L "$dest" && "$(readlink "$dest")" == "$skill_path" ]]; then
        echo "  ✓ $skill_name (already linked correctly)"
    elif [[ -L "$dest" ]]; then
        echo "  ~ $skill_name (symlink exists but points elsewhere — relinking)"
        if [[ "$DRY_RUN" == "false" ]]; then
            ln -sf "$skill_path" "$dest"
        fi
    elif [[ -e "$dest" ]]; then
        echo "  ⚠ $skill_name — target exists and is not a symlink; skipping"
    else
        echo "  + $skill_name → $dest"
        [[ "$DRY_RUN" == "false" ]] && ln -sf "$skill_path" "$dest"
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
