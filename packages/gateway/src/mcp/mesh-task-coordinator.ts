import type { MeshTaskArtifact, MeshTaskRecord, MeshTaskStoreLike } from "./mesh-task-store.js";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const EXECUTION_ERROR_CODES = new Set([
  "transport_failure",
  "workspace_worker_unavailable",
  "workspace_write_denied",
  "worker_response_uncorrelated",
  "worker_execution_failed",
  "delivery_uncertain",
  "result_no_output",
  "result_uncorrelated",
  "result_parsing_failure",
  "result_timeout",
  "result_too_large",
  "fresh_session_unsupported",
  "fresh_session_workspace_unauthorized",
  "fresh_session_create_failed"
]);

export interface MeshTaskExecutionResult {
  text: string;
  artifacts?: readonly MeshTaskArtifact[];
}

export interface MeshTaskExecutionHooks { bindSession(sessionId: string): Promise<void> }

export type MeshTaskExecutor = (task: MeshTaskRecord, hooks: MeshTaskExecutionHooks) => Promise<MeshTaskExecutionResult>;
export type MeshTaskReturnSender = (task: MeshTaskRecord) => Promise<"held" | "queued" | "delivered" | "read" | "uncertain">;

export class MeshTaskCoordinator {
  private readonly store: MeshTaskStoreLike;
  private readonly execute: MeshTaskExecutor;
  private readonly deliverReturn?: MeshTaskReturnSender;
  private readonly returns = new Map<string, Promise<void>>();
  private readonly active = new Map<string, Promise<void>>();
  private readonly targetTails = new Map<string, Promise<void>>();

  constructor(options: { store: MeshTaskStoreLike; execute: MeshTaskExecutor; deliverReturn?: MeshTaskReturnSender }) {
    this.store = options.store;
    this.execute = options.execute;
    this.deliverReturn = options.deliverReturn;
  }

  async submit(input: Parameters<MeshTaskStoreLike["create"]>[0]): Promise<{ task: MeshTaskRecord; duplicate: boolean }> {
    const created = await this.store.create(input);
    if (!TERMINAL.has(created.task.status)) this.schedule(created.task);
    else this.scheduleReturn(created.task);
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
    if (TERMINAL.has(task.status)) this.scheduleReturn(task);
    return task;
  }

  async cancel(taskId: string, principalId: string): Promise<MeshTaskRecord> {
    const task = await this.getOwned(taskId, principalId);
    if (TERMINAL.has(task.status)) return task;
    const cancelled = await this.store.update(this.withReturn({ ...task, status: "cancelled", error: { code: "cancelled", message: "Cancellation requested by the MCP principal." } }));
    this.scheduleReturn(cancelled);
    return cancelled;
  }

  async thread(contextId: string, principalId: string): Promise<MeshTaskRecord[]> {
    return (await this.store.list()).filter(
      (task) => task.context_id === contextId && task.principal_id === principalId
    );
  }

  async sessionBinding(sessionId: string): Promise<MeshTaskRecord | undefined> {
    return (await this.store.list()).find((task) => task.session_id === sessionId);
  }

  /** Include cancelled tasks whose executor has not returned, and queued executions. */
  async nonterminalTaskCount(): Promise<number> {
    const ids = new Set(this.active.keys());
    for (const task of await this.store.list()) {
      if (!TERMINAL.has(task.status)) ids.add(task.task_id);
    }
    for (const id of this.active.keys()) ids.add(id);
    return ids.size;
  }

  async resume(): Promise<void> {
    for (const task of await this.store.list()) {
      if (!TERMINAL.has(task.status)) this.schedule(task);
      else this.scheduleReturn(task);
    }
  }

  private schedule(task: MeshTaskRecord): void {
    const taskId = task.task_id;
    if (this.active.has(taskId)) return;
    const targetKey = JSON.stringify([task.target_agent_id, task.session_id ?? null]);
    const prior = this.targetTails.get(targetKey) ?? Promise.resolve();
    const run = prior.catch(() => undefined).then(() => this.run(taskId));
    this.active.set(taskId, run);
    this.targetTails.set(targetKey, run);
    void run.finally(() => {
      this.active.delete(taskId);
      if (this.targetTails.get(targetKey) === run) this.targetTails.delete(targetKey);
    }).catch(() => undefined);
  }

  private async run(taskId: string): Promise<void> {
    let task = await this.store.get(taskId);
    if (task === undefined || TERMINAL.has(task.status)) return;
    if (task.status === "working" && task.session_mode === "fresh") {
      // still working after a restart: the session and prompt may already exist, don't risk doing either twice
      const failed = await this.store.update(this.withReturn({
        ...task,
        status: "failed",
        error: {
          code: "delivery_uncertain",
          message: "Fresh session task was interrupted; session creation or delivery may have happened and is not retried."
        }
      }));
      this.scheduleReturn(failed);
      return;
    }
    task = await this.store.update({ ...task, status: "working" });
    try {
      const execution = await this.execute(task, { bindSession: async (sessionId) => {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sessionId)) throw new Error("Invalid native session ID.");
        const latest = await this.store.get(taskId);
        if (latest === undefined || TERMINAL.has(latest.status) || latest.session_mode !== "fresh") return;
        await this.store.update({ ...latest, session_id: sessionId,
          ...(latest.session_provenance === undefined ? {} : { session_provenance: { ...latest.session_provenance, session_id: sessionId } }) });
      } });
      const latest = await this.store.get(taskId);
      if (latest === undefined || latest.status === "cancelled") return;
      const completed = await this.store.update(this.withReturn({
        ...latest,
        status: "completed",
        result: { text: execution.text, artifacts: execution.artifacts ?? [] }
      }));
      this.scheduleReturn(completed);
    } catch (error) {
      const latest = await this.store.get(taskId);
      if (latest === undefined || latest.status === "cancelled") return;
      const failed = await this.store.update(this.withReturn({
        ...latest,
        status: "failed",
        error: {
          code: executionErrorCode(error),
          message: error instanceof Error ? error.message : String(error)
        }
      }));
      this.scheduleReturn(failed);
    }
  }

  private withReturn(task: MeshTaskRecord): MeshTaskRecord {
    return task.return_route === undefined || task.return_delivery !== undefined ? task : {
      ...task, return_delivery: { id: `terminal:${task.task_id}`, status: "pending" }
    };
  }

  private scheduleReturn(task: MeshTaskRecord): void {
    if (this.deliverReturn === undefined || task.return_delivery === undefined ||
        ["delivered", "read"].includes(task.return_delivery.status) || this.returns.has(task.task_id)) return;
    const run = (async () => {
      const latest = await this.store.get(task.task_id);
      if (latest?.return_delivery === undefined || !TERMINAL.has(latest.status)) return;
      let status: MeshTaskReturnDeliveryStatus;
      try { status = await this.deliverReturn!(latest); }
      catch { status = "uncertain"; }
      const current = await this.store.get(task.task_id);
      if (current?.return_delivery?.id !== latest.return_delivery.id) return;
      if (current.return_delivery.status !== status) await this.store.update({
        ...current, return_delivery: { ...current.return_delivery, status }
      });
    })();
    this.returns.set(task.task_id, run);
    void run.finally(() => this.returns.delete(task.task_id)).catch(() => undefined);
  }
}

type MeshTaskReturnDeliveryStatus = "held" | "queued" | "delivered" | "read" | "uncertain";

function executionErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && EXECUTION_ERROR_CODES.has(code)) return code;
  }
  return "agent_execution_failed";
}
