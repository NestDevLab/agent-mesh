import { randomUUID } from "crypto";
import {
  McpServer,
  createMcpHandler,
  type AuthInfo,
  type McpHttpHandler
} from "@modelcontextprotocol/server";
import { z } from "zod";

import type { DeliveryRecord } from "../schema/delivery.js";
import type { AuditEvent, AuditFilter } from "../schema/audit.js";
import type { AgentMessageEnvelopeV1 } from "../schema/envelope.js";
import type { SubmitEnvelopeResult } from "../core/gateway-service.js";
import type {
  AgentSessionPage,
  AgentSessionRegistry,
  AgentSessionSummary
} from "../adapters/agent-session-provider.js";
import { MeshTaskCoordinator } from "./mesh-task-coordinator.js";
import type { MeshTaskRecord } from "./mesh-task-store.js";

const MAX_IDENTIFIER_LENGTH = 128;
const MAX_MESSAGE_LENGTH = 16_384;
const MAX_IDEMPOTENCY_KEY_LENGTH = 256;
const MAX_LABEL_LENGTH = 64;

export const MESH_MCP_TOOLS = [
  "mesh_list_agents",
  "mesh_send",
  "mesh_delivery_status",
  "mesh_call",
  "mesh_submit",
  "mesh_task_get",
  "mesh_task_cancel",
  "mesh_thread_get",
  "mesh_agent_sessions_list",
  "mesh_agent_session_get"
] as const;

export type MeshMcpTool = (typeof MESH_MCP_TOOLS)[number];

/**
 * The narrow gateway surface the MCP ingress needs. Keeping this separate from
 * the host binding lets a deployment select its own transport and policy.
 */
export interface MeshMcpGateway {
  submitEnvelope(input: unknown): Promise<SubmitEnvelopeResult>;
  getEnvelope(messageId: string): Promise<AgentMessageEnvelopeV1 | undefined>;
  getDelivery(messageId: string): Promise<DeliveryRecord[]>;
  listAudit(filter?: AuditFilter): Promise<AuditEvent[]>;
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
  taskCoordinator?: MeshTaskCoordinator;
  sessionRegistry?: AgentSessionRegistry;
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
      mesh_delivery_status: 60,
      mesh_call: 6,
      mesh_submit: 10,
      mesh_task_get: 120,
      mesh_task_cancel: 20,
      mesh_thread_get: 60,
      mesh_agent_sessions_list: 30,
      mesh_agent_session_get: 60
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

export interface MeshTaskDispatchInput {
  targetAgentId: string;
  sessionId?: string;
  workspaceId?: string;
  domainId?: string;
  contextId?: string;
  message: string;
  idempotencyKey: string;
  labels?: string[];
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

  async submitTask(input: MeshTaskDispatchInput): Promise<{ task: MeshTaskRecord; duplicate: boolean }> {
    this.assertAllowed("mesh_submit");
    return this.coordinator().submit(await this.taskInput(input));
  }

  async callTask(input: MeshTaskDispatchInput, waitMs: number): Promise<{ task: MeshTaskRecord; duplicate: boolean }> {
    this.assertAllowed("mesh_call");
    return this.coordinator().call(await this.taskInput(input), waitMs);
  }

  async getTask(taskId: string): Promise<MeshTaskRecord> {
    this.assertAllowed("mesh_task_get");
    return this.coordinator().getOwned(taskId, this.options.principal.id);
  }

  async cancelTask(taskId: string): Promise<MeshTaskRecord> {
    this.assertAllowed("mesh_task_cancel");
    return this.coordinator().cancel(taskId, this.options.principal.id);
  }

  async getThread(contextId: string): Promise<MeshTaskRecord[]> {
    this.assertAllowed("mesh_thread_get");
    return this.coordinator().thread(contextId, this.options.principal.id);
  }

  async listAgentSessions(input: {
    targetAgentId: string;
    workspaceId?: string;
    cursor?: string;
    limit: number;
  }): Promise<AgentSessionPage> {
    this.assertAllowed("mesh_agent_sessions_list");
    const target = this.allowedTarget(input.targetAgentId);
    const workspaceId = resolveScope("workspace", input.workspaceId, this.options.principal.allowedWorkspaceIds);
    return this.sessions(target.id).list(target.id, {
      workspaceId,
      cursor: input.cursor,
      limit: input.limit
    });
  }

