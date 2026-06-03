import type { ExecutionJob } from "../schema/execution-job.js";
import {
  appendStoreEvent,
  replayStoreEvents,
  stateFilePath,
  type ReplayResult,
  type StoreClock,
  type StoreEventEnvelope
} from "./ndjson-store.js";

export type ExecutionJobStoreEvent = StoreEventEnvelope<ExecutionJob & Record<string, unknown>>;

export class ExecutionJobStore {
  private readonly filePath: string;
  private readonly clock?: StoreClock;

  constructor(options: { stateDir?: string; clock?: StoreClock } = {}) {
    this.filePath = stateFilePath("execution-jobs.ndjson", options.stateDir);
    this.clock = options.clock;
  }

  async append(job: ExecutionJob): Promise<ExecutionJobStoreEvent> {
    return appendStoreEvent(
      this.filePath,
      "execution_job.recorded",
      job as ExecutionJob & Record<string, unknown>,
      {
        eventId: job.id,
        clock: this.clock
      }
    );
  }

  async replay(): Promise<ReplayResult<ExecutionJob & Record<string, unknown>>> {
    return replayStoreEvents(this.filePath, { quarantineCorruptFinalLine: true });
  }

  async list(): Promise<ExecutionJob[]> {
    const replay = await this.replay();
    return replay.records.map((record) => record.data);
  }
}
