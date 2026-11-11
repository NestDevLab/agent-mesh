# Local session link verification

`mesh-graph links verify [--apply] [--json]` inspects every graph node with a
classified catalog role, and every cloud identity. It follows explicit
`supersededBy` and renewal chains. Cycles, ambiguous or absent successors are
reported as dead. Unclassified local nodes are excluded; roles are never inferred
from titles or stale claims.

Claude evidence priority is the newest transcript `bridgeSessionId`, a live
process metadata file, then the newest matching Desktop record. `cse_` IDs are
normalized to `session_` links. Desktop archive evidence is preserved. Cloud
identities require matching native evidence; an attested ID alone does not prove
availability. Bridge-spawn directories alone contain no authoritative local
session association and do not establish a working link.

Codex links are thread IDs: the native SQLite row must exist and be unarchived.
The database is opened read-only. Missing native stores or bridge evidence yield
`missing`; a missing thread row yields `dead`. A newly resolved or replaced link
yields `changed`, subsequent matching checks yield `ok`. `archived` reflects native
metadata. Claude `ok` means a locally evidenced link, not authenticated remote
reachability: this command makes no network calls and never restarts Remote Control.

Without `--apply` the graph is unchanged. Apply appends replayable node events
containing `sessionLink` with checked/changed timestamps and a `session-link:` ref
through existing graph links. Historical refs stay in the link event history.
Missing/dead/archived outcomes preserve prior refs as historical evidence; consumers
must consult `sessionLink.status`. No node is closed, archived or granted a role.

JSON output includes `checkedAt`, `applied` and `results`, each with node/session,
resolved session, role/project, status, evidence source, reason and successor chain.
Native source failures fail the command instead of presenting an incomplete success.

Source roots use the existing `CLAUDE_SESSION_ROOT`,
`CLAUDE_SESSION_METADATA_ROOT`, and `CODEX_STATE_DB` environment variables, plus
`CLAUDE_DESKTOP_SESSION_ROOT` for Desktop records. Defaults derive from the current
user home. Fixtures must override all four roots.
