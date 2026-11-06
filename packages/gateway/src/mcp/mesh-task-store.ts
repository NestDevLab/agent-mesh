import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import {
  appendStoreEvent,
  canonicalInputHash,
  replayStoreEvents,
  stateFilePath,
  type StoreClock
} from "../core/ndjson-store.js";

export const MESH_TASK_STATUSES = [
  "submitted",
  "working",
  "completed",
  "failed",
  "cancelled"
] as const;

export type MeshTaskStatus = (typeof MESH_TASK_STATUSES)[number];

export interface MeshTaskResult {
  text: string;
  artifacts: readonly MeshTaskArtifact[];
}

export interface MeshTaskArtifact {
  id: string;
  media_type: string;
  text?: string;
  uri?: string;
}

export interface MeshTaskError {
  code: string;
  message: string;
}

/** A route bound to the authenticated principal by trusted configuration. */
export interface MeshTaskReturnRoute {
  agent_id: string;
  session_id: string;
  workspace_id: string;
  resume: boolean;
}

export interface MeshTaskReturnDelivery {
  id: string;
  status: "pending" | "held" | "queued" | "delivered" | "read" | "uncertain";
}

/** model/effort stay "unknown" unless the provider reports them, never guess them from the agent id */
export interface MeshTaskSessionProvenance {
  origin: "fresh";
  provider: string;
  agent_id: string;
  session_id: string;
  model: string;
  effort: string;
}

export interface MeshTaskRecord {
  schema: "agent-mesh.mcp-task.v1";
  task_id: string;
  context_id: string;
  message_id: string;
  principal_id: string;
  principal_kind: "user" | "service";
  requester_id: string;
  target_agent_id: string;
  session_id?: string;
  session_mode?: "fresh";
  access_mode?: "read-only" | "workspace-write";
  worker_id?: string;
  workspace_path?: string;
  session_provenance?: MeshTaskSessionProvenance;
  workspace_id: string;
  domain_id: string;
  message: string;
  labels: readonly string[];
  idempotency_key: string;
  input_hash: string;
  status: MeshTaskStatus;
  created_at: string;
  updated_at: string;
  result?: MeshTaskResult;
  error?: MeshTaskError;
  return_route?: MeshTaskReturnRoute;
  return_delivery?: MeshTaskReturnDelivery;
  /** Missing on older records and interpreted as zero. */
  revision?: number;
}

export type MeshTaskTransition =
  | { kind: "start" }
  | { kind: "bind"; sessionId: string }
  | { kind: "complete"; result: MeshTaskResult }
  | { kind: "fail"; error: MeshTaskError }
  | { kind: "cancel"; principalId: string }
  | { kind: "receipt"; id: string; expected: MeshTaskReturnDelivery["status"]; status: MeshTaskReturnDelivery["status"] };

export interface MeshTaskTransitionResult { task: MeshTaskRecord | undefined; changed: boolean }

export interface CreateMeshTaskInput {
  /** When omitted the store mints one and keeps it out of the idempotency hash. */
  contextId?: string;
  principalId: string;
  principalKind: "user" | "service";
  requesterId: string;
  targetAgentId: string;
  sessionId?: string;
  /** Needs sessionProvider, the store mints the session id. */
  sessionMode?: "fresh";
  accessMode?: "read-only" | "workspace-write";
  workerId?: string;
  workspacePath?: string;
  sessionProvider?: string;
  workspaceId: string;
  domainId: string;
  message: string;
  labels: readonly string[];
  idempotencyKey: string;
  returnRoute?: MeshTaskReturnRoute;
}

export interface MeshTaskStoreLike {
  create(input: CreateMeshTaskInput): Promise<{ task: MeshTaskRecord; duplicate: boolean }>;
  update(task: MeshTaskRecord): Promise<MeshTaskRecord>;
  transition(taskId: string, transition: MeshTaskTransition): Promise<MeshTaskTransitionResult>;
  get(taskId: string): Promise<MeshTaskRecord | undefined>;
  list(): Promise<MeshTaskRecord[]>;
}

const TERMINAL = new Set<MeshTaskStatus>(["completed", "failed", "cancelled"]);
const storeQueues = new Map<string, Promise<void>>();

export class MeshTaskStore implements MeshTaskStoreLike {
  private readonly filePath: string;
  private readonly clock?: StoreClock;

  constructor(options: { stateDir?: string; clock?: StoreClock } = {}) {
    this.filePath = resolve(stateFilePath("mcp-task-events.ndjson", options.stateDir));
    this.clock = options.clock;
  }

