# MCP hub ingress

`src/mcp/mesh-mcp.ts` exposes a provider-neutral, Streamable HTTP MCP handler.
It converts a web-chat request into a normal Agent Mesh A2A `request` envelope.
The task tools add a durable MCP-facing lifecycle around that same governed
request path; they do not bypass the
gateway's context, agent, policy, idempotency, audit, or transport controls.

## Tools

| Tool | Effect |
| --- | --- |
| `mesh_list_agents` | Lists the explicit endpoints exposed by the deployment and their capabilities. |
| `mesh_send` | Sends an A2A request to one exposed endpoint. |
| `mesh_delivery_status` | Reads recorded delivery lifecycle events. |
| `mesh_call` | Submits a durable task and waits up to 120 seconds for its correlated result. |
| `mesh_submit` | Submits a durable task and immediately returns its handle. |
| `mesh_task_get` | Reads an owned task's status and result. |
| `mesh_task_cancel` | Marks an owned task cancelled and ignores a late result. |
| `mesh_thread_get` | Reads the ordered owned tasks in one context. |
| `mesh_agent_sessions_list` | Lists bounded, path-free native session metadata inside one allowed workspace. |
| `mesh_agent_session_create` | Starts a new Codex session with a host-allowed access profile and returns its native ID. |
| `mesh_agent_session_get` | Reads bounded metadata for one allowed native session. |
| `mesh_agent_sessions_search` | Searches visible user and assistant text in native transcripts. |
| `mesh_agent_session_transcript` | Reads a paginated visible transcript for one native session ID. |

The host provides a verified request-scoped principal, its exact tool, agent,
workspace, and domain scopes, a shared rate limiter, and a configured
`AgentMeshGateway`. Codex and Claude are ordinary endpoint records; no
provider-specific API is part of the MCP surface. Delivery and task state are
visible only to the principal that submitted the corresponding request.
Task state is append-only NDJSON and survives gateway restarts. Idempotency is
scoped to the principal, and tasks targeting the same agent are serialized.
Cancellation is cooperative: it makes the task terminal but does not terminate
an already-running agent process.

`mesh_call` and `mesh_submit` accept an optional `session_id`. When present,
the gateway verifies the session against the target agent and authenticated
workspace before creating the task. The task then preserves `session_id`,
`task_id`, `message_id`, and `context_id` through delivery, audit, and result
capture. A session ID is a routing coordinate, not an authorization grant.

