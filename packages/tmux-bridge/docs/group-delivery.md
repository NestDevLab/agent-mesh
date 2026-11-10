# Group delivery

`mesh-group-send.py` is a trusted-local adapter for the group store. A caller
provides a group member identity, a stable message ID and an explicitly ordered
list of other group members. The message is read on standard input. The local
caller is responsible for authenticating the actor; this CLI is not a remotely
authenticated API.

```sh
printf '%s' 'Please check this.' | mesh-group-send.py \
  --state /path/to/group-state --as-session codex:<sender-uuid> \
  --group group_<id> --message-id message-1 \
  --to claude:<primary-uuid> --to codex:<fallback-uuid> \
  --managed-inbox-root /path/to/managed-inboxes
```

The group message is appended idempotently before dispatch. The dispatch store
records an intent before invoking a transport. Reusing the same ID with different
content, sender or destination list is rejected. Reusing it after a receipt never
starts a second delivery. The adapter treats a process interruption or an
ambiguous result as unknown and never resends automatically. A held or accepted
receipt is not evidence that a session read or responded to the message.

Fallback is allowed only when the recipient is proven unavailable and delivery
did not begin. For local Claude, the adapter recognizes a pre-delivery refusal
only when an exact receipt also reports a complete ownership scan with no
writer. A missing managed inbox by itself reports `blocked` and never causes a
fallback. Codex-to-Claude fallback and any other unavailable status require a
transport that can provide the same evidence; ambiguous results never switch.
An injectable transport's tests do not prove real provider availability or
delivery. Cloud destinations require an authenticated provider binding.

The SQLite delivery store coordinates callers on the same state directory and
host. It is not a distributed or cross-host lease, and it does not establish
that the recipient has synchronized or read the group history.
