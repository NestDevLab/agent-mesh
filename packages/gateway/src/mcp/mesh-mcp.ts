import { randomUUID } from "crypto";
import {
  McpServer,
  createMcpHandler,
  type AuthInfo,
  type McpHttpHandler
} from "@modelcontextprotocol/server";
import { z } from "zod";

import type { DeliveryRecord } from "../schema/delivery.js";
import type { AgentMessageEnvelopeV1 } from "../schema/envelope.js";
import type { SubmitEnvelopeResult } from "../core/gateway-service.js";

const MAX_IDENTIFIER_LENGTH = 128;
const MAX_MESSAGE_LENGTH = 16_384;
const MAX_IDEMPOTENCY_KEY_LENGTH = 256;
const MAX_LABEL_LENGTH = 64;

export type MeshMcpTool = "mesh_list_agents" | "mesh_send" | "mesh_delivery_status";

/**
 * The narrow gateway surface the MCP ingress needs. Keeping this separate from
 * the host binding lets a deployment select its own transport and policy.
 */
export interface MeshMcpGateway {
  submitEnvelope(input: unknown): Promise<SubmitEnvelopeResult>;
  getEnvelope(messageId: string): Promise<AgentMessageEnvelopeV1 | undefined>;
  getDelivery(messageId: string): Promise<DeliveryRecord[]>;
}

export interface MeshMcpAgent {
  id: string;
  name: string;
  provider: "codex" | "claude" | "other";
  capabilities?: string[];
}

export interface MeshMcpOptions {
  gateway: MeshMcpGateway;
  /** Verified, request-scoped identity. Never derive this from MCP arguments. */
  principal: MeshMcpPrincipal;
  /** Explicit allow-list supplied by the deployment, never inferred from a model name. */
  agents: readonly MeshMcpAgent[];
  rateLimiter: MeshMcpRateLimiter;
  now?: () => Date;
}

export interface MeshMcpPrincipal {
  /** Opaque identity used for audit and rate limiting; do not use an email address. */
  id: string;
  kind: "user" | "service";
  requesterId: string;
  allowedTools: readonly MeshMcpTool[];
  allowedAgentIds: readonly string[];
  allowedWorkspaceIds: readonly string[];
  allowedDomainIds: readonly string[];
}

export interface MeshMcpRateLimiter {
  consume(principalId: string, tool: MeshMcpTool): boolean;
}

export interface MeshMcpHttpOptions extends Omit<MeshMcpOptions, "principal"> {
  resolvePrincipal(
    authInfo: AuthInfo,
    request: Request
  ): MeshMcpPrincipal | Promise<MeshMcpPrincipal>;
}

export class FixedWindowMeshMcpRateLimiter implements MeshMcpRateLimiter {
  private readonly windows = new Map<string, { startedAt: number; count: number }>();
  private readonly limits: Readonly<Record<MeshMcpTool, number>>;
  private readonly windowMs: number;
  private readonly nowMs: () => number;

  constructor(
    limits: Readonly<Record<MeshMcpTool, number>> = {
      mesh_list_agents: 60,
      mesh_send: 10,
      mesh_delivery_status: 60
    },
    windowMs = 60_000,
    nowMs: () => number = Date.now
  ) {
    this.limits = limits;
    this.windowMs = windowMs;
    this.nowMs = nowMs;
  }

  consume(principalId: string, tool: MeshMcpTool): boolean {
    const now = this.nowMs();
    const key = `${principalId}:${tool}`;
    const current = this.windows.get(key);
    if (current === undefined || now - current.startedAt >= this.windowMs) {
      this.windows.set(key, { startedAt: now, count: 1 });
      return true;
    }
    if (current.count >= this.limits[tool]) {
      return false;
    }
    current.count += 1;
    return true;
  }
}

export interface MeshDispatchInput {
  targetAgentId: string;
  workspaceId?: string;
  domainId?: string;
  conversationId: string;
  message: string;
  idempotencyKey?: string;
  labels?: string[];
}

export interface MeshDispatchResult {
  messageId: string;
  duplicate: boolean;
  deliveries: DeliveryRecord[];
}

/**
 * Provider-neutral A2A facade. It deliberately sends a request envelope, not
 * a "task": execution remains a separate governed flow in the mesh.
 */
