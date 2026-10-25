#!/usr/bin/env bash
# Pure helpers for extracting a correlated result from tmux scrollback.

# Some minimal namespaces expose a dangling distro alternatives link for awk.
# Use only known POSIX implementations that pass a functional probe; no env override.
mesh_result_awk() {
    local candidate
    for candidate in awk mawk nawk; do
        if command -v "$candidate" >/dev/null 2>&1 \
            && command "$candidate" 'BEGIN { exit 0 }' </dev/null >/dev/null 2>&1; then
            command "$candidate" "$@"
            return
        fi
    done
    echo "ERROR: no working POSIX awk implementation is available" >&2
    return 127
}

mesh_result_segment() {
    local prompt="$1" prompt_char="$2" correlated="$3"
    mesh_result_awk -v prompt="$prompt" -v pc="$prompt_char" -v correlated="$correlated" '
        ((correlated != "" && index($0, prompt)) || (correlated == "" && $0 ~ pc && index($0, prompt))) { found=1; next }
        found && $0 ~ pc { exit }
        found { print }
    '
}

mesh_result_marker_count() {
    local marker="$1"
    mesh_result_awk -v marker="$marker" '
        {
            line=$0
            while ((at=index(line, marker)) > 0) {
                count++
                line=substr(line, at + length(marker))
            }
        }
        END { print count + 0 }
    '
}

# Codex may retain the anchor while folding the echoed protocol template.
# Require one assistant-framed current-token pair, with at most one exact template
# before it; never infer a result from plain text or repeated candidate pairs.
mesh_result_codex_anchorless() {
    local begin="$1" end="$2"
    mesh_result_awk -v begin="$begin" -v end="$end" '
        function occurrences(line, marker, n, at) {
            n=0; while ((at=index(line, marker)) > 0) { n++; line=substr(line, at+length(marker)) } return n
        }
        {
            line=$0; sub(/^[ \t]+/, "", line)
            if (!started && line == "Final result markers: " begin " ... " end) {
                templates++; if (templates>1) invalid=1
                next
            }
            begins+=occurrences($0,begin); ends+=occurrences($0,end)
            if (!started && index($0,begin)) {
                if (index($0,"• " begin) != 1) invalid=1
                started=1; line=substr($0,length("• " begin)+1)
                if (index(line,end)) { candidate=substr(line,1,index(line,end)-1); completed=1 }
                else { buffer=line; collecting=1 }
                next
            }
            if (!started && index($0,end)) invalid=1
            if (collecting) {
                if (index($0,"•")==1 || index($0,"›")==1) invalid=1
                if (index($0,end)) {
                    head=substr($0,1,index($0,end)-1)
                    candidate=buffer (buffer=="" ? "" : ORS) head
                    completed=1; collecting=0
                } else buffer=buffer (buffer=="" ? "" : ORS) $0
            }
        }
        END {
            if (invalid || begins!=1 || ends!=1 || !completed || collecting || candidate !~ /[^[:space:]]/) exit 1
            print candidate
        }
    '
}
