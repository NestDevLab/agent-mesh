import type { HeartbeatRecord } from "../schema/heartbeat.js";
import {
  appendStoreEvent,
  replayStoreEvents,
  stateFilePath,
  type ReplayResult,
  type StoreClock,
  type StoreEventEnvelope
} from "./ndjson-store.js";

export type HeartbeatStoreEvent = StoreEventEnvelope<HeartbeatRecord & Record<string, unknown>>;

export class HeartbeatStore {
  private readonly filePath: string;
  private readonly clock?: StoreClock;

  constructor(options: { stateDir?: string; clock?: StoreClock } = {}) {
    this.filePath = stateFilePath("heartbeats.ndjson", options.stateDir);
    this.clock = options.clock;
  }

  async append(record: HeartbeatRecord): Promise<HeartbeatStoreEvent> {
    return appendStoreEvent(
      this.filePath,
      "heartbeat.recorded",
      record as HeartbeatRecord & Record<string, unknown>,
      {
        eventId: record.id,
        clock: this.clock
      }
    );
  }

  async replay(): Promise<ReplayResult<HeartbeatRecord & Record<string, unknown>>> {
    return replayStoreEvents(this.filePath, { quarantineCorruptFinalLine: true });
  }

  async list(): Promise<HeartbeatRecord[]> {
    const replay = await this.replay();
    return replay.records.map((record) => record.data);
  }
}
