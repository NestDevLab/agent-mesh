# Session-ledger graph

Status: design, not implemented. Scope: agent-mesh keeps an n:m graph between agent sessions
(Claude, Codex, later harnesses) and work ledgers, answers "which ledgers does this session touch"
and "which sessions are its neighbours", and serves that read-only to a UI that builds projects and
discussion groups on top. Every session stays resumable with its harness's native command, with or
without that UI.

The graph extends the existing session graph (`packages/tmux-bridge/bin/mesh-graph.mjs`, documented
in `packages/tmux-bridge/docs/session-registry.md`). No parallel store.

## 1. What exists today

| Piece | Where | Relevant facts |
|---|---|---|
| Session graph | `mesh-graph.mjs`, state `$XDG_STATE_HOME/agent-mesh/graph/` | Canonical `events.jsonl` (append-only, fsynced), projection `graph.json`, byte-cursor `checkpoint.json`, `snapshot.json` after `compact`, mkdir lock. Events: `node.upserted` (full node), `edge.added`, `node.purged`. Event ids are UUIDs; **no sequence number**. |
| Node | same | `id` (`node-<uuid>`), `agent`, `runtimeUuid` (native id), `cwd`, `title`, `summary`, `status`, `class`, `origin`, `domains`, `primaryDomains`, `domainPredecessors`, `attention`, `surface`, `tmuxTarget`, `tmuxObservation`, `launches[]`, `resumable`, `resumabilityReasons`, `refs[]`. Several nodes may share one native id. |
| Ledger refs | `node.refs`, `mesh-graph ref add\|remove` | Opaque `scheme:id` strings (`OPAQUE_REF`), never resolved. Already n:m, but with no role, time, source or activity. |
| Edges | `EDGE_TYPES` | `spawned-by`, `delegates-to`, `linked`, `watches`. Stored `from` = parent/delegator, `to` = child (the name reads the other way). Edges can be added but never ended. |
| Registry | `mesh-graph registry` | Groups nodes by `<agent>:<runtimeUuid>`; unions `refs`; resolves `spawnedBy`/`delegatedBy`; open-window and exclusion policy. |
| Launch record | `bin/bridge-launch-record.py`, `$XDG_STATE_HOME/agent-mesh/launches/events.jsonl` | `launch.started` with `kind` spawn/resume, `caller` (parent session from env), `threadId`, `cwd`, profile/model/effort. |
| Resume guards | `agents/*.conf`, `agent-session.sh`, `codex-thread-guard.py`, `session-writer-status.mjs` | Native resume templates; Codex archived (exit 3), occupied writer (4), Desktop-visible (6); writer state `owned\|free\|unknown`. |
| Gateway | `packages/gateway/src/mcp/mesh-mcp.ts` | MCP over loopback HTTP behind an access proxy; principals with `allowedWorkspaceIds`/`allowedDomainIds`; `mesh_agent_session_*` tools read native transcripts directly, not the graph. No REST surface. |
| Hooks | `packages/tmux-bridge/hooks/claude-session-start.json` | Claude `SessionStart` (`startup\|resume\|clear\|compact`) and `UserPromptSubmit`, distributed by Agentwheel into runtime settings. Reads only `session_id`. No Codex `SessionStart` hook exists. |

In practice few nodes carry refs: nothing feeds them automatically, so linking is the gap, not
storage. `agent` is also unvalidated, so test harnesses can leave nodes with arbitrary agent names.

Ledgers have no shared store. A file-based ledger and a database-backed work-item store are both
reachable only through opaque refs such as `management:MGT-0239`, which is the right boundary.

## 2. Data model

### Session

A session is a **native identity** `<agent>:<runtimeUuid>` (the registry key). Graph nodes stay the
observation records; one session groups one or more nodes exactly as `registryProjection` does
today. Consumers store the session id, never a node id.

- `agent` must be a registered harness (`codex`, `claude`, extensible through an agent config);
  other values are rejected at write time.
