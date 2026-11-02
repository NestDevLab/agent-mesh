# Lifecycle beat and decision interview

`bin/agent-lifecycle-beat.py` is a cheap JSON producer for the existing native
waker. It observes incremental native follow events, storage-owned ledger
changes and native job receipts. It does not send, resume, archive, parse
transcripts, read native databases, scan ledger folders or run a model.

```sh
python3 bin/agent-lifecycle-beat.py --config policy.json
python3 bin/agent-lifecycle-beat.py --config policy.json --full
python3 bin/agent-lifecycle-beat.py interview --config policy.json --output interview.json --inventory inventory.json
```

The default mode prints one `{"new": [...], "errors": [...]}` object. An explicit
`--state DIRECTORY` overrides the producer state root. `--full` requests the
initial ledger snapshot; without it, the native null cursor establishes a
quiet baseline. It is sent only on the first page, never on continuation pages.
Existing ledger consumers remain independent.

## Private configuration

Host policy belongs outside this package. Paths refer to authorized private
files/directories; no accounts or topology are embedded in the generic source.

| Field | Meaning |
| --- | --- |
| `stateRoot` | Producer metadata/report root; default native follow state path for `lifecycle-beat` |
| `followerRoot` | Existing native follower root; otherwise `follow.state_dir(followerName)` |
| `followerName` | Native follower name; default `lifecycle` |
| `followConfig` | Existing native follow policy, passed unchanged to `follow.tick` |
| `selfRef` | Current session reference passed to native follow and excluded from consumer output |
| `excludeRefs` | Additional consumer exclusions for all event/card/interview inputs |
| `decisionDestination` | Host-owned decision owner/target included in full reports and compact items when cards exist |
| `ledgerScheme` | Configured native Mesh ledger adapter scheme; absent adapter is quiet |
| `maxLedgerPages` | Work bound per poll, integer 1–50; default 5 pages of 200 |
| `wakerState` | Existing waker JSON state whose `lastDelivery.itemKeys` acknowledges reports |
| `summarySeconds` | Ordinary summary interval; default 1800 seconds |
| `timezone` | Decision calendar timezone; default `UTC` |
| `nextMorningHour`, `intervalDays` | Decision reminder policy; defaults 9 and 2 |
| `projectMap` | Explicit domain-to-project display mapping |
| `labels`, `questionTemplate` | Presentation configuration for native decision cards |
| `guardSentence` | Optional exact host-authored source guard; no generated consent |
| `whereByRef` | Explicit source-location overrides |
| `nativeWhere` | Explicit per-harness source-location templates for interview questions, using `{id}`/`{ref}` |
| `jobs` | Native `agent-run-receipt.check_job` definitions, including host thresholds/windows |

Native job checks retain their own receipt/path evidence rules. The beat stores
only semantic health hashes, ignoring changing age/check timestamps. It does
not invent a second job-health state machine. Fixed source faults use an active
condition signature: repetition while the same fault is active stays quiet,
and the same fault after a successful recovery can wake again. The enclosing waker records the
beat job outcome through existing native run receipts.

## Noise policy and complete reports

Immediate facts are `ERROR`, `NOREPLY`, `STALLED`, explicit nonempty `REPLY`
completions of kind `task` or `thread`, new/changed/due human decision cards,
and semantic beat/job/lifecycle failures. Other discovery events, including
`NEW` and `CLOSED`, are not immediate alerts. Native duplicate markers for one
session/turn/completion collapse into one fact.

Ordinary nonempty replies retain only the latest one-line detail per session,
limited to 320 characters. The first ordinary change starts a 30 minute window;
there is no empty summary. Unchanged details do not reappear after acknowledgement.
A delivered summary clears its buffer only after native waker acknowledgement.
Unchanged decision questions never become ordinary 30 minute reminders; their
calendar schedule belongs to `agent-decisions.py`.

The engine publishes action outcomes into the same native follow outbox with
`kind: LIFECYCLE` and a structured `payload`. `failure` phase or failed/blocked
status is immediate; queued/submitted status is ordinary summary material.
Native observation fingerprints distinguish genuinely different failed actions.
Failure facts also retain the structured native reason, so a changed cause for
the same observation is visible rather than suppressed.
Formal native follow `QUESTION` rows also produce immediate decision cards.
The producer checks the official follow cursor under its lock: only the latest
active formal question survives, and human input/new-turn events clear it. A
failed tick retains uncertain question sequence numbers for a later successful
observer tick. Metadata/project/location lookup reuses cached `session_source`
only for active questions, without native inventory polling. Native question
reminders use separate metadata and recheck that same official pending cursor.
Consumer `excludeRefs` and `selfRef` filter all events and interviews, including
previously buffered ordinary details, to prevent observer feedback loops.
Fleet must not tail engine action files as a second event path.

