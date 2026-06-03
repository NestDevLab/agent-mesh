import type { DeliveryRecord } from "../schema/delivery.js";
import {
  appendStoreEvent,
  replayStoreEvents,
  stateFilePath,
  type ReplayResult,
  type StoreClock,
  type StoreEventEnvelope
} from "./ndjson-store.js";

export type DeliveryStoreEvent = StoreEventEnvelope<DeliveryRecord & Record<string, unknown>>;

export class DeliveryStore {
  private readonly filePath: string;
  private readonly clock?: StoreClock;

  constructor(options: { stateDir?: string; clock?: StoreClock } = {}) {
    this.filePath = stateFilePath("delivery-events.ndjson", options.stateDir);
    this.clock = options.clock;
  }

  async append(record: DeliveryRecord): Promise<DeliveryStoreEvent> {
    return appendStoreEvent(
      this.filePath,
      `delivery.${record.status}`,
      record as DeliveryRecord & Record<string, unknown>,
      {
        eventId: record.id,
        clock: this.clock
      }
    );
  }

  async replay(): Promise<ReplayResult<DeliveryRecord & Record<string, unknown>>> {
    return replayStoreEvents(this.filePath, { quarantineCorruptFinalLine: true });
  }

  async list(): Promise<DeliveryRecord[]> {
    const replay = await this.replay();
    return replay.records.map((record) => record.data);
  }

  async listByMessageId(messageId: string): Promise<DeliveryRecord[]> {
    const records = await this.list();
    return records.filter((record) => record.message_id === messageId);
  }
}
