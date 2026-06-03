import {
  appendStoreEvent,
  replayStoreEvents,
  stateFilePath,
  type ReplayResult,
  type StoreClock,
  type StoreEventEnvelope
} from "./ndjson-store.js";

export interface TmuxDispatchRecord {
  id: string;
  message_id: string;
  adapter_id: "tmux-transport";
  target_agent_id: string;
  tmux_target: string;
  idempotency_key: string;
  status: "delivered" | "failed" | "stubbed";
  sender_called: boolean;
  reason: string;
  trace_id?: string | null;
  correlation_id?: string | null;
  causation_id?: string | null;
  created_at: string;
}

export type TmuxDispatchStoreEvent = StoreEventEnvelope<
  TmuxDispatchRecord & Record<string, unknown>
>;

export class TmuxDispatchStore {
  private readonly filePath: string;
  private readonly clock?: StoreClock;

  constructor(options: { stateDir?: string; clock?: StoreClock } = {}) {
    this.filePath = stateFilePath("tmux-dispatch-events.ndjson", options.stateDir);
    this.clock = options.clock;
  }

  async append(record: TmuxDispatchRecord): Promise<TmuxDispatchStoreEvent> {
    return appendStoreEvent(
      this.filePath,
      `tmux_dispatch.${record.status}`,
      record as TmuxDispatchRecord & Record<string, unknown>,
      {
        eventId: record.id,
        clock: this.clock
      }
    );
  }

  async replay(): Promise<ReplayResult<TmuxDispatchRecord & Record<string, unknown>>> {
    return replayStoreEvents(this.filePath, { quarantineCorruptFinalLine: true });
  }

  async list(): Promise<TmuxDispatchRecord[]> {
    const replay = await this.replay();
    return replay.records.map((record) => record.data);
  }

  async listByIdempotencyKey(key: string): Promise<TmuxDispatchRecord[]> {
    const records = await this.list();
    return records.filter((record) => record.idempotency_key === key);
  }
}
