# Plexus ledger view v1

`plexus.ledger-view/v1` is a deterministic presentation of the existing live
ledger/session join. Its JSON Schema is
`packages/tmux-bridge/schemas/plexus-ledger-view-v1.schema.json`.

The ledger owns item fields. The graph owns session links. The group store owns
N:M group/item associations and the single lead group per item. The view reads
these sources on demand. Missing values are explicit `null`; arrays stay empty
when no authorized relationship is present. Item source revisions, graph
sequence and presentation-profile revision are separate. An unavailable group
source revision stays null.

## CLI

```sh
mesh-graph query view --format json
mesh-graph query view --format md --sort waitingOnOwner:desc,due,priority,size
mesh-graph query view --filter 'state=open' --filter '{"sessions.role":"owns"}'
```

`--filter` accepts a JSON object or one `field=value` clause and may be repeated.
The existing item-filter operators apply to scalar fields and nested paths.
Arrays match any scalar element; `ne` requires no matching element. Empty
collections are missing for `exists`. Sorting accepts up to eight comma-separated
fields with optional `:asc` or `:desc`, places missing values last in either
direction and breaks ties by the exact item ref. The default is waiting on the
owner first, due ascending, priority rank and size rank. Undated items follow
dated items within the same waiting partition.

Configuration comes from `--config`, `MESH_LEDGER_VIEW_CONFIG`, or the standard
`agent-mesh/ledger-view.json` file under the user's XDG configuration directory.
It is private, source-owned data with schema `plexus.ledger-view-config/v1`.
It supplies field aliases, rank tables, project names, stable item/session thread
bindings, Director threads, group display aliases and Markdown settings. Runtime
queries use these bindings without scanning transcripts.

`--fallback project` replays the historical project-level link policy for
regression fixtures. Normal queries use the configured Director thread. Both
modes retain the reason why the item itself has no app thread. Missing project
or Director mappings have separate explicit fallback reasons. Thread links do
not confer data access or authority.

## Record

Each item contains its source ref and id, full title, raw state and normalized
status, due, priority, size, domain/project, waiting flag, sessions, owning session
identities, linked groups and lead group ref, resolved app thread and missing-link
reasons. Complete scalar source fields remain available under `fields`.

The `thread` object has `chan`, `cmsg`, `url`, a resolution kind and missing/fallback
reasons. Configured app links use the canonical project/thread URL structure.
A group lead does not create a session ownership link. A session ownership link
does not create a group lead or acquire an item lease.

## Transport and compatibility

The legacy `query items` output remains available. The new view shares its graph
join, filter operators and comparator. Exact full-field source reads live in the
existing ledger dispatcher and preserve provider/batch validation, encoded-byte
request splitting, oversized-response splitting and the total result budget.
They do not advance consumer cursors.

The gateway view uses the existing work-item tool with an explicit v1 selection.
The owner is verified on each request before source reads. Exact ledger, session
and group grants remain independent. Existing delegated legacy reads retain their
contract. Consumer code must use the response's schema version and preserve the
principal through every API request.

Per-item adapter failures retain their authorized reference in `errors`. Valid items remain sortable and filterable. Markdown includes a separate item error section. Adapter diagnostics are replaced with fixed labels. Invalid transport, provider attribution, batch coverage, and unreferenced discovery failures still reject the request.

Default CLI calls load the private profile from `$XDG_CONFIG_HOME/agent-mesh/ledger-view.json` (or `~/.config/agent-mesh/ledger-view.json`). Operators must deliver that profile through the owning configuration provider. The same profile can be selected explicitly with `--config` or `MESH_LEDGER_VIEW_CONFIG`. Item and session thread mappings take precedence over the project Director fallback. JSON reports the resolution and Markdown labels Director and project fallbacks explicitly.
