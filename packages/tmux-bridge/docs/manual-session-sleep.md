# Manual session sleep checkpoint

`bin/session-sleep.py` records a manually authorized context restart. It keeps
one JSON checkpoint per attempt in
`${XDG_STATE_HOME:-$HOME/.local/state}/agent-mesh/manual-sleep`. The directory
and files are owner-private. The file carries the source native ID, working
directory, sleep/nap mode, restart context, and timestamped receipts. Keep
credentials, transcripts and large artifacts elsewhere.

This standalone `agent-mesh.manual-sleep.v1` format has no channel, trigger or
scheduler fields. Its input is a JSON object with four string arrays:

```json
{
  "work": ["Review the active change in the current branch."],
  "decisions": ["Confirm the destination before publishing."],
  "nextSteps": ["Inspect the verification results."],
  "references": ["docs/checklist.md"]
}
```

```sh
python3 "$BIN/session-sleep.py" prepare --source "$SOURCE" --cwd "$WORKSPACE" --mode sleep < "$CHECKPOINT"
python3 "$BIN/session-sleep.py" begin "$OPERATION" --surface "$SURFACE"
python3 "$BIN/session-sleep.py" read "$OPERATION"
```

`SOURCE` is `claude:<uuid>` or `codex:<uuid>`. Save the operation ID
returned by `prepare`. `begin` reserves the current terminal for a same-surface
Claude clear, or a fresh bridge target for Codex. Start the native operation once
after that receipt. An open attempt blocks a second prepare for the same source.
If delivery or launch is ambiguous, record `uncertain --evidence <observation>`
and reconcile the same attempt. Use `abort --evidence <observation>` only when
no transition happened or before invoking the native operation.

The receiving session reads the checkpoint and checks the worktree and current
authority before using it. After independently verifying the native session,
surface, working directory and state readback, record:

```sh
python3 "$BIN/session-sleep.py" resume "$OPERATION" --session "$CURRENT" \
  --surface "$SURFACE" --cwd "$WORKSPACE" --token "$READBACK_TOKEN" --evidence "$PROOF"
```

The token correlates readback with the checkpoint. Native identity, clear or
launch evidence must come from the runtime. Claude may allocate a new
conversation UUID in the same terminal. Codex requires a distinct thread.
The state record issues no native commands.

For Codex, publish the successor link as the predecessor's final reply after
verified resume. An authorized observer records `link --evidence <readback>`
after verifying that reply, then uses the approved native archive procedure.
Record `archive --evidence <native archive proof>` only after native archive
readback. For Claude, `resumed` completes the attempt. A complete receipt stores
the UTC observation time, outcome and evidence, including the new Codex ID.