export class MeshMcpFacade {
  private readonly options: MeshMcpOptions;

  constructor(options: MeshMcpOptions) {
    this.options = options;
  }

  listAgents(): readonly MeshMcpAgent[] {
    this.assertAllowed("mesh_list_agents");
    return this.options.agents
      .filter((agent) => this.options.principal.allowedAgentIds.includes(agent.id))
      .map((agent) => ({
      ...agent,
      ...(agent.capabilities === undefined ? {} : { capabilities: [...agent.capabilities] })
      }));
  }

  allowedScopes(): { workspaceIds: readonly string[]; domainIds: readonly string[] } {
    return {
      workspaceIds: [...this.options.principal.allowedWorkspaceIds],
      domainIds: [...this.options.principal.allowedDomainIds]
    };
  }

  async dispatch(input: MeshDispatchInput): Promise<MeshDispatchResult> {
    this.assertAllowed("mesh_send");
    const target = this.options.agents.find((agent) => agent.id === input.targetAgentId);
    if (target === undefined || !this.options.principal.allowedAgentIds.includes(target.id)) {
      throw new Error(`Target agent is not exposed through this MCP bridge: ${input.targetAgentId}`);
    }
    const workspaceId = resolveScope("workspace", input.workspaceId, this.options.principal.allowedWorkspaceIds);
    const domainId = resolveScope("domain", input.domainId, this.options.principal.allowedDomainIds);

    const messageId = `mcp_${randomUUID()}`;
    const result = await this.options.gateway.submitEnvelope({
      schema: "openclaw.agent.message.v1",
      message_id: messageId,
      created_at: (this.options.now?.() ?? new Date()).toISOString(),
      workspace_id: workspaceId,
      domain_id: domainId,
      conversation_id: input.conversationId,
      from: this.options.principal.requesterId,
      to: target.id,
      intent: "request",
      ttl: 3,
      hop_count: 0,
      idempotency_key:
        input.idempotencyKey === undefined
          ? messageId
          : `${this.options.principal.id}:${input.idempotencyKey}`,
      content: { text: input.message },
      sensitivity: "private",
      redaction_state: "required",
      metadata: {
        ingress: "mcp",
        a2a_operation: "request",
        principal_id: this.options.principal.id,
        principal_kind: this.options.principal.kind
      },
      ...(input.labels === undefined ? {} : { labels: input.labels })
    });

    return {
      messageId: result.envelope.message_id,
      duplicate: result.duplicate,
      deliveries: result.deliveries
    };
  }

  async deliveryStatus(messageId: string): Promise<DeliveryRecord[]> {
    this.assertAllowed("mesh_delivery_status");
    const envelope = await this.options.gateway.getEnvelope(messageId);
    if (
      envelope === undefined ||
      envelope.from !== this.options.principal.requesterId ||
      envelope.metadata?.ingress !== "mcp" ||
      envelope.metadata?.principal_id !== this.options.principal.id
    ) {
      throw new Error("Delivery is not owned by the authenticated MCP principal.");
    }
    return this.options.gateway.getDelivery(messageId);
  }

  private assertAllowed(tool: MeshMcpTool): void {
    if (!this.options.principal.allowedTools.includes(tool)) {
      throw new Error(`MCP principal is not allowed to use ${tool}.`);
    }
    if (!this.options.rateLimiter.consume(this.options.principal.id, tool)) {
      throw new Error(`Rate limit exceeded for ${tool}.`);
    }
  }
}

const identifierSchema = z.string().min(1).max(MAX_IDENTIFIER_LENGTH);
const dispatchInputSchema = z.object({
  target_agent_id: identifierSchema,
  workspace_id: identifierSchema.optional(),
  domain_id: identifierSchema.optional(),
  conversation_id: identifierSchema,
  message: z.string().min(1).max(MAX_MESSAGE_LENGTH),
  idempotency_key: z.string().min(1).max(MAX_IDEMPOTENCY_KEY_LENGTH).optional(),
  labels: z.array(z.string().min(1).max(MAX_LABEL_LENGTH)).max(20).optional()
});

const deliveryStatusSchema = z.object({
  message_id: identifierSchema
});