- A renewed, forked or replacement session gets a **new** session id plus a lineage edge. A plain
  native resume keeps the id (Claude appends to the same transcript; Codex reuses the thread).

### Ledger

A ledger is an opaque ref `scheme:id` (unchanged `OPAQUE_REF`). agent-mesh stores refs, never
ledger content. Unknown schemes round-trip unchanged. A ledger has no record of its own; it exists
while at least one link names it. An optional `title` cache is filled only by an explicit ledger
adapter write (section 3.3), never by guessing.

### Link (session ↔ ledger)

New first-class record replacing the bare string in `node.refs`:

| Field | Meaning |
|---|---|
| `id` | `link-<uuid>` |
| `session` | `<agent>:<runtimeUuid>`, or `pending:<nodeId\|launchId>` until the native id is known |
| `ref` | ledger ref |
| `role` | `owns`, `works-on`, `reviews`, `coordinates`, `discusses`, `observes`, `mentioned` |
| `since` / `until` | ISO times; `until = null` means open |
| `source` | who asserted it: `bridge-launch`, `hook`, `ledger-write`, `reconciler`, `operator`, `ui:<principal>`, `legacy-node-refs` |
| `lastActivityAt` | latest **ref-specific** evidence (ledger write, explicit touch, launch with that ref); never session-wide activity |
| `evidence` | deduplicated list of short pointers (launch id, ledger log line ref), no content |

One open link per `(session, ref, role)`. Ending a link sets `until`; the record stays as history,
and reopening creates a new link. When a pending identity resolves, its links are rewritten to the
session id by one `link.resolved` event; if resolution stays ambiguous the links stay pending and
are reported, never guessed. If the session already holds an open link with the same `(ref, role)`,
resolution merges into it: the earlier `since`, the later `lastActivityAt` and the union of
`evidence` survive, and the pending link closes with `mergedInto: <link id>`. Pending links are
internal: queries and the feed never show them.

`node.refs` becomes a derived compatibility projection (refs of the session's open links, written to
every node of that session), so the registry, follower and renderers keep working unchanged. The
legacy commands become link operations: `ref add` opens a `works-on` link with `source: operator`;
`ref remove` closes every open link of that `(session, ref)`; `--refs` is diffed into opens and
closes. Nothing writes `node.refs` directly any more.

### Lineage (session ↔ session)

Keep the four edge types, add two, and allow ending:

| Type | Meaning | Feeder |
|---|---|---|
| `spawned-by` | parent launched child | launch `caller`, Codex `thread_spawn_edges` / `parent_thread_id` |
| `delegates-to` | steering authority | explicit only |
| `linked`, `watches` | lateral | explicit only |
| `forked-from` (new) | new id from an existing transcript | Codex `forked_from_id`, Claude `--fork-session` launches |
| `succeeds` (new) | renewal of a permanent session, domain takeover | `claim --take-over` (`domainPredecessors`), explicit renew |

Edges gain optional `endedAt` and `source`. Deduplication on `(from, to, type)` applies only to
open edges; re-adding an ended relationship creates a new edge. The registry projection and the
follower ignore ended edges, so `spawnedBy`, `delegatedBy` and steering authority stay correct. "Resumed from" is not an edge: resume keeps the session
id and is recorded in `launches[]` (`kind: resume`). Known bug to fix with this work: a bridge
resume can still add `spawned-by` from the current tmux session (`_mesh-graph.sh`), contradicting
the rule that resume never creates parentage.

### Events

New event types in the same stream: `link.opened`, `link.touched` (activity only), `link.closed`,
`link.resolved`, `edge.ended`, `session.renewed` (`{from, to}`).

**Sequence.** Every event carries a monotonic integer `seq`, assigned under the graph lock as
high-water + 1. The high-water mark is `max(snapshot.lastSeq, last seq in events.jsonl)`, recomputed
from the file on every locked write, so a stale or missing checkpoint cannot reuse a number.
Compaction already writes the snapshot before rewriting `events.jsonl`; replay skips events with
`seq <= snapshot.lastSeq`, so an interrupted compaction never applies an event twice.