They also accept `session_mode: "fresh"`, which starts a new provider session
instead of continuing one; see [Fresh sessions](#fresh-sessions). Omitting both
fields keeps the static route. When `context_id` is omitted the gateway mints
one, and it is excluded from the idempotency comparison, so an exact replay
returns the original task.

### Capability discovery

`mesh_list_agents` returns each exposed agent's configured `capabilities`.
The gateway adds `create_session` to an agent when its session provider has
fresh sessions configured for at least one of the caller's workspaces. Callers should check for it before sending
`session_mode: "fresh"`; the tool call still enforces it.

## Serving safely

For standalone Linux service installation and boot-safe runtime directories, see
[Systemd deployment](systemd-deployment.md). Fleet orchestration is optional.

Mount `createMeshMcpHandler(options).fetch` at `/mcp` using a Streamable HTTP
host. The handler fails closed unless the host passes validated `AuthInfo` and
the configured resolver maps it to a principal. Keep it behind an OAuth-aware
reverse proxy and validate the proxy assertion at the origin. The optional
Cloudflare Access adapter validates signature, issuer, audience, expiry, and an
explicit user or service binding. Do not expose the endpoint directly to the
public Internet without authentication, request limits, and TLS. The handler
rejects legacy MCP traffic and does not start a listener by itself.

## Modular profiles

The HTTP host keeps Agent Mesh as the communication core while exposing
separate least-privilege MCP profiles on one hostname:

| Path | Surface |
| --- | --- |
| `/agent-mesh` | Existing governed A2A request and delivery tools. |
| `/google-workspace` | Read-only Drive search/list/read, Sheets metadata/ranges, Gmail search, and Calendar event listing. |
| `/memory` | Governed AMF tools granted to a dedicated MCP principal. |
| `/workspace` | Aggregated Agent Mesh and Google Workspace tools plus memory availability. |

Each enabled path has its own Cloudflare Access audience. Set
`AGENT_MESH_MCP_WORKSPACE_AUDIENCE`,
`AGENT_MESH_MCP_GOOGLE_WORKSPACE_AUDIENCE`, and
`AGENT_MESH_MCP_MEMORY_AUDIENCE` to enable the corresponding optional profile.
The original `AGENT_MESH_MCP_AUDIENCE` remains mandatory and applies only to
`/agent-mesh`.

Google account addresses and OAuth client selection live in the protected
runtime configuration under `googleWorkspace.accounts`. Access bindings must
also name `allowedGoogleAccounts` (`work`, `personal`, or both). The adapter
executes the absolute `gog` binary without a shell, forces JSON and
non-interactive mode, caps result counts, time, and output size, and exposes no
Google mutation command.

The Google Workspace profile exposes:

| Tool | Read-only behavior |
| --- | --- |
| `google_drive_search` | Full-text search with source metadata and `next_page_token`. |
| `google_drive_list` | Bounded folder listing with `next_page_token`. |
| `google_drive_read` | Reads Docs, PDF, and text-compatible content by ID; returns Sheets metadata and directs range reads to the dedicated tool. |
| `google_sheets_metadata` | Lists spreadsheet title, locale, timezone, sheet names, IDs, and grid sizes. |
| `google_sheets_read_range` | Reads an explicit A1 range as formatted values, raw values, or formulas. |
| `google_gmail_search` | Bounded Gmail thread search without message or label mutation. |
| `google_calendar_events` | Bounded event listing without calendar mutation. |

Text and PDF reads use `start_char` and `max_chars` continuation fields. Every
Drive content response carries the account alias, source ID, name, MIME type,
modification time, link, retrieval time, and a reminder that source timestamps
do not prove every statement is currently true. Unsupported binary formats are
reported without returning their bytes. OAuth failures use the stable
`oauth_reconnect_required` code and do not expose provider diagnostics or
credentials.

Do not point the memory profile at an existing human or harness credential.
Activate it only after provisioning a dedicated MCP principal with explicit
vault, scope, purpose, and operation grants. `memoryRecall.operatorComplete`
selects the AMF interactive MCP handoff and exposes canonical search/read,
proposal/status, document search/read/upsert/tombstone, and bounded Fabric
status. Canonical memory remains proposal-only and document writes retain AMF
revision and idempotency enforcement. The legacy `governedWrite` profile keeps
its revisioned `memory_upsert` compatibility surface and must not be combined
with `operatorComplete`. Until a dedicated handoff exists, keep
`AGENT_MESH_MCP_MEMORY_STATE=setup_required`; the status tool makes that
boundary visible without pretending the backend is connected.

## Delegated agent ingress

A real Codex or Claude route is declared under `tmuxIngress` in the protected
runtime configuration. Omit the block and the gateway keeps its stock adapters,
so every `mesh_send` stays simulated:

```json
"tmuxIngress": {
  "agentSendPath": "/opt/nestdev/tmux-bridge/bin/agent-send.sh",
  "agentType": "codex",
  "meshSocket": "mesh-ingress",
  "timeoutSeconds": 180,
  "routes": [
    {
      "target_agent_id": "agent.ingress.codex",
      "tmux_target": "mesh-codex-ingress",
      "enable_real_send": true,
      "allow_mcp_ingress": true
    }
  ]
}
```

`enable_real_send` and `allow_mcp_ingress` are independent gates and both
default to false: an existing real tmux route does not accept MCP-originated
prompts until it says so. A route may only name an agent the same config
declares, so a typo fails startup instead of creating an unaudited path.

The MCP caller never receives a shell. It submits a prompt, and a local agent
executes under its own sandbox and approval policy. `mesh_call` returns the
correlated reply directly when it completes within the wait bound;
`mesh_task_get` retrieves it later. `mesh_send` and `mesh_delivery_status`
remain transport diagnostics. Point a route at a dedicated, least-privilege
ingress session — never at an operator session.

Keep this route off any profile that also reads untrusted content. A caller
holding both `/workspace` Gmail and Drive reads and a live agent route can be
steered by text it reads, which turns an injected document into execution on
the host. Expose the agent route through `/agent-mesh` and the Google reads
through `/google-workspace`, as separate connectors.

## Native session discovery and targeting

Session targeting reuses each provider's durable session store and CLI resume
contract; Agent Mesh does not implement a second Codex or Claude session
manager. Configure the generic host bridge separately from the static tmux
route:

```json
"agentSessions": {
  "agentSessionPath": "/opt/mesh/tmux-bridge/bin/agent-session.sh",
  "agentSendPath": "/opt/mesh/tmux-bridge/bin/agent-send.sh",
  "agentNativeCallPath": "/opt/mesh/tmux-bridge/bin/agent-native-call.mjs",
  "agentManagedInboxRoot": "/var/lib/agent-mesh/claude-managed-inboxes",
  "meshSocket": "mesh-ingress",
  "timeoutSeconds": 180,
  "scanLimit": 500,
  "providers": [
    {
      "target_agent_id": "agent.ingress.codex",
      "agent_type": "codex",
      "workspace_roots": {
        "workspace.example": ["/srv/workspaces/example"]
      }
    },
    {
      "target_agent_id": "agent.ingress.claude",
      "agent_type": "claude",
      "workspace_roots": {
        "workspace.example": ["/srv/workspaces/example"]
      }
    }
  ]
}
```

Grant all four session tools independently in the principal binding. Listing
returns only session ID, logical agent/provider, workspace, discovery status,
and update time. Transcript reads and search results expose only normalized
`user` and `assistant` text with stable event IDs and timestamps; host paths,
reasoning, context records, and tool payloads remain inside the provider bridge.
A discovered session is not claimed to have a free writer. The bridge checks
the live writer immediately before a prompt is sent. An active Codex session
uses Codex's native queue and collects the result only after the uniquely marked
user turn. A session without a writer uses the existing resume/tmux transport.
Codex spawned sub-agent transcripts remain readable and searchable by exact ID,
but current app-server builds reject direct queued turns to those child IDs; the
gateway reports `session_interaction_unsupported` instead of implying a retryable
transport failure. Output from a turn that was already active before the queued
anchor is ignored; if the queued turn does not start before the result deadline,
the accepted request reports `result_timeout`, not `result_uncorrelated`.

An active Claude session is writable when the current gateway process can prove
it resumed the same CLI writer in the same single, unattached tmux pane. Each
reuse rechecks the unique Claude writer PID, its pane ancestry, and the pane
PID; the sender still refuses a busy TUI or occupied composer. This ownership
proof is process-local and disappears on gateway restart. Otherwise Claude is
writable only when the deployment explicitly owns its background inbox
transport. If Claude's TUI omits result text and the terminal collector reports
`result_uncorrelated`, the gateway checks the same authorized session's native
assistant transcript for one exact correlated marker pair. It returns that
reply only when the unique, nonempty match exists; otherwise the typed failure
is preserved. This fallback never sends another prompt.

Managed inbox files are named
`<session-id>.jsonl` under `agentManagedInboxRoot`; delivery additionally
requires exactly one known Claude CLI or Desktop writer and one bound live
supervisor lock (or an explicitly managed legacy inbox reader). The supervisor
lock records the harness and supervisor PID/start identities, so readiness does
not depend on a transient child-reader process during retries. An expired owner
is not ready; its supervisor exits and a replacement owner can claim the lock.
The native call appends a correlated peer request and waits for the matching
final transcript turn. Inbox records are never user approval and cannot expand
the receiver's permissions or mandate. Any other active Claude session remains
readable but fails with `active_external_writer`; the gateway never starts a
second writer or injects terminal keystrokes into an unproven target.

The mailbox root must belong to the harness user and have no group/other write
permission; unsafe roots fail open without activation. Claude SessionStart and
UserPromptSubmit hooks can prepare the mailbox and request a silent background
watcher. The prompt hook is a silent no-op while its owner-bound supervisor is
alive. Set `AGENT_MESH_INBOX_DISABLED=1` for noninteractive/automation launches.
The supervisor adopts the legacy `.cursors/<session-id>.json` when available;
otherwise first activation starts at EOF. It owns its cursor and advances only
after flushing the entire batch, preserving unread messages across owner exit.
See [session inbox hooks](../../tmux-bridge/docs/session-inbox-hooks.md) for the
ownership, cut-over and fail-open contract. Codex inbox hooks are disabled until
a matching producer exists; native Codex queue delivery is unchanged.

Static `tmuxIngress` remains unchanged for dedicated ingress sessions. A task
without `session_id` continues to use that route. A task with `session_id` uses
only `agent-session-transport` as its authoritative result transport, while
the existing simulation and transcript audit adapters remain intact.

## Fresh sessions

`session_mode: "fresh"` asks the target agent's session provider to start a new
session, deliver the message as its first turn, and collect the correlated
result. It is opt-in per provider and per workspace, and currently supported
for Claude only: Claude accepts a caller-chosen `--session-id`, so the task is
bound to its session before anything launches. Codex assigns the id after
launch; use `mesh_agent_session_create` for Codex instead.

For a configured Codex provider, `mesh_agent_session_create` launches an empty
session and returns its verified native session ID. It defaults to `read-only`.
The caller must explicitly set `access_profile: "full-access"`, and the host
must enable that profile in `fresh_session.access_profiles`. Unknown profiles
and unauthorized workspaces are rejected before launch. Existing sessions are
never changed. The returned ID can be used with session tools and later turns.
The gateway checks the new tmux pane, resolves one native ID from the bridge's
launch record, verifies one Codex writer belongs to that pane, and checks the
session cwd against the configured workspace roots. Failed identity or ownership
checks retire only the newly named target.

```json
{
  "target_agent_id": "agent.ingress.codex",
  "workspace_id": "workspace.example",
  "access_profile": "full-access"
}
```

The Codex provider uses the same trusted `fresh_session.workspace_cwd` map and
adds `"access_profiles": ["read-only", "full-access"]` when full access is
permitted. It must also set `full_access_socket` to a distinct, already running
host tmux server whose mount namespace can write the intended workspace. The
gateway checks that the server exists, has a different mount namespace, and
sees a writable workspace mount before launch; otherwise it fails closed. This keeps its own
read-only systemd filesystem boundary and existing session policies intact.
With `access_profiles` absent, only read-only is allowed.

```json
{
  "target_agent_id": "agent.ingress.claude",
  "workspace_id": "workspace.example",
  "session_mode": "fresh",
  "message": "Reply with nonce XYZ",
  "idempotency_key": "fresh-nonce-xyz"
}
```

The result is the normal task handle. `session_id` is the new session, and
`session_provenance` records its origin, provider, agent, and session identity.
`model` and `effort` are `"unknown"`: the launch does not pin them and they are
never inferred from the endpoint name. Later turns address the same session
with `session_id`.

Enable Claude fresh tasks on the provider with a trusted working directory per
workspace. Each directory must lie inside that workspace's `workspace_roots`;
the runtime config is rejected when it is read otherwise:

```json
{
  "target_agent_id": "agent.ingress.claude",
  "agent_type": "claude",
  "workspace_roots": { "workspace.example": ["/srv/workspaces/example"] },
  "fresh_session": {
    "workspace_cwd": { "workspace.example": "/srv/workspaces/example/agent-inbox" }
  }
}
```

The caller never supplies a command, binary, path, or working directory; the
MCP schema has no such fields and unknown arguments are dropped. The gateway
mints the session UUID and runs the bridge's own launcher:
`agent-session.sh --agent claude new <workspace_cwd> mesh-claude-<uuid> -- --session-id <uuid>`
with `MESH_STRICT_READY=1`, so a TUI that never becomes ready fails and its new
target is retired. Before sending, it requires exactly one Claude CLI writer for
that session inside the new, unattached pane, then delivers through the same
correlated result-marker path as other session turns.

| Condition | Outcome |
| --- | --- |
| `session_mode: "fresh"` together with `session_id` | Rejected: `session_mode_conflict` |
| Agent without fresh sessions configured | Rejected: `fresh_session_unsupported` |
| Workspace allowed to the principal but not configured for fresh sessions | Rejected: `fresh_session_workspace_unauthorized` |
| Launch, readiness, or writer ownership fails | Task `failed`: `fresh_session_create_failed`; no other session is used |
| Prompt not delivered | Task `failed`: `transport_failure` |
| Result missing, uncorrelated, or late | Task `failed` with the usual `result_*` code |
| Gateway restarts while the task is `working` | Task `failed`: `delivery_uncertain`; it is not re-run |

The session UUID is minted once, when the task is created. A replay with the
same `idempotency_key` and input returns that task and session and starts
nothing new; the launch itself is also idempotent because an existing target
with that name is reused rather than relaunched. A session created before a
delivery failure or cancellation stays running and is not reused by another
task.

Session profiles (for example a read-only reviewer and a write-enabled
implementer) are not implemented yet. When added, they must be server-side
allowlisted launch profiles that the caller can only select by name.

### Codex delivery guarantees

Native session calls preserve the original writer for active sessions. Cold
Codex resume explicitly restores the last recorded model, reasoning effort,
approval policy, sandbox settings, and working directory instead of inheriting
bridge or app-server defaults. Missing or unsupported policy fails before launch.
Gateway-driven resume requires a ready TUI and never submits to a leftover shell.

Task ordering is per agent/session pair; a slow session does not block unrelated
sessions. Cancellation remains cooperative and does not release that session's
execution slot while its previous executor is still running. Native result
collection follows matching transcript rollover and distinguishes accepted
requests with result timeouts/parsing errors from transport rejection. Consumers
must retain the task handle and must not resend an accepted request merely
because its result could not be collected.

## Isolated writable sessions

`mesh_call` and `mesh_submit` accept `access_mode` (default `read-only`; opt-in `workspace-write`).
See [workspace-write-sessions.md](workspace-write-sessions.md) for exact policy, worker confinement,
configuration, activation, rollback and acceptance limits. No repository is enabled implicitly.
