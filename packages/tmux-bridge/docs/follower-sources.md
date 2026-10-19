# Follower sources and authority

`agent-follow.py run|wait|drain` reconciles its selection on every tick under
`state.lock`. `selection.json` is follower-owned state; external scripts must not
rewrite it. Use `add` and `remove` for manual pins.

The default source is `$XDG_STATE_HOME/agent-mesh/registry/registry.json`
(`agent-mesh.session-registry.v1`). When that file is absent, the follower reads
`$XDG_STATE_HOME/agent-mesh/graph/graph.json` directly, so a registry producer is
not required. The XDG state home defaults to `$HOME/.local/state`.
`--registry <path>` and `--graph <path>` override these locations. Invalid registry
JSON causes that tick's reconciliation to be skipped with a diagnostic. Transcript
observation continues only for the saved selection, and reconciliation retries on
the next tick. No new sessions are discovered while degraded, and the last saved
exclusion snapshot remains in force. The follower never silently switches to
another source because of invalid data.
Missing sources preserve the selection.

Graph identities are deduplicated by `agent:runtimeUuid`. Membership excludes
closed, archived, ephemeral, subagent and automation sessions. Other identities
are included when seen within 14 days, observed live in tmux, or carrying working,
waiting-user or stalled attention. The legacy waiting-joseph attention state is
also accepted when reading existing graphs or registries; new graph observations
write waiting-user. A graph duplicate marked closed or archived
excludes the identity. No transcript contents are needed to establish membership.

Each tick adds source members, adopts discovery entries once the source knows
them, and removes source-owned entries that leave membership. Removal emits one
`CLOSED` line. CLI pins survive membership removal. Discovery/bridge entries already excluded
by the source emit `CLOSED` even before adoption. Legacy projection-owned entries
migrate to graph ownership during the follower's locked reconciliation.
Discovery remains a faster
path for new activity; source exclusions also apply there. Previously source-owned
identities are temporarily protected against re-addition by transcript growth
after leaving membership. Only departed identities are retained as tombstones,
with a 14-day expiry and a maximum of 4096 entries (newest expirations retained).
Current membership comes from the source and does not accumulate in this history.
Each successful reconciliation also replaces the saved exclusion snapshot with
that source's current rejections plus the bounded tombstones; rejected identities
from older snapshots do not accumulate.
Expired or evicted identities may be discovered again if they grow and the source
has no exclusion for them.

All selections default to `observe`, including CLI pins. Mode is recomputed each
tick: an explicit graph `delegates-to` edge from `--self` (or its recorded claim
predecessor chain) permits `steer`; an explicit graph `spawned-by` edge from self
or a selected parent permits `child`. Both edge types run from parent/owner to
child. Registry `delegatedBy` and `spawnedBy` are provenance, not authority;
control modes require the explicit edge in the graph. A bridge caller grants
no authority. `add --mode steer` and `add --mode child` are rejected; CLI additions
support only `observe`. A bridge spawn with an unknown/unselected caller is
observed and emits a line. Resume launches never establish parentage.
A child of self uses the owner's short identity as its parent label. The follower
never sends, resumes, archives, or controls a session itself.

Optional private JSON configuration:

```json
{
  "follower": {
    "bootstrapHours": 336,
    "openWindowDays": 14,
    "scope": {
      "includeDomains": ["sample"],
      "excludeDomains": ["excluded"],
      "unknownDomain": "observe"
    }
  }
}
```

Scope defaults to all domains and unknown domains observed. Exclusions win over
inclusions. `unknownDomain: "exclude"` excludes identities with no domain metadata.
Scope affects automatic additions from both the source and transcript discovery;
CLI pins survive scope changes. Registry policy overrides `openWindowDays`.
Without a source, the first discovery scan looks back `bootstrapHours` instead of
starting at now. Historical bootstrap/resumed sessions start at transcript EOF;
new sessions and bridge spawns retain the existing history replay behavior.

`list --name <name> --coverage [--config <path>] [--self <agent:uuid>]` prints JSON
containing each source identity's selected status and exclusion reason. It does
not reconcile or rewrite the selection. No Markdown registry is read.

The registry, graph, follower state and coverage output can contain private titles
and paths. Keep these local; public tests use synthetic identities and domains.