  async getAgentSession(input: {
    targetAgentId: string;
    workspaceId?: string;
    sessionId: string;
  }): Promise<AgentSessionSummary> {
    this.assertAllowed("mesh_agent_session_get");
    const target = this.allowedTarget(input.targetAgentId);
    const workspaceId = resolveScope("workspace", input.workspaceId, this.options.principal.allowedWorkspaceIds);
    const session = await this.sessions(target.id).get(target.id, {
      workspaceId,
      sessionId: input.sessionId
    });
    if (session === undefined) {
      throw new Error("Agent session is not available in the authenticated workspace.");
    }
    return session;
  }

  private async taskInput(input: MeshTaskDispatchInput) {
    const target = this.allowedTarget(input.targetAgentId);
    const workspaceId = resolveScope("workspace", input.workspaceId, this.options.principal.allowedWorkspaceIds);
    if (input.sessionId !== undefined) {
      const session = await this.sessions(target.id).get(target.id, {
        workspaceId,
        sessionId: input.sessionId
      });
      if (session === undefined) {
        throw new Error("Agent session is not available in the authenticated workspace.");
      }
    }
    return {
      contextId: input.contextId ?? `mesh_context_${randomUUID()}`,
      principalId: this.options.principal.id,
      principalKind: this.options.principal.kind,
      requesterId: this.options.principal.requesterId,
      targetAgentId: target.id,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      workspaceId,
      domainId: resolveScope("domain", input.domainId, this.options.principal.allowedDomainIds),
      message: input.message,
      labels: input.labels ?? [],
      idempotencyKey: `${this.options.principal.id}:${input.idempotencyKey}`
    };
  }

  private allowedTarget(targetAgentId: string): MeshMcpAgent {
    const target = this.options.agents.find((agent) => agent.id === targetAgentId);
    if (target === undefined || !this.options.principal.allowedAgentIds.includes(target.id)) {
      throw new Error(`Target agent is not exposed through this MCP bridge: ${targetAgentId}`);
    }
    return target;
  }

  private sessions(targetAgentId: string): AgentSessionRegistry {
    if (this.options.sessionRegistry === undefined || !this.options.sessionRegistry.has(targetAgentId)) {
      throw new Error(`Agent session access is not configured: ${targetAgentId}`);
    }
    return this.options.sessionRegistry;
  }

