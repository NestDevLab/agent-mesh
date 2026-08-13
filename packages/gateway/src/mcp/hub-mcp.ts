import {
  McpServer,
  createMcpHandler,
  type AuthInfo,
  type McpHttpHandler
} from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  registerGoogleWorkspaceTools,
  type GoogleWorkspaceAccountAlias,
  type GoogleWorkspaceRunner
} from "./google-workspace.js";
import {
  registerMeshMcpTools,
  type MeshMcpHttpOptions,
  type MeshMcpPrincipal
} from "./mesh-mcp.js";
import { registerMemoryRecallTools, type MemoryRecallRunner } from "./memory-recall.js";

export type McpHubProfile = "google-workspace" | "memory" | "workspace";

export interface McpHubPrincipal {
  mesh: MeshMcpPrincipal;
  allowedGoogleAccounts: readonly GoogleWorkspaceAccountAlias[];
}

export interface McpHubOptions extends Omit<MeshMcpHttpOptions, "resolvePrincipal"> {
  profile: McpHubProfile;
  googleRunner: GoogleWorkspaceRunner;
  resolvePrincipal(authInfo: AuthInfo, request: Request): McpHubPrincipal | Promise<McpHubPrincipal>;
  memoryState: "setup_required" | "ready" | "degraded";
  memoryRunner?: MemoryRecallRunner;
}

export function createMcpHubHandler(options: McpHubOptions): McpHttpHandler {
  const principalKey = "hubPrincipal";
  const handler = createMcpHandler((context) => {
    const principal = context.authInfo?.extra?.[principalKey];
    if (!isHubPrincipal(principal)) throw new Error("Verified MCP hub principal is missing.");
    const server = new McpServer({ name: profileName(options.profile), version: "0.9.0" });

    if (options.profile === "workspace") {
      registerMeshMcpTools(server, { ...options, principal: principal.mesh });
    }
    if (options.profile === "workspace" || options.profile === "google-workspace") {
      registerGoogleWorkspaceTools(server, {
        runner: options.googleRunner,
        allowedAccounts: principal.allowedGoogleAccounts
      });
    }
    if (options.profile === "workspace" || options.profile === "memory") {
      if (options.memoryRunner !== undefined) registerMemoryRecallTools(server, options.memoryRunner);
      server.registerTool(
        "memory_backend_status",
        {
          title: "Read memory backend availability",
          description: "Reports whether the dedicated least-privilege memory connection is ready.",
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false
          },
          inputSchema: z.object({})
        },
        async () => {
          const state = options.memoryRunner === undefined ? options.memoryState : await options.memoryRunner.status();
          return {
            content: [{ type: "text", text: JSON.stringify({ state }) }],
            structuredContent: { state }
          };
        }
      );
    }
    return server;
  }, { legacy: "reject", responseMode: "json" });

  const fetch = handler.fetch;
  handler.fetch = async (request, requestOptions) => {
    if (requestOptions?.authInfo === undefined) return jsonError(401, "MCP authentication required.");
    try {
      const principal = await options.resolvePrincipal(requestOptions.authInfo, request);
      if (!isHubPrincipal(principal)) return jsonError(403, "MCP principal is invalid.");
      return fetch(request, {
        ...requestOptions,
        authInfo: {
          ...requestOptions.authInfo,
          extra: { ...requestOptions.authInfo.extra, [principalKey]: principal }
        }
      });
    } catch {
      return jsonError(403, "MCP principal is not authorized.");
    }
  };
  return handler;
}

function profileName(profile: McpHubProfile): string {
  return profile === "workspace" ? "example-business-workspace" : `example-business-${profile}`;
}

function isHubPrincipal(value: unknown): value is McpHubPrincipal {
  if (typeof value !== "object" || value === null) return false;
  const principal = value as Partial<McpHubPrincipal>;
  return typeof principal.mesh === "object" && Array.isArray(principal.allowedGoogleAccounts);
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" }
  });
}
