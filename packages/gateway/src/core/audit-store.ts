import type { AuditEvent, AuditFilter } from "../schema/audit.js";
import {
  appendStoreEvent,
  replayStoreEvents,
  stateFilePath,
  type ReplayResult,
  type StoreClock,
  type StoreEventEnvelope
} from "./ndjson-store.js";

export type AuditStoreEvent = StoreEventEnvelope<AuditEvent & Record<string, unknown>>;

export class AuditStore {
  private readonly filePath: string;
  private readonly clock?: StoreClock;

  constructor(options: { stateDir?: string; clock?: StoreClock } = {}) {
    this.filePath = stateFilePath("audit-events.ndjson", options.stateDir);
    this.clock = options.clock;
  }

  async append(event: AuditEvent): Promise<AuditStoreEvent> {
    return appendStoreEvent(
      this.filePath,
      event.type,
      event as AuditEvent & Record<string, unknown>,
      {
        eventId: event.id,
        clock: this.clock
      }
    );
  }

  async replay(): Promise<ReplayResult<AuditEvent & Record<string, unknown>>> {
    return replayStoreEvents(this.filePath, { quarantineCorruptFinalLine: true });
  }

  async list(filter: AuditFilter = {}): Promise<AuditEvent[]> {
    const replay = await this.replay();
    return replay.records
      .map((record) => record.data)
      .filter((event) => {
        if (filter.type !== undefined && event.type !== filter.type) {
          return false;
        }
        if (filter.message_id !== undefined && event.message_id !== filter.message_id) {
          return false;
        }
        return !(
          filter.correlation_id !== undefined && event.correlation_id !== filter.correlation_id
        );
      });
  }
}
