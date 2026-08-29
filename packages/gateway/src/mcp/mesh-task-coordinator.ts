import type { MeshTaskArtifact, MeshTaskRecord, MeshTaskStoreLike } from "./mesh-task-store.js";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export interface MeshTaskExecutionResult {
  text: string;
  artifacts?: readonly MeshTaskArtifact[];
}

export type MeshTaskExecutor = (task: MeshTaskRecord) => Promise<MeshTaskExecutionResult>;

export class MeshTaskCoordinator {
  private readonly store: MeshTaskStoreLike;
  private readonly execute: MeshTaskExecutor;
  private readonly active = new Map<string, Promise<void>>();
  private readonly targetTails = new Map<string, Promise<void>>();

  constructor(options: { store: MeshTaskStoreLike; execute: MeshTaskExecutor }) {
    this.store = options.store;
    this.execute = options.execute;
  }

  async submit(input: Parameters<MeshTaskStoreLike["create"]>[0]): Promise<{ task: MeshTaskRecord; duplicate: boolean }> {
    const created = await this.store.create(input);
    if (!TERMINAL.has(created.task.status)) this.schedule(created.task.task_id, created.task.target_agent_id);
    return created;
  }

  async call(
    input: Parameters<MeshTaskStoreLike["create"]>[0],
    waitMs: number
  ): Promise<{ task: MeshTaskRecord; duplicate: boolean }> {
    const submitted = await this.submit(input);
    const deadline = Date.now() + waitMs;
    let task = submitted.task;
    while (!TERMINAL.has(task.status) && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(100, Math.max(1, deadline - Date.now()))));
      task = (await this.store.get(task.task_id)) ?? task;
    }
    return { task, duplicate: submitted.duplicate };
  }

  async getOwned(taskId: string, principalId: string): Promise<MeshTaskRecord> {
    const task = await this.store.get(taskId);
    if (task === undefined || task.principal_id !== principalId) {
      throw new Error("Task is not owned by the authenticated MCP principal.");
    }
    return task;
  }

  async cancel(taskId: string, principalId: string): Promise<MeshTaskRecord> {
    const task = await this.getOwned(taskId, principalId);
    if (TERMINAL.has(task.status)) return task;
    return this.store.update({ ...task, status: "cancelled", error: { code: "cancelled", message: "Cancellation requested by the MCP principal." } });
  }

  async thread(contextId: string, principalId: string): Promise<MeshTaskRecord[]> {
    return (await this.store.list()).filter(
      (task) => task.context_id === contextId && task.principal_id === principalId
    );
  }

  async resume(): Promise<void> {
    for (const task of await this.store.list()) {
      if (!TERMINAL.has(task.status)) this.schedule(task.task_id, task.target_agent_id);
    }
  }

  private schedule(taskId: string, targetAgentId: string): void {
    if (this.active.has(taskId)) return;
    const prior = this.targetTails.get(targetAgentId) ?? Promise.resolve();
    const run = prior.catch(() => undefined).then(() => this.run(taskId));
    this.active.set(taskId, run);
    this.targetTails.set(targetAgentId, run);
    void run.finally(() => {
      this.active.delete(taskId);
      if (this.targetTails.get(targetAgentId) === run) this.targetTails.delete(targetAgentId);
    }).catch(() => undefined);
  }

  private async run(taskId: string): Promise<void> {
    let task = await this.store.get(taskId);
    if (task === undefined || TERMINAL.has(task.status)) return;
    task = await this.store.update({ ...task, status: "working" });
    try {
      const execution = await this.execute(task);
      const latest = await this.store.get(taskId);
      if (latest === undefined || latest.status === "cancelled") return;
      await this.store.update({
        ...latest,
        status: "completed",
        result: { text: execution.text, artifacts: execution.artifacts ?? [] }
      });
    } catch (error) {
      const latest = await this.store.get(taskId);
      if (latest === undefined || latest.status === "cancelled") return;
      await this.store.update({
        ...latest,
        status: "failed",
        error: {
          code: "agent_execution_failed",
          message: error instanceof Error ? error.message : String(error)
        }
      });
    }
  }
}
