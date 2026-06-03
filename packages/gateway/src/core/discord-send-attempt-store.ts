import type { DiscordSendAttemptRecord } from "../schema/discord-send-attempt.js";
import {
  appendStoreEvent,
  replayStoreEvents,
  stateFilePath,
  type ReplayResult,
  type StoreClock,
  type StoreEventEnvelope
} from "./ndjson-store.js";

export type DiscordSendAttemptStoreEvent = StoreEventEnvelope<
  DiscordSendAttemptRecord & Record<string, unknown>
>;

export class DiscordSendAttemptStore {
  private readonly filePath: string;
  private readonly clock?: StoreClock;

  constructor(options: { stateDir?: string; clock?: StoreClock } = {}) {
    this.filePath = stateFilePath("discord-send-attempts.ndjson", options.stateDir);
    this.clock = options.clock;
  }

  async append(attempt: DiscordSendAttemptRecord): Promise<DiscordSendAttemptStoreEvent> {
    return appendStoreEvent(
      this.filePath,
      `discord.send_attempt.${attempt.status}`,
      attempt as DiscordSendAttemptRecord & Record<string, unknown>,
      {
        eventId: attempt.attempt_id,
        clock: this.clock
      }
    );
  }

  async replay(): Promise<ReplayResult<DiscordSendAttemptRecord & Record<string, unknown>>> {
    return replayStoreEvents(this.filePath, { quarantineCorruptFinalLine: true });
  }

  async list(): Promise<DiscordSendAttemptRecord[]> {
    const replay = await this.replay();
    return replay.records.map((record) => record.data);
  }
}
