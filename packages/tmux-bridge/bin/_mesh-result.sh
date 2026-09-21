#!/usr/bin/env bash
# Pure helpers for extracting a correlated result from tmux scrollback.

mesh_result_segment() {
    local prompt="$1" prompt_char="$2" correlated="$3"
    awk -v prompt="$prompt" -v pc="$prompt_char" -v correlated="$correlated" '
        ((correlated != "" && index($0, prompt)) || (correlated == "" && $0 ~ pc && index($0, prompt))) { found=1; next }
        found && $0 ~ pc { exit }
        found { print }
    '
}

mesh_result_marker_count() {
    local marker="$1"
    awk -v marker="$marker" '
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
