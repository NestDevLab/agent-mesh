# Run receipts and missed-run checks

`bin/agent-run-receipt.py` gives unattended jobs (cron, timers, inbox wakes, relays) a shared
receipt format and reports jobs that stopped producing evidence. It only reports; it never
restarts, kills, or reschedules anything.

## Record a run

```bash
agent-run-receipt.py record --job nightly-audit --trigger timer --outcome acted|noop|blocked|failed \
  [--session <id>] [--started-at <iso>] [--note <text>]
```

Receipts are appended to `$AGENT_RUNS_DIR/<YYYY-MM-DD>.jsonl` (default
`$XDG_STATE_HOME/agent-runs`, else `~/.local/state/agent-runs`) with schema
`agent-mesh.run-receipt.v1`.

## Check a watch list

```json
{
  "jobs": [
    {"name": "nightly-audit", "maxAgeHours": 26},
    {"name": "weekly-guard", "maxAgeHours": 170, "path": "~/.local/state/weekly-guard/receipts/*.json",
     "expect": {"status": "guarded"}}
  ]
}
```

A job without `path` is judged by its latest receipt. A job with `path` is judged by the newest
matching file's mtime, so jobs that already write their own output need no change. `expect`
compares dotted fields of that newest file when it is JSON.

```bash
agent-run-receipt.py check --config watch.json [--alerts-only] [--now <iso>]
```

Prints one `agent-mesh.run-check.v1` line per job with `status`: `ok`, `missed` (older than
`maxAgeHours`), `never` (no evidence), `unexpected` (an `expect` field differs) or `failed` (latest
receipt outcome). Exit codes: `0` all ok, `2` at least one job needs attention, `1` invalid watch
list.
