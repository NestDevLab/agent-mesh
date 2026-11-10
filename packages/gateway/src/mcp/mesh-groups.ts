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
  constructor(private readonly socketPath: string, private readonly timeoutMs = 300_000) {
    if (!isAbsolute(socketPath) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Invalid group broker configuration.");
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
      const fail = () => {
        if (!finished) { finished = true; connection.destroy(); reject(new Error("Group broker outcome is unknown; do not retry automatically.")); }
      };
      connection.setEncoding("utf8");
      connection.setTimeout(this.timeoutMs, fail);
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

/** Grants and actor identities come from host configuration, never MCP arguments. */
export function registerGroupMcpTools(server: McpServer, options: MeshMcpOptions): void {
  if (options.groupGateway === undefined) return;
  if (options.principal.allowedTools.includes("mesh_group_list")) server.registerTool("mesh_group_list", {
    title: "List accessible groups", description: "Lists groups granted to the authenticated session.",
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
    inputSchema: object.extend({ after: cursor, limit: z.number().int().min(1).max(10).optional() })
  }, async input => {
    try {
      const grant = authorized(options, "mesh_group_history", input.workspace_id, input.group_id);
      return response(await options.groupGateway!.invoke({ action: "history", actor: grant.session_id, group: input.group_id, after: input.after ?? 0, limit: input.limit ?? 10 }));
    } catch { return failure(); }
  });
  if (options.principal.allowedTools.includes("mesh_group_append")) server.registerTool("mesh_group_append", {
    title: "Append a group reply", description: "Records a reply once without waking another session.",
    inputSchema: object.extend({ message_id: messageId, message })
  }, async input => {
    try {
      const grant = authorized(options, "mesh_group_append", input.workspace_id, input.group_id);
      return response(await options.groupGateway!.invoke({ action: "append", actor: grant.session_id, group: input.group_id, message_id: input.message_id, message: input.message }));
    } catch { return failure(); }
  });
  if (options.principal.allowedTools.includes("mesh_group_send")) server.registerTool("mesh_group_send", {
    title: "Send a group message", description: "Records a message and attempts delivery to ordered group members; unknown outcomes are not retried.",
    inputSchema: object.extend({ message_id: messageId, message, destinations: z.array(z.string().min(1).max(320)).min(1).max(4) })
  }, async input => {
    try {
      const grant = authorized(options, "mesh_group_send", input.workspace_id, input.group_id);
      return response(await options.groupGateway!.invoke({ action: "send", actor: grant.session_id, group: input.group_id, message_id: input.message_id, message: input.message, destinations: input.destinations }));
    } catch { return failure(); }
  });
}
