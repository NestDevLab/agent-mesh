#!/usr/bin/env bash
# Pure collector regression: no live agent or tmux session is touched.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../bin/_mesh-result.sh
source "$SCRIPT_DIR/../bin/_mesh-result.sh"

marker_id="0123456789abcdef"
begin="[[R:$marker_id]]"
end="[[/R:$marker_id]]"
printf -v trailing '%*s' 200000 ''
scrollback="header
❯ [MESH:$marker_id] Use the result protocol shown on the next line.
Final result markers: $begin ... $end
assistant: $begin expected reply $end
❯ next prompt
$trailing"
segment="$(mesh_result_segment "[MESH:$marker_id]" '❯' "$marker_id" <<<"$scrollback")"
[[ "$segment" == *"expected reply"* && "$segment" != *"next prompt"* ]] \
    || { echo "FAIL: correlated segment was not bounded" >&2; exit 1; }
[[ "$(mesh_result_marker_count "$begin" <<<"$segment")" == "2" ]] \
    || { echo "FAIL: result begin markers were not counted" >&2; exit 1; }
[[ "$(mesh_result_marker_count "$end" <<<"$segment")" == "2" ]] \
    || { echo "FAIL: result end markers were not counted" >&2; exit 1; }
[[ "$(mesh_result_marker_count "$begin" <<<"no result markers")" == "0" ]] \
    || { echo "FAIL: a missing marker did not count as zero" >&2; exit 1; }
[[ "$(mesh_result_marker_count "$begin" <<<"$begin$begin")" == "2" ]] \
    || { echo "FAIL: repeated markers on one line were not counted" >&2; exit 1; }

echo "PASS: correlated result extraction and absent-marker handling"
