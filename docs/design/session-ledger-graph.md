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

Measured on one live graph: about 3,900 nodes, 10 edges, and **one** node with a ref. Linking is
the gap, not storage. The same graph also contains nodes whose `agent` is a test-harness name, so
agent values need validation.

Ledgers in use have no shared store: a Markdown ledger with ids like `MGT-0123` (de facto ref
`management:MGT-0123`, origin session in frontmatter as `source: prompt:<agent>:<uuid>`), and a
database-backed Flow domain (`FlowRun.sessionId` exists, nothing writes it yet). Both are reachable
only as opaque refs, which is the right boundary.

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
| `session` | `<agent>:<runtimeUuid>` |
| `ref` | ledger ref |
| `role` | `owns`, `works-on`, `reviews`, `coordinates`, `discusses`, `observes`, `mentioned` |
| `since` / `until` | ISO times; `until = null` means open |
| `source` | who asserted it: `bridge-launch`, `hook`, `ledger-write`, `reconciler`, `operator`, `ui:<principal>`, `legacy-node-refs` |
| `lastActivityAt` | latest evidence that this session acted on this ledger |
| `evidence` | optional short pointer (launch id, ledger log line ref), no content |

One open link per `(session, ref, role)`. Ending a link sets `until`; the record stays as history.
`node.refs` becomes a derived compatibility projection (refs of open links), so the registry,
follower and renderers keep working unchanged.

### Lineage (session ↔ session)

Keep the four edge types, add two, and allow ending:

| Type | Meaning | Feeder |
|---|---|---|
| `spawned-by` | parent launched child | launch `caller`, Codex `thread_spawn_edges` / `parent_thread_id` |
| `delegates-to` | steering authority | explicit only |
| `linked`, `watches` | lateral | explicit only |
| `forked-from` (new) | new id from an existing transcript | Codex `forked_from_id`, Claude `--fork-session` launches |
| `succeeds` (new) | renewal of a permanent session, domain takeover | `claim --take-over` (`domainPredecessors`), explicit renew |

Edges gain optional `endedAt` and `source`. "Resumed from" is not an edge: resume keeps the session
id and is recorded in `launches[]` (`kind: resume`). Known bug to fix with this work: a bridge
resume can still add `spawned-by` from the current tmux session (`_mesh-graph.sh`), contradicting
the rule that resume never creates parentage.

### Events

New event types in the same stream: `link.opened`, `link.touched` (activity only), `link.closed`,
`edge.ended`, `session.renewed` (`{from, to}`). Every event gains a monotonic integer `seq`
assigned under the graph lock; `compact` records `lastSeq` in the snapshot so `seq` survives
rewriting `events.jsonl`. Legacy events without `seq` get one on first compaction. Migration of
existing `node.refs`: one `link.opened` per ref with `role: works-on`, `source: legacy-node-refs`.

`link.touched` is coalesced (at most one per link per 10 minutes) to keep the stream small.

## 3. Feeders

Every feeder writes through `mesh-graph` under its lock; none edits state files.

### 3.1 Bridge launch and resume

`agent-session.sh new|resume` already writes a launch record and registers the node. Add
`--ref <ref> [--role <role>]` (and `MESH_LEDGER_REFS` for callers that only pass env), emitting
`link.opened` with `source: bridge-launch` and the launch id as evidence. Delegating callers
(including the gateway `mesh_agent_session_create`) pass the ledger they were
started for.

### 3.2 Harness hooks (distributed by Agentwheel)

Agentwheel launches nothing; it installs hook artifacts from this repo's `openpack.json`. Extend the
existing Claude `SessionStart` hook to call `mesh-graph touch --runtime-uuid <session_id> --agent
claude --cwd <cwd> --source hook:<startup|resume>`, recording liveness and cwd from the hook payload
(the reliable cwd; slug decoding is lossy). Hook budget stays at 1 s: the write is fire-and-forget,
and a failure never blocks the harness. Codex has no `SessionStart`; use its `UserPromptSubmit` hook
for the same touch, with the reconciler as fallback.

Hooks do not create ledger links by themselves.

### 3.3 Ledger writes

