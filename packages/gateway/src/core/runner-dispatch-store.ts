import type { RunnerDispatchRecord } from "../schema/runner-dispatch.js";
import {
  appendStoreEvent,
  replayStoreEvents,
  stateFilePath,
  type ReplayResult,
  type StoreClock,
  type StoreEventEnvelope
} from "./ndjson-store.js";

export type RunnerDispatchStoreEvent = StoreEventEnvelope<
  RunnerDispatchRecord & Record<string, unknown>
>;

export class RunnerDispatchStore {
  private readonly filePath: string;
  private readonly clock?: StoreClock;

  constructor(options: { stateDir?: string; clock?: StoreClock } = {}) {
    this.filePath = stateFilePath("runner-dispatch.ndjson", options.stateDir);
    this.clock = options.clock;
  }

  async append(record: RunnerDispatchRecord): Promise<RunnerDispatchStoreEvent> {
    return appendStoreEvent(
      this.filePath,
      `runner_dispatch.${record.kind}`,
      record as RunnerDispatchRecord & Record<string, unknown>,
      {
        eventId: record.id,
        clock: this.clock
      }
    );
  }

  async replay(): Promise<ReplayResult<RunnerDispatchRecord & Record<string, unknown>>> {
    return replayStoreEvents(this.filePath, { quarantineCorruptFinalLine: true });
  }

  async list(): Promise<RunnerDispatchRecord[]> {
    const replay = await this.replay();
    return replay.records.map((record) => record.data);
  }
}
