import { createConnection } from "node:net";
import { lstat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { MeshMcpOptions, MeshMcpTool } from "./mesh-mcp.js";

export interface GroupGrant {
  workspace_id: string;
  session_id: string;
  group_ids: readonly string[];
}

export interface GroupGateway {
  invoke(request: Record<string, unknown>): Promise<Record<string, unknown>>;
}

const LOCAL_SESSION = /^(?:codex|claude):[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLOUD_SESSION = /^claude-cloud:[a-z][a-z0-9-]{0,63}:(?:session|cse)_[A-Za-z0-9]{1,128}$/;
const GROUP = /^group_[a-f0-9]{32}$/;

export function validGroupGrants(value: unknown, workspaces: readonly string[]): value is GroupGrant[] {
  if (!Array.isArray(value) || value.length > 100) return false;
  const seen = new Set<string>();
  return value.every(grant => {
    if (typeof grant !== "object" || grant === null || Array.isArray(grant) ||
        Object.keys(grant).sort().join(",") !== "group_ids,session_id,workspace_id" ||
        typeof grant.workspace_id !== "string" || !workspaces.includes(grant.workspace_id) || seen.has(grant.workspace_id) ||
        typeof grant.session_id !== "string" || !(LOCAL_SESSION.test(grant.session_id) || CLOUD_SESSION.test(grant.session_id)) ||
        !Array.isArray(grant.group_ids) || grant.group_ids.length > 200 ||
        grant.group_ids.some((id: unknown) => typeof id !== "string" || !GROUP.test(id)) ||
        new Set(grant.group_ids).size !== grant.group_ids.length) return false;
    seen.add(grant.workspace_id);
    return true;
  });
}

/** Connects to a separately managed, private host broker; never starts a process. */
export class UnixGroupGateway implements GroupGateway {
  private readonly socketPath: string;
  private readonly timeoutMs: number;

  constructor(socketPath: string, timeoutMs = 300_000) {
    if (!isAbsolute(socketPath) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Invalid group broker configuration.");
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
  }

  async invoke(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const [directory, socket] = await Promise.all([lstat(dirname(this.socketPath)), lstat(this.socketPath)]);
    if (!directory.isDirectory() || !socket.isSocket() || directory.uid !== process.getuid?.() ||
        socket.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0 || (socket.mode & 0o077) !== 0) {
      throw new Error("Group broker socket is not private and owned.");
    }
    const payload = JSON.stringify(request) + "\n";
    if (Buffer.byteLength(payload) > 131072) throw new Error("Group broker request is too large.");
    return new Promise((resolve, reject) => {
      const connection = createConnection(this.socketPath);
      let data = "";
      let finished = false;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const fail = () => {
        if (!finished) {
          finished = true;
          if (deadline !== undefined) clearTimeout(deadline);
          connection.destroy();
          reject(new Error("Group broker outcome is unknown; do not retry automatically."));
        }
      };
      connection.setEncoding("utf8");
      deadline = setTimeout(fail, this.timeoutMs);
      connection.on("error", fail);
      connection.on("connect", () => connection.write(payload));
      connection.on("data", (chunk: string) => {
        data += chunk;
        if (Buffer.byteLength(data) > 4_500_000) return fail();
        const end = data.indexOf("\n");
        if (end < 0) return;
        try {
          const response: unknown = JSON.parse(data.slice(0, end));
          if (typeof response !== "object" || response === null || Array.isArray(response)) return fail();
          const row = response as Record<string, unknown>;
          if (row.ok !== true || typeof row.result !== "object" || row.result === null || Array.isArray(row.result)) return fail();
          finished = true;
          if (deadline !== undefined) clearTimeout(deadline);
          connection.end();
          resolve(row.result as Record<string, unknown>);
        } catch { fail(); }
      });
      connection.on("end", () => { if (!finished) fail(); });
      connection.on("close", () => { if (!finished) fail(); });
    });
  }
}

const groupId = z.string().regex(/^group_[a-f0-9]{32}$/);
const workspace = z.string().min(1).max(128).optional();
const cursor = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional();
const messageId = z.string().min(1).max(128).refine(value => value === value.trim());
const message = z.string().min(1).max(32000).refine(value => value.trim().length > 0 && !value.includes("\0"));
const object = z.object({ workspace_id: workspace, group_id: groupId }).strict();

function authorized(options: MeshMcpOptions, tool: MeshMcpTool, workspaceId?: string, target?: string): GroupGrant {
  if (!options.principal.allowedTools.includes(tool) || !options.rateLimiter.consume(options.principal.id, tool)) throw new Error("Group operation is not allowed.");
  if (!validGroupGrants(options.principal.groupGrants, options.principal.allowedWorkspaceIds)) throw new Error("Group grants are unavailable or invalid.");
  const grants = (options.principal.groupGrants ?? []).filter(g =>
    options.principal.allowedWorkspaceIds.includes(g.workspace_id) && (workspaceId === undefined || g.workspace_id === workspaceId));
  if (grants.length !== 1) throw new Error("Group workspace is missing or ambiguous.");
  const grant = grants[0]!;
  if (target !== undefined && !grant.group_ids.includes(target)) throw new Error("Group is not granted to this principal.");
  if (options.groupGateway === undefined) throw new Error("Group broker is not configured.");
  return grant;
}

function response(value: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value };
}
function failure() {
  return { content: [{ type: "text" as const, text: "Group operation failed or its outcome is unknown; inspect before retrying." }], isError: true };
}

function authorizedGroupManager(options: MeshMcpOptions, tool: MeshMcpTool): void {
  if (options.principal.manageAllGroups !== true || !options.principal.allowedTools.includes(tool) ||
      !options.rateLimiter.consume(options.principal.id, tool) || options.groupGateway === undefined) {
    throw new Error("Global group management is not allowed.");
  }
}

const sessionId = z.string().max(320).refine(value => LOCAL_SESSION.test(value) || CLOUD_SESSION.test(value));
const ledgerRef = z.string().max(256).regex(/^[a-z][a-z0-9-]{0,63}:[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/);
const label = (max: number) => z.string().min(1).max(max).refine(value => value === value.trim() && !/[\x00-\x1f\x7f]/.test(value));
const roleKey = z.string().regex(/^[a-z0-9][a-z0-9_.:/-]{0,127}$/);
const lockInput = z.object({ workspace_id: workspace, group_id: groupId, ref: ledgerRef }).strict();
const fence = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const leaseId = z.string().regex(/^[a-f0-9]{32}$/);
const ttl = z.number().int().min(1).max(3600);

function registerGroupLockTools(server: McpServer, options: MeshMcpOptions): void {
  const invoke = async (tool: MeshMcpTool, workspaceId: string | undefined, group: string,
                        request: Record<string, unknown>) => {
    try {
      const grant = authorized(options, tool, workspaceId, group);
      return response(await options.groupGateway!.invoke({ ...request, actor: grant.session_id, group }));
    } catch { return failure(); }
  };
  if (options.principal.allowedTools.includes("mesh_group_lock_inspect")) server.registerTool("mesh_group_lock_inspect", {
    title: "Inspect an item lease", description: "Read a lease only for an item linked to a granted group.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: lockInput
  }, async input => invoke("mesh_group_lock_inspect", input.workspace_id, input.group_id, { action: "lock_inspect", ref: input.ref }));
  if (options.principal.allowedTools.includes("mesh_group_lock_acquire")) server.registerTool("mesh_group_lock_acquire", {
    title: "Acquire an item lease", description: "Acquire a fenced lease for a linked item using the observed fence.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: lockInput.extend({ fence, ttl })
  }, async input => invoke("mesh_group_lock_acquire", input.workspace_id, input.group_id,
    { action: "lock_acquire", ref: input.ref, fence: input.fence, ttl: input.ttl }));
  if (options.principal.allowedTools.includes("mesh_group_lock_check")) server.registerTool("mesh_group_lock_check", {
    title: "Check an item lease", description: "Check a lease owned by the authenticated session.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: lockInput.extend({ fence, lease_id: leaseId })
  }, async input => invoke("mesh_group_lock_check", input.workspace_id, input.group_id,
    { action: "lock_check", ref: input.ref, fence: input.fence, lease_id: input.lease_id }));
  if (options.principal.allowedTools.includes("mesh_group_lock_renew")) server.registerTool("mesh_group_lock_renew", {
    title: "Renew an item lease", description: "Renew a current lease owned by the authenticated session.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: lockInput.extend({ fence, lease_id: leaseId, ttl })
  }, async input => invoke("mesh_group_lock_renew", input.workspace_id, input.group_id,
    { action: "lock_renew", ref: input.ref, fence: input.fence, lease_id: input.lease_id, ttl: input.ttl }));
  if (options.principal.allowedTools.includes("mesh_group_lock_release")) server.registerTool("mesh_group_lock_release", {
    title: "Release an item lease", description: "Release a current lease owned by the authenticated session.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: lockInput.extend({ fence, lease_id: leaseId })
  }, async input => invoke("mesh_group_lock_release", input.workspace_id, input.group_id,
    { action: "lock_release", ref: input.ref, fence: input.fence, lease_id: input.lease_id }));
}

/** Global administration is a separate, explicitly configured host privilege. */
function registerGroupAdminTools(server: McpServer, options: MeshMcpOptions): void {
  if (options.principal.manageAllGroups !== true || options.groupGateway === undefined) return;
  const invoke = async (tool: MeshMcpTool, request: Record<string, unknown>) => {
    try {
      authorizedGroupManager(options, tool);
      return response(await options.groupGateway!.invoke(request));
    } catch { return failure(); }
  };
  if (options.principal.allowedTools.includes("mesh_group_admin_list")) server.registerTool("mesh_group_admin_list", {
    title: "List all managed groups", description: "Global administrator only; lists groups across the entire broker.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: z.object({}).strict()
  }, async () => invoke("mesh_group_admin_list", { action: "admin_list" }));
  if (options.principal.allowedTools.includes("mesh_group_create")) server.registerTool("mesh_group_create", {
    title: "Create a group", description: "Global administrator only; reuse request_id for an exact retry.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: z.object({ name: label(160), request_id: label(128), role_key: roleKey.optional() }).strict()
  }, async input => invoke("mesh_group_create", { action: "admin_create", name: input.name,
    request_id: input.request_id, role_key: input.role_key ?? null }));
  if (options.principal.allowedTools.includes("mesh_group_add")) server.registerTool("mesh_group_add", {
    title: "Add a group member", description: "Global administrator only; cloud members must be registered.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: z.object({ group_id: groupId, session_id: sessionId }).strict()
  }, async input => invoke("mesh_group_add", { action: "admin_add", group: input.group_id, session: input.session_id }));
  if (options.principal.allowedTools.includes("mesh_group_remove")) server.registerTool("mesh_group_remove", {
    title: "Remove a group member", description: "Global administrator only; removes membership without deleting history.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    inputSchema: z.object({ group_id: groupId, session_id: sessionId }).strict()
  }, async input => invoke("mesh_group_remove", { action: "admin_remove", group: input.group_id, session: input.session_id }));
  if (options.principal.allowedTools.includes("mesh_group_link")) server.registerTool("mesh_group_link", {
    title: "Link a group to an item", description: "Global administrator only; at most one group leads an item.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: z.object({ group_id: groupId, ref: ledgerRef, lead: z.boolean().optional() }).strict()
  }, async input => invoke("mesh_group_link", { action: "admin_link", group: input.group_id, ref: input.ref, lead: input.lead ?? null }));
  if (options.principal.allowedTools.includes("mesh_group_unlink")) server.registerTool("mesh_group_unlink", {
    title: "Unlink a group from an item", description: "Global administrator only; follows existing lead safeguards.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    inputSchema: z.object({ group_id: groupId, ref: ledgerRef }).strict()
  }, async input => invoke("mesh_group_unlink", { action: "admin_unlink", group: input.group_id, ref: input.ref }));
  if (options.principal.allowedTools.includes("mesh_group_transfer_lead")) server.registerTool("mesh_group_transfer_lead", {
    title: "Transfer item lead", description: "Global administrator only; requires the expected current lead.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: z.object({ ref: ledgerRef, from_group_id: groupId, to_group_id: groupId }).strict()
  }, async input => invoke("mesh_group_transfer_lead", { action: "admin_transfer_lead", ref: input.ref,
    from_group: input.from_group_id, to_group: input.to_group_id }));
}

/** Grants and actor identities come from host configuration, never MCP arguments. */
export function registerGroupMcpTools(server: McpServer, options: MeshMcpOptions): void {
  if (options.groupGateway === undefined) return;
  registerGroupAdminTools(server, options);
  registerGroupLockTools(server, options);
  if (options.principal.allowedTools.includes("mesh_group_list")) server.registerTool("mesh_group_list", {
    title: "List accessible groups", description: "Lists groups granted to the authenticated session.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: z.object({ workspace_id: workspace }).strict()
  }, async input => {
    try {
      const grant = authorized(options, "mesh_group_list", input.workspace_id);
      const result = await options.groupGateway!.invoke({ action: "list", actor: grant.session_id });
      if (!Array.isArray(result.groups)) throw new Error("Invalid group response.");
      return response({ groups: result.groups.filter(row => typeof row === "object" && row !== null && grant.group_ids.includes((row as {group_id: string}).group_id)) });
    } catch { return failure(); }
  });
  if (options.principal.allowedTools.includes("mesh_group_history")) server.registerTool("mesh_group_history", {
    title: "Read group history", description: "Reads a page of conversation for a granted group.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: object.extend({ after: cursor, limit: z.number().int().min(1).max(10).optional() })
  }, async input => {
    try {
      const grant = authorized(options, "mesh_group_history", input.workspace_id, input.group_id);
      return response(await options.groupGateway!.invoke({ action: "history", actor: grant.session_id, group: input.group_id, after: input.after ?? 0, limit: input.limit ?? 10 }));
    } catch { return failure(); }
  });
  if (options.principal.allowedTools.includes("mesh_group_append")) server.registerTool("mesh_group_append", {
    title: "Append a group reply", description: "Records a reply once without waking another session.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: object.extend({ message_id: messageId, message })
  }, async input => {
    try {
      const grant = authorized(options, "mesh_group_append", input.workspace_id, input.group_id);
      return response(await options.groupGateway!.invoke({ action: "append", actor: grant.session_id, group: input.group_id, message_id: input.message_id, message: input.message }));
    } catch { return failure(); }
  });
  if (options.principal.allowedTools.includes("mesh_group_send")) server.registerTool("mesh_group_send", {
    title: "Send a group message", description: "Records a message and attempts delivery to ordered group members; unknown outcomes are not retried.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: object.extend({ message_id: messageId, message, destinations: z.array(z.string().min(1).max(320)).min(1).max(4) })
  }, async input => {
    try {
      const grant = authorized(options, "mesh_group_send", input.workspace_id, input.group_id);
      return response(await options.groupGateway!.invoke({ action: "send", actor: grant.session_id, group: input.group_id, message_id: input.message_id, message: input.message, destinations: input.destinations }));
    } catch { return failure(); }
  });
}