**Migration** is one explicit step, `mesh-graph migrate --apply`, under the lock and before any
seq-aware write (seq-aware writers refuse an unmigrated store):

1. Number every legacy event in file order (snapshot first) and rewrite the store atomically.
2. Group nodes by session identity, as the registry does, and open one link per distinct ref of the
   group with `role: works-on`, `source: legacy-node-refs`. Nodes without `runtimeUuid` get
   `pending:<nodeId>` links.
3. Append a `store.migrated` marker. Rerunning is a no-op once the marker exists.

`link.touched` is coalesced (at most one per link per 10 minutes) to keep the stream small.

## 3. Feeders

Every feeder writes through `mesh-graph` under its lock; none edits state files.

### 3.1 Bridge launch and resume

`agent-session.sh new|resume` already writes a launch record and registers the node. Add
`--ref <ref> [--role <role>]` (and `MESH_LEDGER_REFS` for callers that only pass env). A resume knows
the native id and opens the link at once. A new session does not: registration has no runtime UUID
yet, so the links open as `pending:<launchId>`.

This needs the launch id before the harness starts. Today the bridge starts the harness first and
the recorder generates the id itself, so the bridge must instead allocate the id, pass it to the
recorder (`--launch-id`) and export it as `MESH_LAUNCH_ID` into the harness environment. Resolution
then comes from launch reconciliation (`launch.thread_resolved`, Codex, existing) or from the Claude
`SessionStart` hook reporting that launch id (3.2). Registration and hook evidence are idempotent
on the launch id, so either may arrive first; whichever completes the pair resolves. Unresolved or
ambiguous launches stay pending and are listed by `sweep`. Delegating callers
(including the gateway `mesh_agent_session_create`) pass the ledger they were
started for.

### 3.2 Harness hooks (distributed by Agentwheel)

Agentwheel launches nothing; it installs hook artifacts from this repo's `openpack.json`. Extend the
existing Claude `SessionStart` hook to call `mesh-graph touch --runtime-uuid <session_id> --agent
claude --cwd <cwd> --source hook:<startup|resume>`, recording liveness and cwd from the hook payload
(the reliable cwd; slug decoding is lossy). Hook budget stays at 1 s: the write is fire-and-forget,
and a failure never blocks the harness. The Claude hook also reports `MESH_LAUNCH_ID` when the bridge
set it, which resolves pending launch links.

Codex has no hook artifact in this repo today. Add one (`hooks/codex-user-prompt.json`) for Codex
`UserPromptSubmit` with the same touch; its payload fields must be confirmed against the Codex hook
contract before relying on them. The reconciler remains the fallback.

Hooks do not create ledger links by themselves.

### 3.3 Ledger writes

Ledgers own the "this session works on this item" fact; agent-mesh records it. Contract for any
ledger writer (skill, CLI, API): after writing an item it calls
`mesh-graph link open --runtime-uuid <uuid> --agent <agent> --ref <scheme:id> --role <role>
--source ledger-write [--title <title>]`, and `link close` when the session releases the item.
A store that records runs with a session id triggers the call when it sets that id, and stores the
mesh session id `<agent>:<runtimeUuid>`. Ledger-specific adapters (for example one that reads an
existing origin-session field) live with their ledger, not in this repo.

### 3.4 Reconciler (`mesh-graph sweep`)

`sweep` already reads both transcript stores and tmux. Extend it to derive, never to invent:

- Codex lineage from `session_meta.forked_from_id`, `parent_thread_id`, and the state DB
  `thread_spawn_edges` (already read by launch reconciliation).
- Claude subagent lineage from `<project>/<uuid>/subagents/*.meta.json`; such sessions keep
  `origin: subagent` and stay excluded from the registry by default.
