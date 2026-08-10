# Agent Mesh MCP ingress

`src/mcp/mesh-mcp.ts` exposes a provider-neutral, Streamable HTTP MCP handler.
It converts a web-chat request into a normal Agent Mesh A2A `request` envelope.
It does not create an execution job or a task, and it does not bypass the
gateway's context, agent, policy, idempotency, audit, or transport controls.

## Tools

| Tool | Effect |
| --- | --- |
| `mesh_list_agents` | Lists the explicit endpoints exposed by the deployment. |
| `mesh_send` | Sends an A2A request to one exposed endpoint. |
| `mesh_delivery_status` | Reads recorded delivery lifecycle events. |

The host provides the requesting mesh identity, the exact allowed endpoints,
and a configured `AgentMeshGateway`. Codex and Claude are ordinary endpoint
records; no provider-specific API is part of the MCP surface.

## Serving safely

Mount `createMeshMcpHandler(options).fetch` at `/mcp` using a Streamable HTTP
host. Keep the handler behind an OAuth-aware reverse proxy or another token
validator which passes verified authentication to the handler. Do not expose
the endpoint directly to the public Internet without authentication, request
limits, and TLS. The handler rejects legacy MCP traffic and does not start a
listener by itself.

For a real Codex or Claude route, inject the existing `TmuxTransportAdapter`
with an explicit route whose `enable_real_send` is true. The adapter remains
dry-run-first when no such route is configured.
