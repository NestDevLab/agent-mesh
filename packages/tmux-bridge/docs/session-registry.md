# Generated session registry

The graph event stream is canonical. `mesh-graph registry --json` projects it to
`$XDG_STATE_HOME/agent-mesh/registry/registry.json` (default state home
`~/.local/state`). Override the output with `--registry-out <path>` and the open
window with `--open-window-days 14`. `mesh-graph sweep --registry-out <path>`
updates the registry under the same graph lock, after its graph projection.

The output directory must belong to the current user, with mode 0700; newly
created directories use that mode. Output is atomically replaced with mode 0600.
Symlink outputs are rejected. Identical content preserves bytes and mtime;
`generatedAt` changes only when projected content changes. Invalid graph input
fails before replacing the previous registry. Titles and working directories are
private local state; never commit generated registries to a public repository.

## Contract

`schema` is `agent-mesh.session-registry.v1`. `generatedAt` and
`graphGeneratedAt` are ISO timestamps. `policy.openWindowDays` is positive.
`sessions` maps `codex:<uuid>` or `claude:<uuid>` to:

- `agent`, `runtimeUuid`, sorted `nodeIds`, `cwd`, `domains`, `title`,
  `createdAt`, `lastSeenAt`, `status`, `attention`, `surface`, `class`, `origin`;
- `tmuxTargets` (all recorded targets), `tmuxLive` (explicit live observation),
  and the union of opaque `refs`;
- `launches` with `launchId`, `kind`, `caller|null`, `at`; `spawnedBy|null`
  and `delegatedBy` resolved to runtime identities.

Duplicates merge deterministically: newest metadata, unions of domains/refs and
recorded targets, and conservative archived/closed/noise exclusions. A recorded
but missing target does not count as live. Members exclude ephemeral, subagent,
automation, archived and closed identities; otherwise recent activity, a live
target, working/waiting attention (including legacy `waiting-joseph` reads), or
stalled attention keeps an identity open. Unknown domains remain valid members;
the follower applies its own private scope.

`excluded` maps nonmembers to reasons, preventing fast follower discovery from
resurrecting them. `recentlyClosed` contains archived/closed identities observed
within 30 days for generated history views. No transcript bodies or summaries are
included. Link external work through opaque graph refs.

Sweep/discover persist transcript origin and bridge launch history. Started and
resolved launch events join by launchId; old events infer spawn from an initially
missing threadId. Unknown callers become null. Resume alone never makes a human
session a bridge child. Provenance is metadata, never steering permission:
`agent-follow.py` continues to require explicit graph `delegates-to` for steering
and `spawned-by` for child mode. Registry membership grants observation only.
