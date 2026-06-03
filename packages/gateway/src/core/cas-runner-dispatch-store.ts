import type { CasRunnerDispatchRecord } from "../schema/cas-runner-dispatch.js";
import {
  appendStoreEvent,
  replayStoreEvents,
  stateFilePath,
  type ReplayResult,
  type StoreClock,
  type StoreEventEnvelope
} from "./ndjson-store.js";

export type CasRunnerDispatchStoreEvent = StoreEventEnvelope<
  CasRunnerDispatchRecord & Record<string, unknown>
>;

export class CasRunnerDispatchStore {
  private readonly filePath: string;
  private readonly clock?: StoreClock;

  constructor(options: { stateDir?: string; clock?: StoreClock } = {}) {
    this.filePath = stateFilePath("cas-runner-dispatch.ndjson", options.stateDir);
    this.clock = options.clock;
  }

  async append(record: CasRunnerDispatchRecord): Promise<CasRunnerDispatchStoreEvent> {
    return appendStoreEvent(
      this.filePath,
      `cas_runner_dispatch.${record.kind}`,
      record as CasRunnerDispatchRecord & Record<string, unknown>,
      {
        eventId: record.id,
        clock: this.clock
      }
    );
  }

  async replay(): Promise<ReplayResult<CasRunnerDispatchRecord & Record<string, unknown>>> {
    return replayStoreEvents(this.filePath, { quarantineCorruptFinalLine: true });
  }

  async list(): Promise<CasRunnerDispatchRecord[]> {
    const replay = await this.replay();
    return replay.records.map((record) => record.data);
  }
}
