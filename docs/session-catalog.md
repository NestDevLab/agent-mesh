# Session catalog metadata

`mesh-graph catalog list --archive exclude|include|only --title <text>` and the
workspace-scoped MCP session list share the catalog normalizer and filter contract.
`exclude` is the default: confirmed archived sessions are hidden; unknown archive
state remains visible. Archive state comes exclusively from explicit native metadata,
not quiet, closed, waiting, or writer availability.

The local bridge joins native transcript enumeration to the existing sweep index,
including indexed native archived and database-only sessions. The index is refreshed
by the existing discovery/sweep controller, not by a model-maintained list. MCP first
checks workspace authorization and filters by native cwd roots, then applies catalog
filters and pagination. It returns only selected metadata, never graph relationships,
paths, or transcript excerpts. `discovery_truncated` conservatively warns when native
transcript discovery reached its configured scan limit; no global completeness is
claimed. Indexed metadata is a snapshot, not a live writer check.

| Field | Evidence |
| --- | --- |
| `title`, `title_source` | Explicit operator title, native title, or unavailable |
| `summary`, `summary_source` | Explicit session description or legacy graph summary; no raw transcript fallback |
| `summary_updated_at` | Time the description changed; never a generic graph update |
| `last_activity_at` | Last native observation recorded by discovery; independent from description edits |
| `summary_freshness` | missing, unknown timestamp, current, or stale relative to last activity |
| `archived`, `archive_source` | Native true/false, or null/unavailable |

Sessions publish `[[mesh-summary: one short current-work description]]` as an explicit
assistant line. The incremental watcher collects assistant-origin markers, ignores
user/tool messages, and leaves unchanged descriptions' timestamps intact. Sweep
collects the latest changed native description without additional scheduling or model
calls. Direct `catalog update --session <agent:uuid> --summary <text>` also works.
Skill instructions explain participation and prohibit sensitive content.

Automatic model enrichment is not enabled. Missing/stale descriptions are explicit;
there is no transcript-as-summary fallback, mass backfill, or new scheduler. A future
optional enrichment adapter needs an approved provider route, privacy scope, quota,
bounded delta budget, deduplication and no-change cache/backoff before activation.
