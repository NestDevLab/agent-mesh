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

Use `run --delivery-only` for notification jobs. The native call still validates the managed
inbox, single writer and watcher before appending and syncing the record, then returns zero
without asking the recipient to produce result markers. This proves queuing only. Result
collection remains the default. Successful delivery saves `lastDelivery.itemKeys` (the
SHA-256 of sorted-key JSON, UTF-8 with ensure_ascii=False, first 16 hex digits),
`correlationId` and `at` in the waker state so a producer can retain its checkpoint until
transport acknowledgement. Refused delivery keeps pending items and the previous acknowledgement.

For an idle Codex owner, explicit `--agent codex --resume` forwards native
`--resume` through the existing transport and communications gate. It is opt-in;
Claude resume is rejected. A queue receipt still does not prove an actor response.

Delivery-only acknowledgement requires native JSON `status: queued` without
`held: true`. Held, refused, malformed or missing receipts retain pending items
and the previous `lastDelivery`, even when the process exits zero. Result mode
keeps its existing result/timeout exit contract; explicit held receipts still
fail closed. This adapter check does not drain or bypass the communications gate.
