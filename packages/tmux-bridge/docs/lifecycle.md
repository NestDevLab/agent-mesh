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
for each observation. Apply can be repeated for recovery. Ambiguous recorded attempts are never
blindly repeated; only explicit pre-delivery proof/capacity failures use the
bounded retry policy described below.

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
| `retryBaseSeconds` | Initial retry delay, positive integer seconds; default 300 |
| `retryMaxSeconds` | Exponential delay ceiling, at least base; default 3600 |
| `retryMaxAttempts` | Hard retry budget 0–10; default 3, zero disables retry |
| `retryGuardCommand` | Optional private source/permission guard before a due retry |
| `idleSeconds` | Minimum native inactivity, default 3600 |
| `continuationPatterns` | Explicit continuation evidence for completed idle turns |
| `humanWaitPatterns` | Human-wait evidence that blocks continuation |
| `timezone` | Passed to the host resume-window guard; default `UTC` |
| `workItemCommand` | Optional argv for an owned open work item lookup; 10-second timeout |
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
Without `workItemCommand`, stalled native work retains the existing behavior:
no ledger match is required and the generic continuation prompt is used.

When configured, `workItemCommand` runs only for otherwise eligible existing-session
resume candidates. It receives `{"session":"codex:11111111-1111-4111-8111-111111111111"}`
as JSON on stdin (no extra arguments and no shell). The host adapter must return
exit 0 and JSON such as:

```json
{"item":"TASK-42","title":"Complete the fixture","nextStep":"Run the fixture check"}
```

The adapter is responsible for proving that the item is open and owned by the
supplied session. It must return no item for closed, unassigned or differently
owned work. Empty output, `null`, `{}` or `[]`, command errors, a 10-second timeout,
invalid JSON or invalid/empty fields classify the candidate as `keep-no-work-item`;
no resume is selected. Each reason is retained in the plan and report. `item`
accepts a nonempty string or integer; `title` and `nextStep` require nonempty strings.

Item text is flattened to one line: whitespace, control and format characters
become spaces, repeated whitespace is collapsed, title is capped at 120 characters
and next step at 200. The item id is also sanitized. Each resume action includes
`workItem` with the sanitized fields; the report shows the item and next step.
The fixed prompt is `Continue work item <item>: <title>. Next step: <nextStep>.`
followed by the existing safety text beginning `This message grants no new permissions.`
The adapter is called again before queueing; a missing or changed item blocks the
saved action and requires a new plan. This option does not alter Claude child
handoff policy.

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

Completed work can become an archive proposal. Actual archiving requires the
configured canonical per-thread adapter, durable summary and obligation proof,
and independent AI review bound to the exact persisted plan/action digests.
An incomplete global ledger-link projection cannot prove absence of obligations;
it remains a reported gap. With no configured canonical hooks, archives remain
report-only. The per-thread protocol below requires individual authoritative
proof rather than treating that global projection gap as archive permission.
No stop/kill operation is implemented.

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
correlated queue acknowledgement. It requests the native CLI `queue --resume`
so an inactive daemon thread is reopened after enqueueing. The default native-call
API remains queue-only unless explicitly passed `--resume`. The CLI may accept a
queue even when daemon activation fails; receipts retain resume-request and
diagnostic flags, never execution proof. `queued` proves transport acceptance only.

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
An ambiguous launch/queue failure, timeout or crash after that marker prevents
automatic retry of the same observation. Explicit safe retry exceptions follow
the receipt-backed policy below. It stops on the first action failure. Ambiguous
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
matches when the option is unset, work-item success/failure/timeout/sanitization, bounds, window and ownership guards, queue acknowledgements, attempted
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

## Receipt-backed retryability and model capacity

Retry state is derived from the existing sibling-run `actions.jsonl` receipts;
there is no new store, scheduler, ledger or model call. New failure receipts can
carry `retryable`, `retryClass`, `retryAttempt`, `nextRetryAt` and
`retryExhausted`. Planning excludes unchanged attempts before batch selection,
but a due safe retry becomes eligible after its exponential delay. Defaults
are 300 seconds, doubling to a 3600-second maximum, with a hard budget of three.
A zero retry budget disables retry. Every due retry still passes current
source/classification, original-work-item, reset-window and native safety
checks. Failure receipts preserve action start separately from actual failure-observed
time; nextRetryAt starts at failure observation, so a long guard/sweep/launch
cannot consume its own retry delay. Backoff/held metadata appears in plans/reports; it is not a claim that
the work executed.

Two capacity causes are deliberately distinguished:

- A native lifecycle error explicitly identifying model overload, including the
  known provider message `Selected model is at capacity`, is `model-capacity`.
  Its stable native failure timestamp starts backoff, not a polling timestamp.
  Model-capacity attempts share a receipt-backed hard budget by session and
  attested work-item identity where available. Native subagents/automation,
  protected roles and ownership exclusions retain their earlier classifications.
  Missing trustworthy failure time is a source gap, not permission to retry.
