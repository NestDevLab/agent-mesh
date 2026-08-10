import { randomUUID } from "crypto";
import { McpServer, createMcpHandler, type McpHttpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { DeliveryRecord } from "../schema/delivery.js";
import type { SubmitEnvelopeResult } from "../core/gateway-service.js";

/**
 * The narrow gateway surface the MCP ingress needs. Keeping this separate from
 * the host binding lets a deployment select its own transport and policy.
 */
export interface MeshMcpGateway {
  submitEnvelope(input: unknown): Promise<SubmitEnvelopeResult>;
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
  /** The registered mesh identity used as the sender of all MCP requests. */
  requesterId: string;
  /** Explicit allow-list supplied by the deployment, never inferred from a model name. */
  agents: readonly MeshMcpAgent[];
  now?: () => Date;
}

export interface MeshDispatchInput {
  targetAgentId: string;
  workspaceId: string;
  domainId: string;
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
    return this.options.agents.map((agent) => ({
      ...agent,
      ...(agent.capabilities === undefined ? {} : { capabilities: [...agent.capabilities] })
    }));
  }

  async dispatch(input: MeshDispatchInput): Promise<MeshDispatchResult> {
    const target = this.options.agents.find((agent) => agent.id === input.targetAgentId);
    if (target === undefined) {
      throw new Error(`Target agent is not exposed through this MCP bridge: ${input.targetAgentId}`);
    }

    const messageId = `mcp_${randomUUID()}`;
    const result = await this.options.gateway.submitEnvelope({
      schema: "openclaw.agent.message.v1",
      message_id: messageId,
      created_at: (this.options.now?.() ?? new Date()).toISOString(),
      workspace_id: input.workspaceId,
      domain_id: input.domainId,
      conversation_id: input.conversationId,
      from: this.options.requesterId,
      to: target.id,
      intent: "request",
      ttl: 3,
      hop_count: 0,
      idempotency_key: input.idempotencyKey ?? messageId,
      content: { text: input.message },
      sensitivity: "private",
      redaction_state: "required",
      metadata: { ingress: "mcp", a2a_operation: "request" },
      ...(input.labels === undefined ? {} : { labels: input.labels })
    });

    return {
      messageId: result.envelope.message_id,
      duplicate: result.duplicate,
      deliveries: result.deliveries
    };
  }

  async deliveryStatus(messageId: string): Promise<DeliveryRecord[]> {
    return this.options.gateway.getDelivery(messageId);
  }
}

const dispatchInputSchema = z.object({
  target_agent_id: z.string().min(1),
  workspace_id: z.string().min(1),
  domain_id: z.string().min(1),
  conversation_id: z.string().min(1),
  message: z.string().min(1),
  idempotency_key: z.string().min(1).optional(),
  labels: z.array(z.string().min(1)).max(20).optional()
});

const deliveryStatusSchema = z.object({
  message_id: z.string().min(1)
});

/** Creates a fresh MCP server instance for one HTTP serving unit. */
export function createMeshMcpServer(options: MeshMcpOptions): McpServer {
  const facade = new MeshMcpFacade(options);
  const server = new McpServer({ name: "agent-mesh-bridge", version: "0.9.0" });

  server.registerTool(
    "mesh_list_agents",
    {
      title: "List Agent Mesh endpoints",
      description: "Lists the agent endpoints explicitly exposed by this bridge.",
      inputSchema: z.object({})
    },
    async () => result({ agents: facade.listAgents() })
  );

  server.registerTool(
    "mesh_send",
    {
      title: "Send an A2A request",
      description:
        "Sends a governed Agent Mesh request to an exposed agent endpoint. This does not create or execute a task.",
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

  server.registerTool(
    "mesh_delivery_status",
    {
      title: "Read Agent Mesh delivery status",
      description: "Returns the recorded delivery lifecycle for a previously sent request.",
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

  return server;
}

/**
 * Streamable-HTTP handler for the MCP endpoint. The hosting boundary must
 * authenticate requests before passing verified auth information to it.
 */
export function createMeshMcpHandler(options: MeshMcpOptions): McpHttpHandler {
  return createMcpHandler(() => createMeshMcpServer(options), {
    legacy: "reject",
    responseMode: "json"
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