  async create(input: CreateMeshTaskInput): Promise<{ task: MeshTaskRecord; duplicate: boolean }> {
    if (input.sessionMode === "fresh" && (input.sessionId !== undefined || input.sessionProvider === undefined)) {
      throw new Error("A fresh session task requires a provider and must not name an existing session.");
    }
    return this.exclusive(async () => {
    const normalized = {
      ...(input.contextId === undefined ? {} : { context_id: input.contextId }),
      principal_id: input.principalId,
      principal_kind: input.principalKind,
      requester_id: input.requesterId,
      target_agent_id: input.targetAgentId,
      ...(input.sessionId === undefined ? {} : { session_id: input.sessionId }),
      ...(input.sessionMode === undefined ? {} : { session_mode: input.sessionMode }),
      ...(input.accessMode === "workspace-write" || input.workerId !== undefined ? { access_mode: input.accessMode ?? "read-only" } : {}),
      ...(input.workerId === undefined ? {} : { worker_id: input.workerId }),
      ...(input.workspacePath === undefined ? {} : { workspace_path: input.workspacePath }),
      workspace_id: input.workspaceId,
      domain_id: input.domainId,
      message: input.message,
      labels: [...input.labels],
      ...(input.returnRoute === undefined ? {} : { return_route: { ...input.returnRoute } }),
      idempotency_key: input.idempotencyKey
    };
    const inputHash = canonicalInputHash(normalized);
    const prior = (await this.listUnlocked()).find(
      (task) => task.principal_id === input.principalId && task.idempotency_key === input.idempotencyKey
    );
    if (prior !== undefined) {
      if (prior.input_hash !== inputHash) throw new Error("Task idempotency key conflicts with different input.");
      return { task: prior, duplicate: true };
    }

    const now = (this.clock?.now() ?? new Date()).toISOString();
    const freshSessionId = input.sessionMode === "fresh" ? randomUUID() : undefined;
    const task: MeshTaskRecord = {
      schema: "agent-mesh.mcp-task.v1",
      task_id: `mesh_task_${randomUUID()}`,
      context_id: input.contextId ?? `mesh_context_${randomUUID()}`,
      message_id: `mcp_${randomUUID()}`,
      principal_id: input.principalId,
      principal_kind: input.principalKind,
      requester_id: input.requesterId,
      target_agent_id: input.targetAgentId,
      ...(input.sessionId === undefined ? {} : { session_id: input.sessionId }),
      ...(freshSessionId === undefined ? {} : {
        session_id: freshSessionId,
        session_mode: "fresh" as const,
        session_provenance: {
          origin: "fresh" as const,
          provider: input.sessionProvider as string,
          agent_id: input.targetAgentId,
          session_id: freshSessionId,
          model: "unknown",
          effort: "unknown"
        }
      }),
      access_mode: input.accessMode ?? "read-only",
      ...(input.workerId === undefined ? {} : { worker_id: input.workerId }),
      ...(input.workspacePath === undefined ? {} : { workspace_path: input.workspacePath }),
      workspace_id: input.workspaceId,
      domain_id: input.domainId,
      message: input.message,
      labels: [...input.labels],
      ...(input.returnRoute === undefined ? {} : { return_route: { ...input.returnRoute } }),
      idempotency_key: input.idempotencyKey,
      input_hash: inputHash,
      status: "submitted",
      revision: 0,
      created_at: now,
      updated_at: now
    };
    await this.append(task);
    return { task, duplicate: false };
    });
  }

  async update(task: MeshTaskRecord): Promise<MeshTaskRecord> {
    return this.exclusive(async () => {
      const current = (await this.listUnlocked()).find((item) => item.task_id === task.task_id);
      if (current === undefined) throw new Error("Task does not exist.");
      if ((current.revision ?? 0) !== (task.revision ?? 0)) throw new Error("Task update is stale.");
      return this.persistUpdate(current, TERMINAL.has(task.status) ? withReturn(task) : task);
    });
  }

  /** The current record, transition decision and durable append share one exclusion. */
  async transition(taskId: string, action: MeshTaskTransition): Promise<MeshTaskTransitionResult> {
    return this.exclusive(async () => {
      const current = (await this.listUnlocked()).find((item) => item.task_id === taskId);
      if (current === undefined) return { task: undefined, changed: false };
      if (action.kind === "cancel" && current.principal_id !== action.principalId) throw new Error("Task is not owned by the authenticated MCP principal.");
      if (action.kind === "receipt") {
        const delivery = current.return_delivery;
        if (!TERMINAL.has(current.status) || delivery === undefined || delivery.id !== action.id || delivery.status !== action.expected || delivery.status === action.status || !receiptTransitionAllowed(delivery.status, action.status)) {
          return { task: current, changed: false };
        }
        return { task: await this.persistUpdate(current, { ...current, return_delivery: { ...delivery, status: action.status } }), changed: true };
      }
      if (TERMINAL.has(current.status)) return { task: current, changed: false };
      let next: MeshTaskRecord;
      switch (action.kind) {
        case "start":
          if (current.status === "working") return { task: current, changed: false };
          next = { ...current, status: "working" }; break;
        case "bind":
          if (current.session_mode !== "fresh" || current.status !== "working") return { task: current, changed: false };
          next = { ...current, session_id: action.sessionId,
            ...(current.session_provenance === undefined ? {} : { session_provenance: { ...current.session_provenance, session_id: action.sessionId } }) }; break;
        case "complete":
          if (current.status !== "working") return { task: current, changed: false };
          next = withReturn({ ...current, status: "completed", result: action.result }); break;
        case "fail":
          next = withReturn({ ...current, status: "failed", error: action.error }); break;
        case "cancel":
          next = withReturn({ ...current, status: "cancelled", error: { code: "cancelled", message: "Cancellation requested by the MCP principal." } }); break;
      }
      return { task: await this.persistUpdate(current, next), changed: true };
    });
  }

