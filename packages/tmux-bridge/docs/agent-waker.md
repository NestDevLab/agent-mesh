# agent-waker

`bin/agent-waker.py` replaces in-session polling crons. A systemd user timer runs it; it runs a
cheap producer with no model and wakes the owning session through `agent-native-call.mjs` only
when the producer reports something.

```bash
agent-waker.py run --job daily --session <UUID> --managed-inbox-root <ROOT> -- <producer> [args]
```

- The producer prints `{"new": [...], "errors": [...]}` and owns its own cursor, so every `new`
  item is reported once.
- Nothing new and no new error: no wake, `noop` receipt.
- New items: one note listing them, `acted` receipt. If the bridge refuses (exit 78 or any other
  non-queued code), the items stay pending in `$XDG_STATE_HOME/agent-waker/<job>.json` and are
  sent with the next run (`blocked` receipt, exit 3).
- Errors, an unusable producer report, or an unreadable state file wake the session once per
  distinct error set; nothing is dropped silently.
- Overlapping runs are skipped through a lock next to the state file.
