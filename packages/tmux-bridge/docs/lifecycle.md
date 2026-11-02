# Native lifecycle engine

`bin/agent-lifecycle.py` inventories native sessions through Mesh, produces a
persisted plan and optionally queues bounded continuation work. It never reads
SQLite or transcript content. Mesh owns discovery, native identities, link
coverage and lineage. There is no second identity registry.

```sh
python3 bin/agent-lifecycle.py inventory --config policy.json --run-dir runs/one
python3 bin/agent-lifecycle.py plan --config policy.json --run-dir runs/two --full
python3 bin/agent-lifecycle.py apply --config policy.json --run-dir runs/two --apply
```

`inventory` and `plan` both persist a complete classified inventory and proposed
plan, without resuming work. `--full` requests an official full Mesh sweep;
normal runs use its incremental cache. Neither operation migrates the graph.
`apply` consumes the existing immutable plan, checks its digest, configuration
and inventory binding, and requires explicit `--apply`. Use a new run directory
for each observation. Apply can be repeated for recovery, but recorded attempts
are never blindly repeated.

## Host policy

Configuration is a private JSON object. No host policy is embedded here.

| Field | Meaning |
| --- | --- |
| `consumer` | Stable consumer name; default `lifecycle` |
| `projectRoots` | Array of `{root,project}`; longest matching absolute root wins |
| `allowedProjects` | Projects eligible for operative continuation; default empty |
| `archiveProjects` | Projects eligible for archive proposals; default empty |
| `permanentRefs`, `permanentPrefixes` | Protected native or linked opaque refs |
| `permanentPatterns` | Case insensitive protected-topic regular expressions |
| `excludeRefs`, `excludePatterns` | Explicit exclusions, retained in approval report |
| `selfRef` | Current native session identity, protected from intervention |
| `maxResumes` | Total existing-thread resumes plus handoffs, integer 0–3; default 0 |
| `maxArchives` | Accepted policy limit, but this version performs no archives |
| `idleSeconds` | Minimum native inactivity, default 3600 |
| `continuationPatterns` | Explicit continuation evidence for completed idle turns |
| `humanWaitPatterns` | Human-wait evidence that blocks continuation |
| `timezone` | Passed to the host resume-window guard; default `UTC` |
| `resumeWindowCommand` | Required JSON guard argv before each operative action |
| `handoffProfile` | Must be `developer` to enable governed Codex child handoffs |
| `limenConfig` | Host-owned explicit policy path for those handoffs |

The window command receives `{session,planDigest,at,timezone}` on stdin and
must return `{allow:true,reason:"..."}` with exit 0. Missing, failed, malformed,
unknown or denied results block continuation. The host implements weekly reset
window policy here; the engine does not infer account credits or reset times.

Native helper argv can be supplied via `meshCommand`, `nativeGuardCommand`,
`writerCommand`, `nativeCallCommand`, `sessionCommand`, `sendCommand` and
`runReceiptCommand`. Defaults resolve existing helpers beside this script.
These are host-owned adapter commands, useful for synthetic fixtures and
installation layouts. No command is passed through a shell string. This module
never selects a raw model or overrides a live session's lease.

## Complete classification and planning

The inventory runs `mesh-graph sweep [--full] --json`, then pages the local
`query search` API at limit 200 until its cursor ends. All returned identities
remain counted, including archived, closed, noise, excluded and subagent
sessions. A source failure marks inventory incomplete and blocks all actions.
Classification and project totals, approvals and source gaps are persisted.
No ledger match is required for a stalled native work item.

Archived sessions, subagents and explicit noise are kept. Permanent refs,
coordinator/orchestrator sessions, director/coordinator titles and the current
session are protected compaction-review entries. Excluded topics and other
projects remain visible for approval. A closed graph node alone does not mean
its native session is archived.

A candidate needs a full native UUID, mapped permitted project, valid local cwd
and native history path, sufficient inactivity and an explicit pending-question
fact. A pending question or human-wait pattern blocks it. Metadata-only or
missing history produces a source gap. Stalled attention, interrupted/error
outcome or an unfinished quiet/blocked native turn can justify continuation.
An idle completed task needs an explicit continuation pattern. Classification
uses native facts and host patterns, without a model pass over the inventory.

