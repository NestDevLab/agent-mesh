# MCP hub ingress

`src/mcp/mesh-mcp.ts` exposes a provider-neutral, Streamable HTTP MCP handler.
It converts a web-chat request into a normal Agent Mesh A2A `request` envelope.
The task tools add a durable MCP-facing lifecycle around that same governed
request path; they do not bypass the
gateway's context, agent, policy, idempotency, audit, or transport controls.

## Tools

| Tool | Effect |
| --- | --- |
| `mesh_list_agents` | Lists the explicit endpoints exposed by the deployment. |
| `mesh_send` | Sends an A2A request to one exposed endpoint. |
| `mesh_delivery_status` | Reads recorded delivery lifecycle events. |
| `mesh_call` | Submits a durable task and waits up to 120 seconds for its correlated result. |
| `mesh_submit` | Submits a durable task and immediately returns its handle. |
| `mesh_task_get` | Reads an owned task's status and result. |
| `mesh_task_cancel` | Marks an owned task cancelled and ignores a late result. |
| `mesh_thread_get` | Reads the ordered owned tasks in one context. |
| `mesh_agent_sessions_list` | Lists bounded, path-free native session metadata inside one allowed workspace. |
| `mesh_agent_session_get` | Reads bounded metadata for one allowed native session. |

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

## Serving safely

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
| `/memory` | Memory backend availability only until a dedicated AMF principal is provisioned. |
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
Activate AMF search/read tools only after provisioning a dedicated MCP
principal with explicit vault and scope grants. Until then, keep
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

Grant `mesh_agent_sessions_list` and `mesh_agent_session_get` independently in
the principal binding. Listing returns only session ID, logical agent/provider,
workspace, discovery status, and update time; host paths and transcripts stay
inside the provider adapter. A discovered session is not claimed to have a free
writer. The bridge checks the live writer immediately before a prompt is sent.
An active Codex session uses Codex's native queue and collects the result only
after the uniquely marked user turn. A session without a writer uses the
existing resume/tmux transport. An active Claude session fails closed because
the currently supported Claude CLI exposes discovery/resume but no equivalent
safe queue command; resumable Claude sessions remain supported.

Static `tmuxIngress` remains unchanged for dedicated ingress sessions. A task
without `session_id` continues to use that route. A task with `session_id` uses
only `agent-session-transport` as its authoritative result transport, while
the existing simulation and transcript audit adapters remain intact.