- Claude liveness from the per-process session files, feeding `writer` state.
- Archived Codex rollouts (including compressed ones), so archived sessions stay in the graph with a
  reason instead of disappearing.
- Nothing else: session activity (`lastSeenAt`) is not ledger evidence and never touches links.

Optional, off by default: scan transcripts for refs of configured schemes and open
`role: mentioned`, `source: reconciler` links. This reads private content and produces weak
evidence, so it needs an explicit operator switch and scheme allow-list.

## 4. Neighbours

Two sessions are **ledger neighbours** when they hold open links to at least one common ref, and
**lineage neighbours** when a non-ended edge joins them. Depth 2 means neighbours of neighbours
through either kind.

Score of neighbour `b` for session `a` (depth 1):

```
score(a, b) = Σ_ref  w(a, ref) · w(b, ref) · decay(min(act(a, ref), act(b, ref)))
            + 0.5 per open lineage edge between a and b
w(s, ref)   = max role weight over s's open links to ref
act(s, ref) = max lastActivityAt over those links, else max since
w: owns 1.0, works-on 1.0, coordinates 0.8, reviews 0.7, discusses 0.6, observes 0.3, mentioned 0.2
decay(t) = 0.5 ^ (age(t) / 7 days)
```

Depth-2 score is the maximum, over paths `a → m → b`, of `score(a, m) · score(m, b)`. Ended links and edges are excluded unless
the query asks for history. Weights and half-life are config, not code constants, and every result
carries the per-ref breakdown so the UI can explain why two sessions are close.

## 5. Read-only API

### Transport

The gateway gains `mesh_graph_*` MCP tools with the same principal checks as `mesh_agent_session_*`.
The UI's server calls them over the gateway's existing MCP-over-HTTP endpoint; no new listener.
Locally, `mesh-graph query <name> --json` returns the identical payloads for scripts and tests.

### Scope

Graph nodes carry no principal today, and graph `agent` values (`codex`, `claude`) are harness types,
not gateway agent ids. Visibility reuses the configured mapping that `mesh_agent_session_*` already
uses: each gateway agent target has a provider type and workspace roots. A session is visible to a
principal when some target in its `allowedAgentIds` has the session's harness as provider and a
root, in one of its `allowedWorkspaceIds`, that contains the session cwd; and, when
`allowedDomainIds` is set, the session's `domains` meet it. The response attributes the session to
that target id. A session no target maps is visible to nobody. Domain alone never grants access,
since several workspaces can share a domain.

The same filter applies to every query, every traversal hop, every ref in a score breakdown and
every feed event. An out-of-scope neighbour is returned **redacted**, never dropped, so the graph
shape stays honest: `{handle, harness, redacted: true}`, where `handle` is an HMAC of the session id
keyed per principal. It is stable for that principal and reveals neither the native id nor links
across principals. A redacted node is never expanded at depth 2, and a ref is shown only if the
principal can see at least one session linked to it. Titles, cwd and summaries never leave through
an unscoped call.

### Queries

Each tool answers one query of the consumer spec (Q1-Q7) and keeps its semantics.

| Spec | Tool | Input | Output |
|---|---|---|---|
| Q1 | `mesh_graph_ledger_sessions` | `ref`, `descendantRefs[]?`, `roles?`, `history?` | sessions linked to the ref, with link records |
| Q2 | `mesh_graph_session_ledgers` | `session`, `history?` | links of the session with ref, role, since/until, cached title |
| Q3 | `mesh_graph_neighbours` | `session`, `depth 1-2`, `edgeKinds?` | scored neighbours with breakdown |
| Q4 | `mesh_graph_subgraph` | `refs[]` and/or `sessions[]`, `depth` | nodes and edges for a project or discussion-group view |
| Q5 | `mesh_graph_resume` | `session` | resume info (below) |
| Q6 | `mesh_graph_search` | `harness?`, `state?`, `text?`, `cursor` | session picker |
| Q7 | `mesh_graph_changes` | `sinceCursor`, `refs?`, `limit` | ordered events with `seq` and `eventId` |

