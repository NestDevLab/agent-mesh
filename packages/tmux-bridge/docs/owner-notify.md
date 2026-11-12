# Owning-thread turn notices

`agent-owner-notify.py --config PRIVATE.json` observes Codex rollouts with an
independent durable cursor. Set `ownerNotify` in the lifecycle beat config to
run it before every beat tick, including ticks waiting for aggregate delivery.
The host schedules the beat (typically every five minutes). No model, new agent,
resume, session interrupt or transport discovery is used.

Private configuration:

```json
{
  "managedInboxRoot": "/example/managed-inboxes",
  "fallbackSession": "22222222-2222-4222-8222-222222222222",
  "excludeRefs": [],
  "excludeWorkRefs": ["work:EXAMPLE-EXCLUDED"],
  "excludeDomains": [],
  "excludeTitlePatterns": ["Example protected work"],
  "excludePromptPrefixes": ["Example excluded task:"],
  "noise": {"promptPrefixes": ["[example-probe]"]}
}
```

Optional `stateRoot`, `launchEvents` and `graphPath` override the XDG defaults.
Keep real recipients, protected task identities and paths in private host config.
The initial run arms existing files at their last complete record; it does not
replay old results. Subsequent ticks read appended records, guarding replacement
and truncation through the shared follower cursor implementation.

Launch IDs join `launch.started.caller` to `launch.thread_resolved.threadId`.
A valid launch owner takes priority over active graph `spawned-by` and
`delegates-to` edges. An ambiguous graph has no owner. Unknown owners and owners
without a verified live inbox watcher route to the configured fallback with
`owner-unknown` or `owner-dead`. A dead fallback retains the notice for retry.
Noise/probe sources, explicit work exclusions and self echoes produce skipped
receipts. Exclusions do not depend on aggregate beat self/exclude filters.

Each notice carries thread/turn, tmux target when known, rollout path, final
excerpt (300 characters), and status. Native errors take priority; formal
questions and final messages ending in `?` classify as questions. Structured
native goal receipts for the same thread classify complete as achieved and
blocked/budget/usage limits as blocked. Ordinary completions are results.
Goal prose is not interpreted as a native state transition.

The default `$XDG_STATE_HOME/agent-mesh/owner-notify/receipts.jsonl` records routed,
fallback, skipped and pending outcomes with reasons. Successful means inbox
append acknowledged, never owner execution. Deduplication uses thread plus turn;
notifications are saved before advancing delivery, and a deterministic native
`deliveryId` recovers an append followed by a crash before receipt persistence.
Do not delete inbox records while an owner-notify delivery is pending.

Receipt history is streamed without loading the whole file. Pending outcomes are
recorded once per notice per outcome/reason pair, remembered in persisted state;
delivery still retries every tick and records a final receipt on success. Routing
fields are saved before delivery only when they change.

A torn final receipt is preserved in `receipt-fragments.jsonl` before repair. Repair checks the final byte and scans backward only to the last
newline when the tail is torn; complete history is left intact.
After a refused delivery, a now-dead owner can fall back; an existing native
inbox append is recovered before changing that recipient.
