# Ledger adapters

Status: design, not implemented. This is the contract that lets agent-mesh work with any work
ledger (a folder of Markdown items, a SQLite store, a hosted tracker) without this repository
knowing anything about a specific one. It fills batch 6 of `docs/design/plexus.md`: adapters live
with their ledger, agent-mesh only defines the plug.

## 1. Why

Plexus already treats a ledger as an opaque ref `scheme:id` and never resolves it. That keeps the
public tree free of private data, but every consumer that needs more than the ref (a waker that
reacts to item changes, a lifecycle script that needs the item state, a UI that shows a title)
ends up reading the ledger on its own, with its own parser and its own idea of "changed since last
time". The adapter contract moves that reading behind one interface, so:

- agent-mesh code calls one CLI, never a ledger directly;
- a ledger is plugged in by private configuration, not by code in this repo;
- "what changed" is computed once, with a cursor, instead of rescanning everything on every run;
- session ↔ item links reach Plexus through the existing link contract (plexus.md 3.3).

## 2. Shape

```
consumer (waker, lifecycle beat, gateway, UI)
        │  mesh-ledger describe | changes | sync
        ▼
mesh-ledger (this repo)  ── reads private adapter config, keeps cursors, writes Plexus links
        │  spawn <command> <operation>, JSON on stdin, JSON on stdout
        ▼
adapter (lives with its ledger, may be private)
        ▼
ledger storage
```

An adapter is **any executable** that speaks the protocol in section 4. agent-mesh never imports
adapter code, never reads ledger storage, and never stores item content beyond the optional title
cache Plexus already defines.

## 3. Configuration (private, never in this repo)

`$MESH_LEDGERS_FILE`, default `$XDG_CONFIG_HOME/agent-mesh/ledgers.json`:

```json
{
  "schemaVersion": 1,
  "adapters": [
    {
      "scheme": "work",
      "command": ["node", "/opt/ledgers/work-adapter.mjs"],
      "timeoutMs": 10000,
      "linkSessions": true
    }
  ]
}
```

- `scheme` is the ref prefix this adapter answers for (`work:ITEM-0042`). One adapter per scheme.
- `command` is an argv array, run without a shell. Paths are host-specific and stay in this file.
- `linkSessions: false` makes `sync` skip Plexus links for that adapter (read-only use).
- A missing or empty file means no adapters; every command then reports `no-adapter` and exits 0
  for `changes`, so a waker producer stays quiet instead of failing.

## 4. Protocol `agent-mesh.ledger-adapter.v1`

The adapter is invoked as `<command...> <operation>`, receives one JSON object on stdin and prints
one JSON object on stdout. Exit 0 on success, including partial results with `errors`. Non-zero exit
or unparsable output is an adapter failure. stderr is diagnostic only and is never forwarded to
agents.

Every response carries `"schema": "agent-mesh.ledger-adapter.v1"`.

### 4.1 `capabilities`

Input `{}`. Output:

```json
{ "schema": "agent-mesh.ledger-adapter.v1", "schemes": ["work"], "operations": ["describe", "changes"],
  "sessionField": true }
```

`sessionField` says whether items report `sessions` (4.4).

### 4.2 `describe`

Input `{ "refs": ["work:ITEM-0042", ...] }` (at most 200). Output
`{ "items": [Item...], "missing": ["work:ITEM-9999"], "errors": [] }`.

### 4.3 `changes`

Input `{ "cursor": <string|null>, "limit": 200 }`. Output:

```json
{ "items": [Item...], "cursor": "<opaque>", "more": false, "errors": [] }
```

- `cursor: null` means "from now": the adapter returns no items and a cursor for the current
  position, so a first run never floods consumers with the whole ledger. `mesh-ledger changes --full`
  is the explicit way to get everything.
- Every item changed after the cursor is returned once, in its current state (no diffs).
- The cursor is opaque to agent-mesh; `mesh-ledger` stores it (section 5), so adapters stay
  stateless. An adapter may use a modification time, a revision number or a log offset.
- An item deleted from storage is returned with `"status": "deleted"`.

### 4.4 Item

Common fields, all optional except `ref`, `title`, `status`, `updatedAt`:

| Field | Meaning |
|---|---|
| `ref` | `scheme:id`, the Plexus ref |
| `title` | short human title |
| `state` | the ledger's own state word, unchanged |
| `status` | normalized: `open`, `active`, `waiting`, `blocked`, `done`, `cancelled`, `deleted` |
| `assignee` | who owns the next step, the ledger's own label |
| `domain` | the ledger's own grouping label |
| `nextAction` | one line |
| `waitingOn` | `{ "who": "human" \| "agent" \| "external", "ask": "<what is needed>", "urgency": "low\|normal\|high", "due": "<ISO>" }` |
| `resumeCondition` | one line: what must happen before work resumes |
| `sessions` | `[{ "session": "<agent>:<uuid>" \| "[<agent>:]<hex prefix>", "role": "<plexus role>", "at": "<ISO>" }]` |
| `updatedAt` | ISO time of the last change |
| `url` | link a human can open, if any |