- Governed launcher exit 75 means the native capacity dispatcher already owns a
  waiting job for the recorded target. A retry only reprobes/reuses that target;
  it never submits another launch or drains the queue itself. The capacity
  dispatcher remains responsible for admission. For an existing Codex queue,
  retryability requires exit 75 plus explicit structured `waiting_capacity`,
  `accepted: false`, and matching session/correlation identities. Generic
  nonzero exits, absent acknowledgements or arbitrary capacity text are not
  evidence that delivery was rejected safely.

A failed new-child ownership proof is retryable only before prompt delivery.
After backoff the engine reuses the recorded target and reruns the native
`target-session --owned-cwd` proof. A recorded child identity must match; a
missing target never authorizes replacement. Known legacy pre-delivery proof
receipts can be recovered from their exact fixed reason and child-created
marker, rather than becoming permanent failures after an upgrade.

The engine now fsyncs a `delivery-attempt` before guarded child send. Any such
attempt or accepted acknowledgement blocks automatic retry even if later
lineage/reporting fails. A different observation cannot silently create another
child for a session with a retained target; it becomes `keep-child-held` for
explicit reconciliation. A crash after an unclassified mutation attempt stays
held. These rules prevent child floods and duplicate queued work.

An optional host `retryGuardCommand` receives `{session,target,retryClass}` on
stdin. Only exit 0 with `{allow:true}` permits a due retry to continue. This guard
also covers a newly observed model-capacity scope without any same-fingerprint
receipt, using `retryClass: model-capacity`; a new scope cannot bypass private
permission policy. Denials retain bounded backoff even before native mutation. Missing
or unsupported source/permission proof can remain held by that private policy;
for example an ownership helper blocked by EACCES must not be replaced with a
new child or a privileged bypass. Repeated held probes consume the bounded
retry budget. Native permission/ownership checks run again before any send.
Raw stderr and provider payloads are never copied into generic retry reasons.

Use the existing synthetic suite to verify proof recovery, target reuse,
capacity ownership, exponential delay/caps, private permission holds, legacy
receipts, model-error metadata and ambiguous delivery protection:

```sh
python3 packages/tmux-bridge/test/lifecycle-engine.test.py
```

## Per-thread archive protocol

`inventory` remains read-only and never invokes archive hooks. `plan` can prepare
an archive pool; only `apply --apply` can invoke native mutation. Defaults remain
report-only (`maxArchives: 0`). Configure all three argv hooks to enable archives:

| Key | Default | Bound |
| --- | ---: | ---: |
| `maxArchives` | 0 | 0–10 confirmed successes per frozen run |
| `archiveMaxCandidates` | 100 | 1–200 actual prepare-hook calls |
| `archivePrepareTimeoutMs` | 120000 | 1–120000 |
| `archiveReviewTimeoutMs` | 240000 | 1–300000 |
| `archiveApplyTimeoutMs` | 120000 | 1–120000 |

`archivePrepareLimit` is a compatibility alias for `archiveMaxCandidates`;
setting both to different values is rejected. `inventory.json` is persisted in
the same `runDir` before preparing any candidate. Artifact files are bounded to
16 MiB; review and native-confirmation JSON receipts to 1 MiB.

Hooks receive JSON on stdin and return one JSON object on stdout. Nonzero exit,
timeout, malformed protocol, missing proof, invalid receipt or ambiguous native
outcome is a technical error and stops the batch. `status: skipped` with a short
`reasonCode` is a semantic refusal and continues to the next thread. Neither
prepare skips, review skips nor apply skips consume the success limit. Every
hook must preserve canonical eligibility: a source-only/review-only task without
its required merged/installed/verified proof is a semantic skip, never a fabricated
`N/A`, `not required` or substitute PASS. The generic engine does not implement
private eligibility or parse transcripts.

`archivePrepareCommand` receives `{session,fingerprint,runDir}`. Return:

- `{status:"skipped",reasonCode}` for canonical semantic refusal.
- `{status:"eligible",session,fingerprint,obligationsChecked:true,summary,evidence}` for a prepared action.
  `summary` and `evidence` are `{path,sha256}` descriptors of existing regular
  files with absolute paths. The engine hashes their bytes and binds both to the
  action digest. The adapter owns durable-summary readback, exact history,
  descendants, writers and all canonical eligibility checks.
- `{status:"technical_error",reasonCode}` for guard/tool failure (batch stop).

The engine freezes the entire eligible pool in `plan.json` before any review or
native apply. `archiveReviewCommand` receives `{planPath,planDigest,actor}`.
Return `{verdict,planDigest,reviewerRef,decisions,receipt}`. `receipt` is a file
hash descriptor whose JSON contains the same verdict, digest, reviewer and
complete decisions array. Every archive action must occur exactly once as
`{actionDigest,verdict:"PASS"}` or
`{actionDigest,verdict:"SKIP",reasonCode}`. Overall `PASS` may contain a mixture;
overall `FAIL` is valid only when every action explicitly says SKIP. Missing or
malformed decisions are technical errors. Only per-action PASS can reach apply.
The reviewer must be a different full native session from `selfRef`, verified
through the existing Mesh identity API. The host hook must obtain an actual
independent AI review; an invented receipt or a generic eligibility PASS is not
review. Empty prepared pools make no review/model call. Persisted exact review
receipts are reused on restart rather than requesting another model review.

