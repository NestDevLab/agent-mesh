import type { McpHttpHandler } from "@modelcontextprotocol/server";
import { requireCloudflareAccess, type CloudflareAccessRequestAuthenticator } from "./cloudflare-access.js";
import { createMeshMcpHandler, type MeshMcpHttpOptions, type MeshMcpPrincipal } from "./mesh-mcp.js";

const allowed = new Set(["mesh_plexus_work_items", "mesh_plexus_ledger_sessions"]);
const denied = () => new Response(JSON.stringify({ error: "Plexus read unavailable." }), {
  status: 403, headers: { "content-type": "application/json", "cache-control": "no-store" }
});

/** A request-bound user-only profile; no service identity or other MCP tool is exposed. */
export function createOikumaPlexusHandler(
  options: MeshMcpHttpOptions,
  authenticator: CloudflareAccessRequestAuthenticator
): McpHttpHandler {
  const handler = createMeshMcpHandler(options);
  handler.fetch = async (request, requestOptions) => {
    const auth = requestOptions?.authInfo;
    if (!auth || typeof auth.expiresAt !== "number" || !Number.isFinite(auth.expiresAt) || auth.expiresAt <= Date.now()/1000) return denied();
    try {
      const principal = await options.resolvePrincipal(auth, request);
      if (principal.kind !== "user" || principal.plexusLedgerOwner !== true) return denied();
      const scoped: MeshMcpPrincipal = { ...principal, allowedTools: principal.allowedTools.filter(tool => allowed.has(tool)) };
      const inner = createMeshMcpHandler({ ...options, resolvePrincipal: () => scoped });
      const response = await inner.fetch(request, requestOptions);
      const bytes = await response.arrayBuffer();
      const current = await options.resolvePrincipal(auth, request);
      if (auth.expiresAt <= Date.now()/1000 || JSON.stringify(current) !== JSON.stringify(principal)) return denied();
      const headers = new Headers(response.headers);
      headers.set("cache-control", "no-store");
      return new Response(response.status === 204 || response.status === 304 ? null : bytes,
        { status: response.status, statusText: response.statusText, headers });
    } catch { return denied(); }
  };
  return requireCloudflareAccess(handler, authenticator, () => {});
}