Opaque refs have no parent/child notion, so the spec's `includeDescendants` becomes
`descendantRefs[]`: the caller passes the descendants it knows (the ledger owns its tree), and mesh
unions them. The spec's `owner` filter is dropped until sessions have an owner principal (section 9). Default queries return
only open links and non-ended edges; `history: true` adds ended ones. Pagination uses opaque cursors,
never offsets.

### Change feed

Q7 exposes the consumer's event vocabulary, projected from the graph stream:

| Feed event | Graph source |
|---|---|
| `session.created` | first `node.upserted` for a new `<agent>:<runtimeUuid>` |
| `session.state_changed` | `node.upserted` that changes `status` or `attention.state` |
| `session.renewed` | `session.renewed` (old id, new id) |
| `session.ended` | `status: closed` or archived surface |
| `edge.added` / `edge.ended` | `link.opened` / `link.closed` (session to ledger, `kind` = role), `edge.added` / `edge.ended` (session to session); `link.resolved` emits `edge.added` for the resolved link, or nothing when it merged into an open one |
| `resume.changed` | change of `resumable`, `resumabilityReasons` or writer state |

`link.touched` stays internal. One graph event can yield several feed events (a node upsert can
change state and resumability at once), so a feed `eventId` is `<graphEventId>:<feedType>`, with
`:<subject>` added when the type repeats; replay from an old cursor yields the same ids.

The cursor is the `seq` of the last **scanned** graph event, not of the last emitted one. Internal
events, `refs` filters and authorization filters skip numbers on purpose, so a gap is never a loss
signal. Loss happens only when the cursor is older than the retention watermark (`snapshot.lastSeq`):
then the answer is `reset: true` and the client re-reads with Q4. Pull is required; push is not in v1. Events carry ids and refs,
never transcript content.

### Resume info (Q5)

Same shape as the consumer spec, with `argv` added:

```json
{
  "sessionId": "claude:<uuid>", "harness": "claude", "nativeId": "<uuid>",
  "host": "<host label>", "workspace": "<cwd>",
  "resumable": false, "reason": "occupied", "reasons": ["occupied"],
  "writer": { "state": "occupied", "process": "claude-desktop", "since": "<iso>" },
  "commands": [
    { "label": "Claude Code CLI", "command": "claude --resume <uuid>",
      "argv": ["claude", "--resume", "<uuid>"], "cwd": "<cwd>" }
  ],
  "deepLinks": [], "hints": [], "successor": null
}
```

- Commands are native and work without agent-mesh or the UI: `claude --resume <uuid>` run in the
  session cwd; `codex resume <uuid> --cd <cwd>`. `command` is for display; launchers use `argv` and
  `cwd`, never a shell string.
- `writer.state` comes from `session-writer-status.mjs`. Claude: `owned` → `occupied`, `free` →
  `free`, `unknown` → `unknown`. Codex reports a writer list without a state, so an adapter maps a
  non-empty list to `occupied` and an empty one to `free`.
- `unknown` writer means `resumable: false`, `reason: writer-unknown`, matching the bridge's refusal
  today.
- `resumable: false` always has `reason` (the first of `reasons`). `reasons` reuses
  `resumabilityReasons` (`missing-runtime-uuid`, `missing-cwd`, `missing-transcript`) plus
  `archived`, `occupied`, `writer-unknown`, `desktop-owned`, `superseded`, `host-offline`,
  `harness-missing`.
- Occupied or Desktop-owned sessions keep the command for reference; the supported path is the
  existing queue/inbox handoff, never a second writer.
- Archived Codex sessions return `hints: ["codex unarchive <uuid>"]`.
- `successor` follows `succeeds`/`session.renewed`; the UI offers the successor.
- `host` is a configured label, never a hostname or address.
- No credentials, tokens, environment values or socket paths.