Ledgers own the "this session works on this item" fact; agent-mesh records it. Contract for any
ledger writer (skill, CLI, API): after writing an item it calls
`mesh-graph link open --runtime-uuid <uuid> --agent <agent> --ref <scheme:id> --role <role>
--source ledger-write [--title <title>]`, and `link close` when the session releases the item.
For a Flow-style store, setting `FlowRun.sessionId` is the trigger and the stored value is the
mesh session id `<agent>:<runtimeUuid>`. Ledger-specific adapters (for example parsing an existing
`source: prompt:<agent>:<uuid>` frontmatter line) live with the private ledger, not in this repo.

### 3.4 Reconciler (`mesh-graph sweep`)

`sweep` already reads both transcript stores and tmux. Extend it to derive, never to invent:

- Codex lineage from `session_meta.forked_from_id`, `parent_thread_id`, and the state DB
  `thread_spawn_edges` (already read by launch reconciliation).
- Claude subagent lineage from `<project>/<uuid>/subagents/*.meta.json`; such sessions keep
  `origin: subagent` and stay excluded from the registry by default.
- Claude liveness from the per-process session files, feeding `writer` state.
- Archived Codex rollouts (including compressed ones), so archived sessions stay in the graph with a
  reason instead of disappearing.
- `lastActivityAt` of open links from the session's `lastSeenAt` when the transcript changed after
  the link opened.

Optional, off by default: scan transcripts for refs of configured schemes and open
`role: mentioned`, `source: reconciler` links. This reads private content and produces weak
evidence, so it needs an explicit operator switch and scheme allow-list.

## 4. Neighbours

Two sessions are **ledger neighbours** when they hold open links to at least one common ref, and
**lineage neighbours** when a non-ended edge joins them. Depth 2 means neighbours of neighbours
through either kind.

Score of neighbour `b` for session `a` (depth 1):

```
score(a, b) = Σ_ref  w(role_a) · w(role_b) · decay(min(lastActivity_a, lastActivity_b))
            + 0.5 per lineage edge between a and b
w: owns 1.0, works-on 1.0, coordinates 0.8, reviews 0.7, discusses 0.6, observes 0.3, mentioned 0.2
decay(t) = 0.5 ^ (age(t) / 7 days)
```

Depth-2 scores are the product of the two hops' scores. Ended links and edges are excluded unless
the query asks for history. Weights and half-life are config, not code constants, and every result
carries the per-ref breakdown so the UI can explain why two sessions are close.

## 5. Read-only API

### Transport

The gateway gains `mesh_graph_*` MCP tools with the same principal checks as `mesh_agent_session_*`.
The UI's server calls them over the gateway's existing MCP-over-HTTP endpoint; no new listener.
Locally, `mesh-graph query <name> --json` returns the identical payloads for scripts and tests.

### Scope

Graph nodes carry no principal today. Visibility maps the principal's `allowedDomainIds` to node
`domains` (already derived from cwd). A neighbour outside scope is returned **redacted**
(`{session, agent, redacted: true}`), never dropped, so the graph shape stays honest. Titles, cwd
and summaries are private: they never leave through an unscoped call.

### Queries

| Tool | Input | Output |
|---|---|---|
| `mesh_graph_ledgers` | `session?`, `scheme?`, `cursor` | refs with open-link counts, cached title, last activity |
| `mesh_graph_ledger_sessions` | `ref`, `roles?`, `history?` | sessions linked to the ref, with link records |
| `mesh_graph_session` | `session` | session summary, links, lineage edges, resume contract |
| `mesh_graph_neighbours` | `session`, `depth 1-2`, `kinds?` | scored neighbours with breakdown |
| `mesh_graph_subgraph` | `refs[]` and/or `sessions[]`, `depth` | nodes and edges for a project or discussion-group view |
| `mesh_graph_search` | `agent?`, `status?`, `text?`, `cursor` | session picker |
| `mesh_graph_changes` | `since` (seq), `refs?`, `limit` | ordered events with `seq` and `eventId` |
| `mesh_graph_resume` | `session` | resume contract (below) |