Immediately before **each** archive, the engine refreshes canonical inventory,
rechecks hard protection and requires the same native observation fingerprint.
`archiveApplyCommand` receives
`{session,planDigest,actionDigest,summary,evidence,reviewReceipt}`. It must recheck
current host policy, the canonical archive guard and native adapter. A semantic
refusal returns `{status:"skipped",reasonCode}`. Confirmed success returns
`{status:"archived",session,planDigest,actionDigest,receipt}`. This receipt's JSON
must repeat those identities and include `nativeArchived:true`, based on actual
native readback. Queue acceptance alone cannot establish archive success.

Normal candidates remain restricted by `archiveProjects`. Explicit
`reviewedTemporaryRefs: [{session,fingerprint}]` may additionally nominate exact
observations, overriding only stale title/detail permanence heuristics and those
named refs' project scope. They never grant resumes and never override self,
explicit exclusions, permanent catalog refs/prefixes, orchestrator/current role,
current human waits, excluded-topic policy or unknown native facts. New content
requires a fresh observation-bound approval. Codex is the only supported native
archive harness; nominated Claude threads are reported `unsupported_harness`.
Complete native inventory, full history and local sources remain mandatory.
A global `linkCoverage:false` stays visible as a projection gap; configured
canonical hooks can still check authoritative per-thread obligations. Every
eligible response must attest `obligationsChecked:true` (literal boolean), bound
into the action digest alongside the evidence file hash. Missing/false
attestation is a technical protocol error. Native inventory incompleteness stops
the archive batch before any prepare hook, regardless of global coverage.

The canonical host adapter must resolve both modern and legacy graph references
using official Mesh APIs, native history and authoritative ledger backlinks,
then apply the existing recursive canonical obligation guard. Unknown/opaque
refs or unresolved identities are semantic SKIPs; tool/schema errors stop the
batch. Hash-bound evidence must prove the individual obligation inventory was
complete, even while the global projection remains incomplete. The independent
reviewer must verify this evidence for each per-action PASS. Before mutation the
apply adapter must reread both current graph references and ledger proof as well
as its canonical guard; a native fingerprint alone does not cover changed links.
No global coverage flag is changed or migration inferred by these checks.

Archive attempt markers are fsynced into the existing `actions.jsonl` **before**
the native adapter. Confirmed success receipts and semantic skips use that same
stream; there is no parallel identity/task store. A crash or ambiguous response
after an attempt holds further batches for explicit reconciliation. Successful
or skipped actions are not repeated when reapplying the same frozen plan;
confirmed successes across restarts still consume that plan's limit. Source
refresh/summary/review errors before an archive attempt never claim a native
archive happened. Resumes retain their separate three-action cap and native
queue guards. Archive outcomes use the existing follow outbox, with semantic
keys independent of run timestamps/digests, so unchanged refusals do not generate
new wakes. Preparation skips remain visible in the frozen plan and report.

Focused synthetic checks (run in the integration/test checkout):

```sh
python3 packages/tmux-bridge/test/lifecycle-archive.test.py
python3 packages/tmux-bridge/test/lifecycle-engine.test.py
```

Candidate discovery also includes completed (`completion: task`, inactive turn,
complete history) temporary Codex workers, including noise/ephemeral classes;
this does not change their resume or queue behavior. Normal hard protections,
project policy and canonical eligibility still apply. Known unsupported or
hard-protected rows get per-thread `preparation-skipped` receipts without
consuming the prepare-hook budget. Preparation updates plan classification
counts and the approval list before freezing its digest.

When more candidates exist than fit the hook budget, the next run considers
previously unconsidered/least-recently considered refs first. Rotation is derived
only from `archive-considered` rows in the existing action receipts; it creates
no additional cursor or task store. This prevents a permanently refused prefix
of the pool from starving later completed work. Preparation refusal receipts
never settle an older ambiguous native archive attempt.

### Receipt history scope

Sibling `plan.json` files are classified by schema and consumer before requiring
native `actions.jsonl`. Valid foreign report schemas without this consumer, and
native plans explicitly owned by another consumer, are outside this consumer's
history. This permits read-only/manual reports beside native runs without
inventing dummy receipts. Current-consumer native plans still require readable
action receipts; schema-less legacy plans and receipt streams without a plan
remain in scope. Malformed/unreadable headers, unsupported native plan versions,
and foreign schemas claiming the current consumer fail closed. Missing or
corrupt native receipts must be reconciled, never deleted or fabricated.