  async get(taskId: string): Promise<MeshTaskRecord | undefined> {
    return this.exclusive(async () => (await this.listUnlocked()).find((task) => task.task_id === taskId));
  }

  async list(): Promise<MeshTaskRecord[]> {
    return this.exclusive(() => this.listUnlocked());
  }

  private async listUnlocked(): Promise<MeshTaskRecord[]> {
    const replay = await replayStoreEvents<MeshTaskRecord & Record<string, unknown>>(this.filePath, {
      quarantineCorruptFinalLine: true
    });
    const latest = new Map<string, MeshTaskRecord>();
    for (const event of replay.records) latest.set(event.data.task_id, event.data);
    return [...latest.values()].sort((left, right) => left.created_at.localeCompare(right.created_at));
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const prior = storeQueues.get(this.filePath) ?? Promise.resolve();
    let release: () => void = () => {};
    const tail = new Promise<void>((resolveQueue) => { release = resolveQueue; });
    storeQueues.set(this.filePath, tail);
    await prior;
    try {
      return await operation();
    } finally {
      release();
      if (storeQueues.get(this.filePath) === tail) storeQueues.delete(this.filePath);
    }
  }

  private async persistUpdate(current: MeshTaskRecord, next: MeshTaskRecord): Promise<MeshTaskRecord> {
    assertValidUpdate(current, next);
    const updated = { ...next, labels: [...next.labels], revision: (current.revision ?? 0) + 1,
      updated_at: (this.clock?.now() ?? new Date()).toISOString() };
    await this.append(updated);
    return updated;
  }

  private async append(task: MeshTaskRecord): Promise<void> {
    await appendStoreEvent(
      this.filePath,
      `mcp_task.${task.status}`,
      task as MeshTaskRecord & Record<string, unknown>,
      { clock: this.clock }
    );
  }
}

function withReturn(task: MeshTaskRecord): MeshTaskRecord {
  return task.return_route === undefined || task.return_delivery !== undefined ? task : {
    ...task, return_delivery: { id: `terminal:${task.task_id}`, status: "pending" }
  };
}

function receiptTransitionAllowed(from: MeshTaskReturnDelivery["status"], to: MeshTaskReturnDelivery["status"]): boolean {
  const allowed: Record<MeshTaskReturnDelivery["status"], readonly MeshTaskReturnDelivery["status"][]> = {
    pending: ["held", "queued", "delivered", "read", "uncertain"],
    held: ["queued", "delivered", "read", "uncertain"],
    queued: ["delivered", "read"], uncertain: ["delivered", "read"],
    delivered: ["read"], read: []
  };
  return allowed[from].includes(to);
}

function assertValidUpdate(current: MeshTaskRecord, next: MeshTaskRecord): void {
  const { status: _oldStatus, result: _oldResult, error: _oldError, session_id: _oldSession,
    session_provenance: _oldProvenance, return_delivery: _oldReturn, revision: _oldRev,
    updated_at: _oldUpdated, ...oldIdentity } = current;
  const { status: _newStatus, result: _newResult, error: _newError, session_id: _newSession,
    session_provenance: _newProvenance, return_delivery: _newReturn, revision: _newRev,
    updated_at: _newUpdated, ...newIdentity } = next;
  if (canonicalInputHash(oldIdentity) !== canonicalInputHash(newIdentity)) throw new Error("Task identity cannot change.");
  if (!MESH_TASK_STATUSES.includes(next.status)) throw new Error("Invalid task status.");
  if (!TERMINAL.has(next.status) && next.return_delivery !== undefined) throw new Error("Nonterminal task cannot have a terminal return.");
  if (TERMINAL.has(current.status)) {
    const { return_delivery: oldDelivery, revision: _oldRevision, updated_at: _oldTime, ...oldTerminal } = current;
    const { return_delivery: newDelivery, revision: _newRevision, updated_at: _newTime, ...newTerminal } = next;
    if (canonicalInputHash(oldTerminal) !== canonicalInputHash(newTerminal)) throw new Error("Terminal task outcome is immutable.");
    if (oldDelivery?.id !== newDelivery?.id || (oldDelivery !== undefined && newDelivery !== undefined &&
        oldDelivery.status !== newDelivery.status && !receiptTransitionAllowed(oldDelivery.status, newDelivery.status))) {
      throw new Error("Terminal return delivery cannot regress.");
    }
  } else if (current.status === "working" && next.status === "submitted") {
    throw new Error("Task status cannot regress.");
  }
}