Pagination uses opaque cursors. `changes` is pull-based; a gap in `seq` (or a cursor older than the
compaction snapshot) answers `reset: true`, and the client re-reads with `subgraph`. Events carry
ids and refs, never transcript content.

### Resume contract

```json
{
  "session": "claude:<uuid>",
  "resumable": false,
  "reasons": ["occupied"],
  "writer": { "state": "owned", "kind": "claude-desktop", "since": "<iso>" },
  "commands": [
    { "label": "Claude Code CLI", "argv": ["claude", "--resume", "<uuid>"], "cwd": "<cwd>" }
  ],
  "hints": [],
  "successor": null
}
```

- Commands are native and work without agent-mesh or the UI: `claude --resume <uuid>` run in the
  session cwd; `codex resume <uuid> --cd <cwd>`. Returned as `argv` plus `cwd`, never a shell string.
- `reasons` reuses `resumabilityReasons` (`missing-runtime-uuid`, `missing-cwd`,
  `missing-transcript`) plus `archived`, `occupied`, `desktop-owned`, `superseded`.
- Occupied or Desktop-owned sessions return the command for reference but `resumable: false`; the
  supported path is the existing queue/inbox handoff, never a second writer.
- Archived Codex sessions return `hints: ["codex unarchive <uuid>"]`.
- `successor` points along `succeeds`/`session.renewed`; the UI offers the successor.
- No credentials, tokens, environment values or socket paths.

## 6. Deviations from the consumer spec

The consumer's needs spec was the input; the code changes it as follows.

| Spec | This design | Why |
|---|---|---|
| Stable mesh session id separate from native id | Session id = `<agent>:<runtimeUuid>`; renewal makes a new id plus `succeeds` | Native id is already the registry key and the resume key; a second id would need its own allocator and mapping. |
| Ledger refs like `flow:<space>/work-item/<guid>` | Any `OPAQUE_REF`; spaces are part of the id | Existing validation already accepts that shape; mesh stays schema-free. |
| Link kinds `works-on`, `discusses`, `reviews`, `coordinates` | Same plus `owns`, `observes`, `mentioned` | Needed for neighbour weighting and for the weak reconciler evidence. |
| Edge kinds `spawned`, `renewed-as`, `handoff` | `spawned-by`, `succeeds`, `forked-from`; handoff = `delegates-to` or `succeeds` | Reuses existing types and their stored direction. |
| `host` on sessions, offline state | Not modelled yet | The graph is per host today; multi-host is open question 3. |
| Writes W1-W3 (link/unlink, create session, Flow projection) | Out of this read-only API; W1 maps to `link open/close` with `source: ui:<principal>`, W2 to `mesh_agent_session_create --ref` | Writes need their own authorization design. |
| HTTP API | MCP tools over the existing HTTP endpoint | The gateway exposes no REST surface; one auth path. |
| Agentwheel launch/resume hooks as a feeder | Agentwheel only distributes hook artifacts; launches come from the bridge and the harness itself | Verified in Agentwheel's runtime code. |

## 7. Implementation batches

1. Events: `seq`, `link.*`, `edge.ended`, `session.renewed`; `node.refs` as derived projection;
   legacy migration; agent validation. Tests on replay, compaction and migration.
2. Feeders: bridge `--ref`, hook touch (Claude `SessionStart`, Codex `UserPromptSubmit`), `link
   open|close|touch` CLI, fix resume parentage.
3. Reconciler lineage and archived sessions.
4. `mesh-graph query` and gateway `mesh_graph_*` tools with domain scoping and redaction.
5. Ledger adapters, outside this repo.

Each batch is independently shippable and keeps the existing registry contract.

## 8. Open questions for the UI consumer

1. Is domain-based visibility enough, or does the UI need per-space principals on links?
2. Retention of ended links and edges: keep forever, or compact after N days?
3. Multi-host: one graph per host federated by the gateway, or a single shared graph?
4. Are `owns` and per-role weights what the UI wants to show, or a simpler shared/not-shared view?
5. Discussion groups: a ledger ref of their own scheme, or a UI-side grouping over refs?
6. Is pull-only `changes` acceptable for v1, with push left for later?
7. Should the UI write links (W1) in v1, and under which principal?
