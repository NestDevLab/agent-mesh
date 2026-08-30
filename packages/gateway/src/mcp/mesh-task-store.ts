import { randomUUID } from "node:crypto";

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
}

export interface CreateMeshTaskInput {
  contextId: string;
  principalId: string;
  principalKind: "user" | "service";
  requesterId: string;
  targetAgentId: string;
  sessionId?: string;
  workspaceId: string;
  domainId: string;
  message: string;
  labels: readonly string[];
  idempotencyKey: string;
}

export interface MeshTaskStoreLike {
  create(input: CreateMeshTaskInput): Promise<{ task: MeshTaskRecord; duplicate: boolean }>;
  update(task: MeshTaskRecord): Promise<MeshTaskRecord>;
  get(taskId: string): Promise<MeshTaskRecord | undefined>;
  list(): Promise<MeshTaskRecord[]>;
}

export class MeshTaskStore implements MeshTaskStoreLike {
  private readonly filePath: string;
  private readonly clock?: StoreClock;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: { stateDir?: string; clock?: StoreClock } = {}) {
    this.filePath = stateFilePath("mcp-task-events.ndjson", options.stateDir);
    this.clock = options.clock;
  }

  async create(input: CreateMeshTaskInput): Promise<{ task: MeshTaskRecord; duplicate: boolean }> {
    return this.exclusive(async () => {
    const normalized = {
      context_id: input.contextId,
      principal_id: input.principalId,
      principal_kind: input.principalKind,
      requester_id: input.requesterId,
      target_agent_id: input.targetAgentId,
      ...(input.sessionId === undefined ? {} : { session_id: input.sessionId }),
      workspace_id: input.workspaceId,
      domain_id: input.domainId,
      message: input.message,
      labels: [...input.labels],
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
    const task: MeshTaskRecord = {
      schema: "agent-mesh.mcp-task.v1",
      task_id: `mesh_task_${randomUUID()}`,
      context_id: input.contextId,
      message_id: `mcp_${randomUUID()}`,
      principal_id: input.principalId,
      principal_kind: input.principalKind,
      requester_id: input.requesterId,
      target_agent_id: input.targetAgentId,
      ...(input.sessionId === undefined ? {} : { session_id: input.sessionId }),
      workspace_id: input.workspaceId,
      domain_id: input.domainId,
      message: input.message,
      labels: [...input.labels],
      idempotency_key: input.idempotencyKey,
      input_hash: inputHash,
      status: "submitted",
      created_at: now,
      updated_at: now
    };
    await this.append(task);
    return { task, duplicate: false };
    });
  }

  async update(task: MeshTaskRecord): Promise<MeshTaskRecord> {
    return this.exclusive(async () => {
    const updated = {
      ...task,
      labels: [...task.labels],
      updated_at: (this.clock?.now() ?? new Date()).toISOString()
    };
    await this.append(updated);
    return updated;
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
    const prior = this.queue;
    let release: () => void = () => {};
    this.queue = new Promise<void>((resolveQueue) => { release = resolveQueue; });
    await prior;
    try {
      return await operation();
    } finally {
      release();
    }
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
