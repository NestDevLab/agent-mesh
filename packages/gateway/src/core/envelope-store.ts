import type { AgentMessageEnvelopeV1 } from "../schema/envelope.js";
import {
  appendStoreEvent,
  replayStoreEvents,
  stateFilePath,
  type ReplayResult,
  type StoreClock,
  type StoreEventEnvelope
} from "./ndjson-store.js";

export type EnvelopeStoreEvent = StoreEventEnvelope<AgentMessageEnvelopeV1 & Record<string, unknown>>;

export class EnvelopeStore {
  private readonly filePath: string;
  private readonly clock?: StoreClock;

  constructor(options: { stateDir?: string; clock?: StoreClock } = {}) {
    this.filePath = stateFilePath("envelopes.ndjson", options.stateDir);
    this.clock = options.clock;
  }

  async append(envelope: AgentMessageEnvelopeV1): Promise<EnvelopeStoreEvent> {
    return appendStoreEvent(
      this.filePath,
      "envelope.recorded",
      envelope as AgentMessageEnvelopeV1 & Record<string, unknown>,
      {
        eventId: envelope.message_id,
        clock: this.clock
      }
    );
  }

  async replay(): Promise<ReplayResult<AgentMessageEnvelopeV1 & Record<string, unknown>>> {
    return replayStoreEvents(this.filePath, { quarantineCorruptFinalLine: true });
  }

  async list(): Promise<AgentMessageEnvelopeV1[]> {
    const replay = await this.replay();
    return replay.records.map((record) => record.data);
  }
}
