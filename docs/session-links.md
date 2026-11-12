# Local session link verification

`mesh-graph links verify [--apply] [--json]` inspects every graph node with a
classified catalog role, and every cloud identity. It follows explicit
`supersededBy` and renewal chains. Cycles, ambiguous or absent successors are
reported as dead. Unclassified local nodes are excluded; roles are never inferred
from titles or stale claims.

Claude evidence priority is the newest transcript `bridgeSessionId`, a live
process metadata file, then the newest matching Desktop record. `cse_` IDs are
normalized to `session_` links. Desktop archive evidence is preserved. Cloud
identities supply their own link when no Desktop record matches. This preserves
the registered identity and does not prove remote availability. Bridge-spawn directories alone contain no authoritative local
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
Missing/dead/archived outcomes retain the last known link from `sessionLink.link`,
then current `session-link:session_*` refs (authoritative open graph links when
migrated, node refs otherwise). Migrated refs prefer the newest `since` timestamp
with a stable identity tie-break; legacy refs use lexical order. An observed link
is also retained when neither store has prior evidence. Retained links carry
`lastKnown: true` in JSON results and persisted metadata; status and reason remain
as observed. Fresh successful observations clear `lastKnown`. Consumers must
consult `sessionLink.status`; a retained URL is not remote reachability proof. No node is closed, archived or granted a role.

JSON output includes `checkedAt`, `applied` and `results`, each with node/session,
resolved session, role/project, status, evidence source, reason and successor chain.
Native source failures fail the command instead of presenting an incomplete success.

Source roots use the existing `CLAUDE_SESSION_ROOT`,
`CLAUDE_SESSION_METADATA_ROOT`, and `CODEX_STATE_DB` environment variables, plus
`CLAUDE_DESKTOP_SESSION_ROOT` for Desktop records. Defaults derive from the current
user home. Fixtures must override all four roots.

## Self observation and catalog metadata

`links verify --session <exact-session-id>` restricts both native reads and graph
writes to nodes of that classified session. The JSON `session` field echoes the
requested scope (null for a full scan). Unknown or unclassified requested sessions
fail before native reads or graph writes. Successor resolution stays available.

`catalog register|update --label-only --role director --project <slug>` declares
metadata without acquiring, replacing or renewing any role claim. It permits
multiple native Directors to be catalogued for one project. An existing live claim
on the same identity still prevents conflicting role/project metadata. Operational
state writers continue to require their exact active claim token.

## Cloud catalog labels

`catalog register|update` accepts an existing `claude-cloud:<scope>:<native-id>`
identity. Use `cloud register` first for a new attested cloud identity. Cloud
catalog operations change only role/project/title/status metadata, never native
adoption, activity, transport state or leases. `role claim|heartbeat|check|release`
accepts the same exact cloud identity once it is registered; any other cloud form is
refused. Cloud summary and runtime mutation options are refused.

`catalog list` includes cloud identities with the same role/project/archive filters.
When stored evidence exists, each row includes `sessionLink` with `link`, `status`,
`lastKnown` and `checkedAt`; listing never probes or fabricates fresh link evidence.