Adapters map their own fields onto these and drop the rest. They never return free-form body text
or logs: consumers that need the full item open it in the ledger itself through `url` or the
ledger's own tools.

`sessions` with a short prefix (at least 8 hex characters, with or without the agent, for example
copied by hand into a log line) is allowed; `mesh-ledger sync` resolves it against the registry only
when exactly one session matches, and otherwise reports it as unresolved. It never guesses.

## 5. `mesh-ledger` CLI (this repo)

| Command | Does |
|---|---|
| `mesh-ledger adapters [--json]` | lists configured schemes and runs `capabilities` |
| `mesh-ledger describe <ref>... [--json]` | routes refs by scheme to `describe` |
| `mesh-ledger changes --scheme <s> [--consumer <name>] [--peek] [--full]` | calls `changes` with that consumer's stored cursor, prints the items, advances the cursor unless `--peek` |
| `mesh-ledger producer --scheme <s> --consumer <name> [--filter <expr>]` | same as `changes`, printed as the `agent-waker.py` producer report `{"new": [...], "errors": [...]}` |
| `mesh-ledger sync --scheme <s>` | runs `changes` under the `plexus` consumer and applies it to Plexus (below) |
| `mesh-ledger conformance --scheme <s>` | runs the adapter against the protocol checks in section 7 |

Cursors live in `$XDG_STATE_HOME/agent-mesh/ledger/cursors.json`, one per `(scheme, consumer)`,
written atomically under a lock. A consumer advances only its own cursor, so the waker, the
lifecycle beat and Plexus sync never steal items from each other.

`--filter` keeps the producer cheap and quiet: for example `status=waiting,waitingOn.who=human`
wakes the owner only when an item starts waiting on a person.

### Plexus sync

For each changed item, `sync`:

- opens a link (`source: ledger-write`, role from the item, default `works-on`, `title` from the
  item) for every resolved session not already linked to that ref with that role;
- touches the link when the item changed and the session is still listed;
- closes links with `source: ledger-write` whose session is no longer listed, or all of them when
  `status` is `done`, `cancelled` or `deleted`;
- never touches links from other sources (`bridge-launch`, `operator`, `ui:*`).

Ledgers that prefer to push can keep calling `mesh-graph link open|close` directly (plexus.md 3.3);
both paths write the same events.

## 6. Privacy

- Adapter paths, schemes of private ledgers and cursors stay in private config and state.
- Item fields pass through `mesh-ledger` to its caller and are never persisted by agent-mesh, except
  the Plexus title cache.
- Gateway exposure (a future `mesh_plexus_ledger_describe`) applies the principal's
  `allowedRefPrefixes` before calling the adapter, so a hidden ref is never even described.
- `scripts/mesh-readiness.mjs` keeps rejecting private identifiers in the public tree; examples and
  fixtures use the `work` and `example` schemes only.

## 7. Conformance

`mesh-ledger conformance` checks, against a live adapter:

1. `capabilities` returns the schema and lists `describe` and `changes`.
2. `describe` of an unknown ref lands in `missing`, not in `errors`.
3. `changes` with `cursor: null` returns no items and a cursor.
4. Two `changes` calls with the returned cursor and no ledger writes in between return no items.
5. Every item has `ref`, `title`, `status` in the normalized set, and an ISO `updatedAt`.
6. Output stays under 1 MiB and the call finishes within `timeoutMs`.

The repo's tests run the same checks against a fixture adapter (`test/fixtures/ledger-adapter.mjs`)
backed by a temporary folder of items.

## 8. Implementation batches

Each batch is one small PR and leaves existing behaviour unchanged.

1. This document, linked from `plexus.md` batch 6.
2. `mesh-ledger adapters|describe|changes|producer`, config loader, cursor store, fixture adapter,
   conformance command and tests.
3. `mesh-ledger sync` into Plexus links, with tests for open, touch, close and prefix resolution.
4. Reference adapter for `@nestdevlab/ledger-core`, in that repository (it owns its storage).
5. Gateway read tool `mesh_plexus_ledger_describe`, together with the Plexus read tools (plexus.md
   batch 4).

Private adapters and their configuration are rolled out from the private ops hub, outside this
repo.