## 6. Deviations from the consumer spec

The consumer's needs spec was the input; the code changes it as follows.

| Spec | This design | Why |
|---|---|---|
| Stable mesh session id separate from native id | Session id = `<agent>:<runtimeUuid>`; renewal makes a new id plus `succeeds` | Native id is already the registry key and the resume key; a second id would need its own allocator and mapping. |
| Ledger refs like `<scheme>:<namespace>/work-item/<id>` | Any `OPAQUE_REF`; the namespace is part of the id (no whitespace allowed) | Existing validation already accepts that shape; mesh stays schema-free. |
| Link kinds `works-on`, `discusses`, `reviews`, `coordinates` | Same plus `owns`, `observes`, `mentioned` | Needed for neighbour weighting and for the weak reconciler evidence. |
| Edge kinds `spawned`, `renewed-as`, `handoff` | `spawned-by`, `succeeds`, `forked-from`; handoff = `delegates-to` or `succeeds` | Reuses existing types and their stored direction. |
| `host` on sessions, offline state | `host` is the graph's configured label; offline hosts keep their sessions (section 8) | The graph is per host today. |
| Writes W1-W3 (link/unlink, create session, run projection) | Out of this read-only API; W1 maps to `link open/close` with `source: ui:<principal>`, W2 to `mesh_agent_session_create --ref` | Writes need their own authorization design. |
| HTTP API with tool semantics | MCP tools over the existing HTTP endpoint (section 8) | The gateway exposes no REST surface; one auth path. |
| Agentwheel launch/resume hooks as a feeder | Agentwheel only distributes hook artifacts; launches come from the bridge and the harness itself | Verified in Agentwheel's runtime code. |

## 7. Implementation batches

1. Events: `seq`, `link.*`, `edge.ended`, `session.renewed`; `node.refs` as derived projection;
   `migrate`; agent validation; registry and follower ignore ended edges. Tests on replay,
   interrupted compaction, migration rerun and legacy `ref` commands.
2. Feeders: launch-id preallocation, bridge `--ref` with pending launch links, hook touch (Claude `SessionStart`, new Codex
   artifact), `link open|close|touch` CLI, fix resume parentage.
3. Reconciler lineage and archived sessions.
4. `mesh-graph query` and gateway `mesh_graph_*` tools with principal scoping and redaction.
5. Ledger adapters, outside this repo.

Each batch is independently shippable and keeps the existing registry contract.

## 8. Answers to the consumer's open questions

1. **Transport.** MCP tools over the gateway's existing HTTP endpoint (streamable HTTP, JSON
   response mode), behind the same access proxy and principal model. That is HTTP with the same
   tool semantics, and the consumer's API server calls it as an MCP client. A REST mirror can be
   added later as a thin adapter over the same handlers if an MCP client proves costly; it is not
   part of v1.
2. **Persistence and retention.** In the existing graph state directory of the host running the
   bridge: `events.jsonl` canonical, `graph.json` projection, `snapshot.json` after compaction.
   Ended links and edges stay in the projection as history; compaction folds them into the
   snapshot and keeps them for 90 days by default (configurable), then drops them. Open links and
   edges are never compacted away.
3. **Offline devices.** Sessions stay in the graph. Their resume info answers `resumable: false`,
   `reason: host-offline`, and their links still count for Q1-Q4. Each host keeps its own graph
   today; federating several hosts through the gateway is follow-up work.

## 9. Open questions for the UI consumer

1. Is workspace/agent/domain visibility enough, or does the UI need per-space principals and an
   owner on sessions (which would bring back Q6's `owner` filter)?
2. Are `owns` and per-role weights what the UI wants to show, or a simpler shared/not-shared view?
3. Discussion groups: a ledger ref of their own scheme, or a UI-side grouping over refs?
4. Should the UI write links (W1) in v1, and under which principal?