A full immutable JSON report is written before producer output. Compact waker
items put the absolute report path first and contain counts, keeping complete
cards out of truncated message lines. Reports contain full decision objects
with source-exact recommended sentences or explicit open-source actions,
options and `discuss: true`. Missing source sentences remain `sourceGap: true`;
no consent sentence is synthesized. When the recommended action is a source
sentence, `joseph_sentence` repeats that exact action value verbatim for host
compatibility. A source gap omits the alias and recommends opening the source.

## Source and delivery transactions

The producer uses a separate lock from native follow. `follow.tick` owns its
normal lock; subsequent outbox reads acquire `follow.locked(state.lock)` again.
This also protects native partial-tail repair against concurrent engine appends.
No direct tailer or parallel session identity store is added.

Ledger data uses the native `mesh-ledger` module's `adapters`, `invoke` and
`checked` APIs, with the unchanged `changes`/`describe` contract. The producer
owns the `lifecycle-beat` consumer only. Bounded pages stage a candidate opaque
cursor. Partial error pages retain the previous canonical cursor and report a
fixed error, never adapter diagnostics. Pagination continues from the previous
page's candidate cursor, without restarting a full snapshot.

The durable report and pending producer state are persisted **before** exact
cursor compare-and-swap through native `cursor_store`/`save`. There is no second
cursor authority. A cursor can advance after durable outbox staging because the
staged report owns delivery from then on. A conflict never overwrites a newer
native cursor. Crash recovery retries the exact cursor intent; an already
committed cursor is accepted. A conflicting staged cursor intent remains pending
even after waker acknowledgement; neither reminder delivery state nor summary
clearing commits until the exact native intent succeeds. This applies to quiet
baseline conflicts too. After acknowledgement, replaying an older page
is harmless because semantic card hashes suppress duplicate delivery.

While a report is unacknowledged, producer invocations return the exact same
compact items and do not poll ledger consumers or advance reminder delivery
state. Native follow can still tick and accumulate events. The expected item
keys come from native `agent-waker.item_key`; acknowledgement requires all keys
in configured `wakerState.lastDelivery.itemKeys`. Only then are candidate
reminder state, delivered event hashes and summary clearing committed. Without
a configured acknowledgement path, reports remain pending deliberately.

State contains processed outbox sequence, bounded semantic hashes, latest
ordinary summary details, human membership refs and reminder metadata. It does
not copy ledger items or create a task store. Reports are immutable delivery
artifacts. Explicit done/cancelled/deleted/nonhuman states and authoritative
missing descriptions forget human membership; absence from a delta does not.
Due reminders describe only `agent-decisions.due_ids` refs. Calendar morning,
two-day backoff and DST behavior are delegated to the decision library.
Directories are 0700, state/reports 0600, with atomic replacement and fsync.

## Interview export

`interview` defaults to native consumer `lifecycle-interview`; `--consumer`
selects another dedicated consumer. It uses a separate child state directory
unless `--state` is explicitly supplied. Use `--full` once to bootstrap all
current human waits; later exports consume native deltas and describe known
human membership refs. There are no folder/body searches. The output is one
JSON file ordered by urgency, due time and reference. Exporting a file does
not acknowledge a reminder delivery.

An optional previously generated native `--inventory` contributes only explicit
`lifecycle.pendingQuestion: true` plus nonempty `lifecycle.question` facts.
Casual punctuation never becomes a decision. Full Codex native UUIDs support
`codex://threads/UUID`; Claude needs a configured supported location. Unknown
locations are reported as source gaps, without guessing cloud IDs. Native
questions are also immediate producer inputs through formal follow events;
the five-minute producer does not fetch full native inventories.

## Observed stalled turns and limits

Native follow now preserves normalized `turn_id`, completion, outcome and error
fields. Native watch facts retain the normalized `last_event_id` alongside
`last_human_at`. Starting a Codex turn clears same-body human deduplication;
Claude deduplicates repeated human wrappers only while its turn is active, so
an identical continuation after completion still represents new work.
`followConfig.follower.observeStalledAlerts: true` opts observed sessions
into the existing stalled-turn threshold; the default observe behavior is
unchanged. `stalledMinutes` remains host policy. Growth timestamps survive
no-growth reads, and native outbox IDs suppress duplicate alerts.

This version starts pre-existing observed sessions at the native end cursor.
It cannot prove an already-active initial turn against a matching canonical
source mtime from the exposed source contract, so it deliberately does not seed
that turn from possibly stale graph facts. Alerts work after an actually
observed task-start/user event. This initial observation gap is explicit; no
transcript replay or new parser is introduced to disguise it. Async question
normalization also recognizes the runtime's `title` alias.

Run the synthetic suites in an integration checkout:

```sh
python3 packages/tmux-bridge/test/lifecycle-beat.test.py
python3 packages/tmux-bridge/bin/agent-follow.test.py
```

They cover ordinary deferral, completion/error deduplication, quiet ticks,
acknowledgement, full report preservation, exact cursor CAS and partial errors,
explicit decisions and calendar delegation, job semantic failures, native tool
question export, lock discipline and opt-in stalled observation. Live waker
wiring, host policy and any recovery/migration remain separate validation.
