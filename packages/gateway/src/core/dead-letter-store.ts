import {
  appendStoreEvent,
  replayStoreEvents,
  stateFilePath,
  type ReplayResult,
  type StoreClock,
  type StoreEventEnvelope
} from "./ndjson-store.js";

export interface DeadLetterRecord extends Record<string, unknown> {
  id: string;
  source_file: string;
  reason: string;
  created_at: string;
  payload?: unknown;
}

export type DeadLetterStoreEvent = StoreEventEnvelope<DeadLetterRecord>;

export class DeadLetterStore {
  private readonly filePath: string;
  private readonly clock?: StoreClock;

  constructor(options: { stateDir?: string; clock?: StoreClock } = {}) {
    this.filePath = stateFilePath("dead-letter-records.ndjson", options.stateDir);
    this.clock = options.clock;
  }

  async append(record: DeadLetterRecord): Promise<DeadLetterStoreEvent> {
    return appendStoreEvent(this.filePath, "dead_letter.recorded", record, {
      eventId: record.id,
      clock: this.clock
    });
  }

  async replay(): Promise<ReplayResult<DeadLetterRecord>> {
    return replayStoreEvents(this.filePath, { quarantineCorruptFinalLine: true });
  }

  async list(): Promise<DeadLetterRecord[]> {
    const replay = await this.replay();
    return replay.records.map((record) => record.data);
  }
}