/** Creates a fresh MCP server instance for one HTTP serving unit. */
export function createMeshMcpServer(options: MeshMcpOptions): McpServer {
  const server = new McpServer({ name: "agent-mesh-bridge", version: "0.9.0" });
  registerMeshMcpTools(server, options);
  return server;
}

/** Registers the Agent Mesh surface on a standalone or aggregated MCP server. */
export function registerMeshMcpTools(server: McpServer, options: MeshMcpOptions): void {
  const facade = new MeshMcpFacade(options);

  if (options.principal.allowedTools.includes("mesh_list_agents")) server.registerTool(
    "mesh_list_agents",
    {
      title: "List Agent Mesh endpoints",
      description: "Lists the agent endpoints explicitly exposed by this bridge.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: z.object({})
    },
    async () => result({ agents: facade.listAgents(), allowed_scopes: facade.allowedScopes() })
  );

  if (options.principal.allowedTools.includes("mesh_send")) server.registerTool(
    "mesh_send",
    {
      title: "Send an A2A request",
      description:
        "Sends a governed Agent Mesh request to an exposed agent endpoint. This does not create or execute a task.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true
      },
      inputSchema: dispatchInputSchema
    },
    async (input) => {
      try {
        return result(
          await facade.dispatch({
            targetAgentId: input.target_agent_id,
            workspaceId: input.workspace_id,
            domainId: input.domain_id,
            conversationId: input.conversation_id,
            message: input.message,
            idempotencyKey: input.idempotency_key,
            labels: input.labels
          })
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  if (options.principal.allowedTools.includes("mesh_delivery_status")) server.registerTool(
    "mesh_delivery_status",
    {
      title: "Read Agent Mesh delivery status",
      description: "Returns the recorded delivery lifecycle for a previously sent request.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: deliveryStatusSchema
    },
    async ({ message_id }) => {
      try {
        return result({ messageId: message_id, deliveries: await facade.deliveryStatus(message_id) });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

}

function resolveScope(kind: "workspace" | "domain", supplied: string | undefined, allowed: readonly string[]): string {
  if (supplied !== undefined) {
    assertScope(kind, supplied, allowed);
    return supplied;
  }
  if (allowed.length !== 1) throw new Error(`${kind} must be specified because the MCP principal has multiple allowed scopes.`);
  return allowed[0];
}

/**
 * Streamable-HTTP handler for the MCP endpoint. The hosting boundary must
 * authenticate requests before passing verified auth information to it.
 */
export function createMeshMcpHandler(options: MeshMcpHttpOptions): McpHttpHandler {
  const principalKey = "meshPrincipal";
  const handler = createMcpHandler((context) => {
    const principal = context.authInfo?.extra?.[principalKey];
    if (!isMeshMcpPrincipal(principal)) {
      throw new Error("Verified MCP principal is missing.");
    }
    return createMeshMcpServer({ ...options, principal });
  }, {
    legacy: "reject",
    responseMode: "json"
  });
  const fetch = handler.fetch;
  handler.fetch = async (request, requestOptions) => {
    if (requestOptions?.authInfo === undefined) {
      return jsonError(401, "MCP authentication required.");
    }
    try {
      const principal = await options.resolvePrincipal(requestOptions.authInfo, request);
      if (!isMeshMcpPrincipal(principal)) {
        return jsonError(403, "MCP principal is invalid.");
      }
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

function assertScope(kind: string, value: string, allowed: readonly string[]): void {
  if (!allowed.includes(value)) {
    throw new Error(`${kind} is not allowed for the authenticated MCP principal: ${value}`);
  }
}

function isMeshMcpPrincipal(value: unknown): value is MeshMcpPrincipal {
  if (typeof value !== "object" || value === null) return false;
  const principal = value as Partial<MeshMcpPrincipal>;
  return (
    typeof principal.id === "string" &&
    principal.id.length > 0 &&
    (principal.kind === "user" || principal.kind === "service") &&
    typeof principal.requesterId === "string" &&
    Array.isArray(principal.allowedTools) &&
    Array.isArray(principal.allowedAgentIds) &&
    Array.isArray(principal.allowedWorkspaceIds) &&
    Array.isArray(principal.allowedDomainIds)
  );
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>
  };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown Agent Mesh MCP error";
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true
  };
}