Completed work can become an archive proposal, but incomplete native history
or ledger link coverage cannot prove archive eligibility. This initial engine
performs **zero archives** even if `maxArchives` is positive. Actual archiving
requires a separately supported adapter, a durable summary gate and independent
AI PASS review bound to the exact persisted plan digest. The reviewer must be
different from the acting session. Supplying an unrelated review receipt does
not enable archiving in this version. No stop/kill operation is implemented.

## Applying operative continuation

Apply acquires a global per-consumer lock under the standard XDG state root,
refreshes official native facts and rejects changed observations. Each consumer
binds its lock to one sibling-run receipt root; changing that root fails closed
and requires explicit migration. Preserve that root and its receipts across
runs. Deduplication reads per-run `actions.jsonl` only, with no new identity
store. Missing or corrupt receipt history blocks apply. A semantic observation
fingerprint excludes polling timestamps, so a refreshed discovery does not
justify repeating an unchanged native attempt.

For an existing Codex session, apply immediately rechecks `query resume`, then
`codex-thread-guard.py resume-check` and `session-writer-status.mjs`. Missing,
archived, superseded, unknown-writer and other native blockers stop the action.
Guard exit 3 blocks; exit 4 permits native queue only with exclusively known
app-server writers; exit 6 permits native queue with known free/app-server
ownership. A concurrent CLI writer blocks queueing. No desktop override is used.
The engine calls `agent-native-call.mjs --delivery-only` and validates its
correlated queue acknowledgement. `queued` proves transport acceptance only.

A Claude candidate remains a handoff proposal unless the host enables the
`developer` profile and an explicit Limen policy. Supported handoff creates a
fresh unique Codex target through `agent-session.sh new`, after proving target
absence. It never relaunches or stops the original Claude session. The existing
`target-session --owned-cwd` helper must prove the new target is unattended,
local, live and uniquely owned, and resolve its full native UUID. Only that
fresh owned target may receive through `agent-send.sh`, which retains its
approval, live-TUI, idle and composer guards. Its own expected CLI writer does
not authorize a second CLI launch. A successful/checkpoint helper return means
`submitted`, with execution and completion still unverified. Receipts retain
original identity, unique target, child UUID and native lineage edges when
exposed by Mesh; the engine does not fabricate lineage in a separate store.

The deterministic continuation prompt grants no new permissions and directs the
worker to its original requested work and authoritative context, stopping at a
human decision, production/external/irreversible action or changed scope.

Before any native mutation, apply appends and fsyncs an attempt fingerprint.
A launch/queue failure, timeout or crash after that marker prevents automatic
retry of the same observation. It stops on the first action failure. Ambiguous
results need inspection, not a retry flag. The maximum of three includes both
queue resumes and new child handoffs.

## Evidence and validation

Each run contains `inventory.json`, `plan.json`, `report.md` and `actions.jsonl`.
Directories use mode 0700 and files mode 0600. JSON/Markdown snapshots use atomic
replacement and fsync; attempt receipts append with fsync. These are run
artifacts, not competing work-item stores. Existing `agent-run-receipt.py record`
records job outcomes; this module does not recreate job-stopped state, poll
ledgers, schedule itself or implement the host beat.

Run the synthetic helper-stub suite in an integration checkout:

```sh
python3 packages/tmux-bridge/test/lifecycle-engine.test.py
```

Fixtures cover complete counts, explicit exclusions, native work without ledger
matches, bounds, window and ownership guards, queue acknowledgements, attempted
mutation deduplication, human waits, archive protection, supported/unsupported
handoffs, native source failure and persisted-plan integrity. Host adapters,
live runtime delivery, archive reviews and ledger decision polling require
separate integration validation.

`eventOutbox` optionally names the existing native follower root used by the
beat. Acknowledgements and failures are projected there with stable event IDs
through `agent-follow` under its lock. Per-run receipts remain the evidence; a
retry recovers missing outbox events before deduplicating native attempts.
Previously attempted observation fingerprints are filtered before selecting the
next capped batch, so they cannot starve later candidates. Native event and human
input identities, when present, distinguish new work from polling timestamps.

Native helper pipes reuse the bounded transport in `mesh-ledger`: stderr is
discarded, stdout is limited while reading, and the invocation process group is
retired on completion or failure. Native tmux workers and lease monitors detach
through the existing bridge transport. Each dispatch refreshes and reclassifies
its original context after earlier actions and guard checks; a Claude handoff
checks again after child launch, before delivering its continuation prompt.
