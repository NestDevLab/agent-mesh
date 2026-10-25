import { isAbsolute, resolve } from "node:path";
import { request } from "node:http";
import type { MeshTaskRecord } from "./mesh-task-store.js";
import type { MeshTaskExecutionHooks } from "./mesh-task-coordinator.js";

export class WorkspaceWorkerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

export type AccessMode = "read-only" | "workspace-write";
/** One exact owner/agent/repository/mode tuple; no wildcard or global grants. */
export interface WorkspaceWorkerRoute {
  id: string;
  principalId: string;
  agentId: string;
  workspaceId: string;
  accessMode: AccessMode;
  socketPath: string;
  pathSelection?: "client";
}

export function validateWorkerRoute(route: WorkspaceWorkerRoute): void {
  if (!route || [route.id, route.principalId, route.agentId, route.workspaceId].some((v) => typeof v !== "string" || !/^[A-Za-z0-9_.:-]{1,160}$/.test(v)) ||
      (route.pathSelection !== undefined && route.pathSelection !== "client") || !["read-only", "workspace-write"].includes(route.accessMode) || typeof route.socketPath !== "string" || !isAbsolute(route.socketPath) || resolve(route.socketPath) !== route.socketPath || route.socketPath.includes("..") || route.socketPath.includes("\0") || Buffer.byteLength(route.socketPath, "utf8") > 107) {
    throw new Error("Invalid explicit workspace worker route.");
  }
}

export class WorkspaceWorkerRouter {
  private readonly routes: readonly WorkspaceWorkerRoute[];
  constructor(routes: readonly WorkspaceWorkerRoute[]) {
    this.routes = routes;
    if (!Array.isArray(routes)) throw new Error("Workspace workers must be an explicit route array.");
    for (const route of routes) validateWorkerRoute(route);
    if (new Set(routes.map((r) => r.id)).size !== routes.length ||
        new Set(routes.map((r) => JSON.stringify([r.principalId, r.agentId, r.workspaceId, r.accessMode]))).size !== routes.length ||
        new Set(routes.map((r) => r.socketPath)).size !== routes.length) throw new Error("Duplicate workspace worker route.");
  }

  supports(principalId: string, agentId: string, workspaceId: string): boolean {
    return this.routes.some((r) => r.principalId === principalId && r.agentId === agentId && r.workspaceId === workspaceId);
  }

  authorize(input: { principalId: string; agentId: string; workspaceId: string; accessMode: AccessMode;
    workspacePath?: string; sessionMode?: "fresh"; sessionId?: string; binding?: MeshTaskRecord }): string | undefined {
    const route = this.routes.find((r) => r.principalId === input.principalId && r.agentId === input.agentId &&
      r.workspaceId === input.workspaceId && r.accessMode === input.accessMode);
    if (input.workspacePath !== undefined && (route?.pathSelection !== "client" || !isAbsolute(input.workspacePath) || resolve(input.workspacePath) !== input.workspacePath || input.workspacePath.includes("\0"))) throw new Error("workspace_path_denied: canonical client path and an explicit path-selection policy are required.");
    if (route?.pathSelection === "client" && input.sessionMode === "fresh" && input.workspacePath === undefined) throw new Error("workspace_path_required: select the destination directory.");
    if (input.binding?.worker_id !== undefined) {
      if (route?.id !== input.binding.worker_id) throw new Error("workspace_write_denied: session worker grant was revoked or changed.");
      return route.id;
    }
    if (input.accessMode === "workspace-write" && (route === undefined || input.sessionMode !== "fresh" || input.sessionId !== undefined)) {
      throw new Error("workspace_write_denied: requires a new session and an explicit principal/agent/workspace grant.");
    }
    return input.sessionMode === "fresh" ? route?.id : undefined;
  }

  async execute(task: MeshTaskRecord, hooks: MeshTaskExecutionHooks) {
    const route = this.routes.find((r) => r.id === task.worker_id && r.principalId === task.principal_id &&
      r.agentId === task.target_agent_id && r.workspaceId === task.workspace_id && r.accessMode === task.access_mode);
    if (route === undefined) throw new WorkspaceWorkerError("workspace_write_denied", "workspace_write_denied: worker grant unavailable.");
    const reply = await workerRequest(route.socketPath, { task });
    if (reply.taskId !== task.task_id || reply.accessMode !== task.access_mode || reply.workerId !== route.id) throw new WorkspaceWorkerError("worker_response_uncorrelated", "Uncorrelated workspace worker response.");
    if (typeof reply.sessionId === "string") await hooks.bindSession(reply.sessionId);
    if (typeof reply.error === "string") throw new WorkspaceWorkerError(reply.error.split(":")[0]!, reply.error);
    if (typeof reply.text !== "string") throw new Error("Invalid workspace worker result.");
    return { text: reply.text };
  }
}

function workerRequest(socketPath: string, body: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let connected = false;
    const req = request({ socketPath, path: "/execute", method: "POST", headers: { "content-type": "application/json" } }, (res) => {
      const chunks: Buffer[] = []; let size = 0;
      res.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 1_048_576) req.destroy(new Error("Worker response too large.")); else chunks.push(chunk); });
      res.on("end", () => { try {
        if (res.statusCode !== 200) throw new WorkspaceWorkerError("workspace_worker_unavailable", `workspace_worker_unavailable: HTTP ${res.statusCode}`);
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      } catch (error) { reject(error); } });
      res.on("error", reject);
    });
    req.on("socket", (socket) => socket.once("connect", () => { connected = true; }));
    req.on("error", () => reject(new WorkspaceWorkerError(connected ? "delivery_uncertain" : "workspace_worker_unavailable",
      connected ? "delivery_uncertain: worker connection interrupted; do not resubmit with a new key." : "workspace_worker_unavailable: isolated worker did not respond; no fallback.")));
    req.setTimeout(300_000, () => req.destroy(new Error("Worker timeout; delivery may be uncertain.")));
    req.end(JSON.stringify(body));
  });
}