  private coordinator(): MeshTaskCoordinator {
    if (this.options.taskCoordinator === undefined) throw new Error("Mesh task execution is not configured.");
    return this.options.taskCoordinator;
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

const taskDispatchInputSchema = z.object({
  target_agent_id: identifierSchema,
  session_id: identifierSchema.optional(),
  workspace_id: identifierSchema.optional(),
  domain_id: identifierSchema.optional(),
  context_id: identifierSchema.optional(),
  message: z.string().min(1).max(MAX_MESSAGE_LENGTH),
  idempotency_key: z.string().min(1).max(MAX_IDEMPOTENCY_KEY_LENGTH),
  labels: z.array(z.string().min(1).max(MAX_LABEL_LENGTH)).max(20).optional()
});

const taskCallInputSchema = taskDispatchInputSchema.extend({
  wait_seconds: z.number().int().min(1).max(120).optional()
});

const taskIdSchema = z.object({ task_id: identifierSchema });
const threadSchema = z.object({ context_id: identifierSchema });
const agentSessionsListSchema = z.object({
  target_agent_id: identifierSchema,
  workspace_id: identifierSchema.optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.number().int().min(1).max(100).optional()
});
const agentSessionGetSchema = z.object({
  target_agent_id: identifierSchema,
  workspace_id: identifierSchema.optional(),
  session_id: identifierSchema
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

  if (options.principal.allowedTools.includes("mesh_call")) server.registerTool(
    "mesh_call",
    {
      title: "Call an Agent Mesh agent",
      description: "Starts a governed agent task and waits for a bounded interval for its correlated result. Returns a durable task handle when still running.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      inputSchema: taskCallInputSchema
    },
    async (input) => {
      try {
        const output = await facade.callTask(taskInput(input), (input.wait_seconds ?? 90) * 1000);
        return result({ duplicate: output.duplicate, task: publicTask(output.task) });
      } catch (error) { return errorResult(error); }
    }
  );

  if (options.principal.allowedTools.includes("mesh_submit")) server.registerTool(
    "mesh_submit",
    {
      title: "Submit an Agent Mesh task",
      description: "Durably submits a governed agent task and returns immediately with a task handle.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      inputSchema: taskDispatchInputSchema
    },
    async (input) => {
      try {
        const output = await facade.submitTask(taskInput(input));
        return result({ duplicate: output.duplicate, task: publicTask(output.task) });
      } catch (error) { return errorResult(error); }
    }
  );

  if (options.principal.allowedTools.includes("mesh_task_get")) server.registerTool(
    "mesh_task_get",
    {
      title: "Read an Agent Mesh task",
      description: "Reads the status and correlated result of a task owned by the authenticated principal.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: taskIdSchema
    },
    async ({ task_id }) => {
      try { return result({ task: publicTask(await facade.getTask(task_id)) }); }
      catch (error) { return errorResult(error); }
    }
  );

  if (options.principal.allowedTools.includes("mesh_task_cancel")) server.registerTool(
    "mesh_task_cancel",
    {
      title: "Cancel an Agent Mesh task",
      description: "Requests cooperative cancellation of a task owned by the authenticated principal.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      inputSchema: taskIdSchema
    },
    async ({ task_id }) => {
      try { return result({ task: publicTask(await facade.cancelTask(task_id)) }); }
      catch (error) { return errorResult(error); }
    }
  );

  if (options.principal.allowedTools.includes("mesh_thread_get")) server.registerTool(
    "mesh_thread_get",
    {
      title: "Read an Agent Mesh thread",
      description: "Returns the ordered task conversation owned by the authenticated principal for one context.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: threadSchema
    },
    async ({ context_id }) => {
      try { return result({ context_id, tasks: (await facade.getThread(context_id)).map(publicTask) }); }
      catch (error) { return errorResult(error); }
    }
  );

  if (options.principal.allowedTools.includes("mesh_agent_sessions_list")) server.registerTool(
    "mesh_agent_sessions_list",
    {
      title: "List Agent Mesh sessions",
      description: "Lists provider sessions visible inside one authenticated workspace without exposing transcripts or host paths.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: agentSessionsListSchema
    },
    async (input) => {
      try {
        return result(await facade.listAgentSessions({
          targetAgentId: input.target_agent_id,
          workspaceId: input.workspace_id,
          cursor: input.cursor,
          limit: input.limit ?? 25
        }));
      } catch (error) { return errorResult(error); }
    }
  );

  if (options.principal.allowedTools.includes("mesh_agent_session_get")) server.registerTool(
    "mesh_agent_session_get",
    {
      title: "Read an Agent Mesh session",
      description: "Reads bounded metadata for one provider session visible inside the authenticated workspace.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: agentSessionGetSchema
    },
    async (input) => {
      try {
        return result({ session: await facade.getAgentSession({
          targetAgentId: input.target_agent_id,
          workspaceId: input.workspace_id,
          sessionId: input.session_id
        }) });
      } catch (error) { return errorResult(error); }
    }
  );

}

function taskInput(input: z.infer<typeof taskDispatchInputSchema>): MeshTaskDispatchInput {
  return {
    targetAgentId: input.target_agent_id,
    sessionId: input.session_id,
    workspaceId: input.workspace_id,
    domainId: input.domain_id,
    contextId: input.context_id,
    message: input.message,
    idempotencyKey: input.idempotency_key,
    labels: input.labels
  };
}

export function publicTask(task: MeshTaskRecord) {
  return {
    task_id: task.task_id,
    context_id: task.context_id,
    message_id: task.message_id,
    agent_id: task.target_agent_id,
    ...(task.session_id === undefined ? {} : { session_id: task.session_id }),
    status: task.status,
    created_at: task.created_at,
    updated_at: task.updated_at,
    message: task.message,
    ...(task.result === undefined ? {} : { result: task.result }),
    ...(task.error === undefined ? {} : { error: task.error })
  };
}

export async function executeMeshTask(
  gateway: MeshMcpGateway,
  task: MeshTaskRecord,
  now: () => Date = () => new Date(),
  options: {
    resultWaitMs?: number;
    resultPollMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {}
) {
  const submitted = await gateway.submitEnvelope({
    schema: "openclaw.agent.message.v1",
    message_id: task.message_id,
    created_at: task.created_at || now().toISOString(),
    workspace_id: task.workspace_id,
    domain_id: task.domain_id,
    conversation_id: task.context_id,
    from: task.requester_id,
    to: task.target_agent_id,
    intent: "request",
    ttl: 3,
    hop_count: 0,
    idempotency_key: task.idempotency_key,
    content: { text: task.message },
    trace_id: task.context_id,
    correlation_id: task.task_id,
    task_id: task.task_id,
    sensitivity: "private",
    redaction_state: "required",
    metadata: {
      ingress: "mcp",
      a2a_operation: "task",
      principal_id: task.principal_id,
      principal_kind: task.principal_kind,
      task_id: task.task_id,
      ...(task.session_id === undefined ? {} : { session_id: task.session_id })
    },
    ...(task.labels.length === 0 ? {} : { labels: [...task.labels] })
  });
  const transportAdapterId = task.session_id === undefined ? "tmux-transport" : "agent-session-transport";
  const transport = [...submitted.deliveries].reverse()
    .find((delivery) => delivery.adapter_id === transportAdapterId);
  if (transport === undefined || transport.status !== "delivered") {
    throw new MeshTaskExecutionError("transport_failure", `Agent transport did not deliver the request: ${transport?.status ?? "missing"}.`);
  }
  const deadline = Date.now() + (options.resultWaitMs ?? 2_000);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let observedEmpty = false;
  let observedUncorrelated = false;
  do {
    const audits = await gateway.listAudit({ type: "delivery.updated", message_id: task.message_id });
    for (const event of [...audits].reverse()) {
      const details = event.details.adapter_details;
      if (typeof details !== "object" || details === null) continue;
      const adapter = details as Record<string, unknown>;
      if (event.details.adapter_id !== transportAdapterId) continue;
      if (adapter.correlation_id !== task.task_id) {
        if (typeof adapter.reply === "string" || typeof adapter.result_error_code === "string") observedUncorrelated = true;
        continue;
      }
      if (typeof adapter.result_error_code === "string") {
        const code = adapter.result_error_code;
        if (isResultErrorCode(code)) {
          throw new MeshTaskExecutionError(code, typeof adapter.result_error === "string" ? adapter.result_error : resultErrorMessage(code));
        }
      }
      if (typeof adapter.reply === "string") {
        if (adapter.reply.trim().length === 0) {
          observedEmpty = true;
          continue;
        }
        if (adapter.reply.length > 131_072) throw new MeshTaskExecutionError("result_too_large", "Agent result exceeds the MCP task result limit.");
        return { text: adapter.reply, artifacts: [] };
      }
    }
    if (Date.now() >= deadline) break;
    await sleep(Math.min(options.resultPollMs ?? 50, Math.max(1, deadline - Date.now())));
  } while (true);
  if (observedUncorrelated) throw new MeshTaskExecutionError("result_uncorrelated", "Agent output was produced with a correlation ID that does not match the task.");
  if (observedEmpty) throw new MeshTaskExecutionError("result_no_output", "Agent produced no textual result for the correlated task.");
  throw new MeshTaskExecutionError("result_timeout", "The result collector did not persist a correlated result before the grace period expired.");
}

type ResultErrorCode = "result_no_output" | "result_uncorrelated" | "result_parsing_failure" | "result_timeout";

class MeshTaskExecutionError extends Error {
  readonly code: ResultErrorCode | "transport_failure" | "result_too_large";

  constructor(code: ResultErrorCode | "transport_failure" | "result_too_large", message: string) {
    super(message);
    this.name = "MeshTaskExecutionError";
    this.code = code;
  }
}

function isResultErrorCode(value: string): value is ResultErrorCode {
  return ["result_no_output", "result_uncorrelated", "result_parsing_failure", "result_timeout"].includes(value);
}

function resultErrorMessage(code: ResultErrorCode): string {
  const messages: Record<ResultErrorCode, string> = {
    result_no_output: "Agent produced no textual result.",
    result_uncorrelated: "Agent output was produced but did not match the task correlation ID.",
    result_parsing_failure: "Agent output was correlated but could not be parsed.",
    result_timeout: "Agent result collection timed out."
  };
  return messages[code];
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
