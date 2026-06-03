import type {
  ProactivityDecisionRecord,
  ProactivityOutcomeRecord,
  ProactivityRecord
} from "../schema/proactivity.js";
import {
  appendStoreEvent,
  replayStoreEvents,
  stateFilePath,
  type ReplayResult,
  type StoreClock,
  type StoreEventEnvelope
} from "./ndjson-store.js";

export type ProactivityStoreEvent = StoreEventEnvelope<
  ProactivityRecord & Record<string, unknown>
>;
export type ProactivityDecisionStoreEvent = StoreEventEnvelope<
  ProactivityDecisionRecord & Record<string, unknown>
>;
export type ProactivityOutcomeStoreEvent = StoreEventEnvelope<
  ProactivityOutcomeRecord & Record<string, unknown>
>;

export class ProactivityEventStore {
  private readonly filePath: string;
  private readonly clock?: StoreClock;

  constructor(options: { stateDir?: string; clock?: StoreClock } = {}) {
    this.filePath = stateFilePath("proactivity-events.ndjson", options.stateDir);
    this.clock = options.clock;
  }

  async append(record: ProactivityRecord): Promise<ProactivityStoreEvent> {
    return appendStoreEvent(
      this.filePath,
      "proactivity.proposed",
      record as ProactivityRecord & Record<string, unknown>,
      { eventId: record.event_id, clock: this.clock }
    );
  }

  async replay(): Promise<ReplayResult<ProactivityRecord & Record<string, unknown>>> {
    return replayStoreEvents(this.filePath, { quarantineCorruptFinalLine: true });
  }

  async list(): Promise<ProactivityRecord[]> {
    const replay = await this.replay();
    return replay.records.map((record) => record.data);
  }
}

export class ProactivityDecisionStore {
  private readonly filePath: string;
  private readonly clock?: StoreClock;

  constructor(options: { stateDir?: string; clock?: StoreClock } = {}) {
    this.filePath = stateFilePath("proactivity-decisions.ndjson", options.stateDir);
    this.clock = options.clock;
  }

  async append(record: ProactivityDecisionRecord): Promise<ProactivityDecisionStoreEvent> {
    return appendStoreEvent(
      this.filePath,
      "proactivity.decision.recorded",
      record as ProactivityDecisionRecord & Record<string, unknown>,
      { eventId: record.decision_id, clock: this.clock }
    );
  }

  async replay(): Promise<
    ReplayResult<ProactivityDecisionRecord & Record<string, unknown>>
  > {
    return replayStoreEvents(this.filePath, { quarantineCorruptFinalLine: true });
  }

  async list(): Promise<ProactivityDecisionRecord[]> {
    const replay = await this.replay();
    return replay.records.map((record) => record.data);
  }
}

export class ProactivityOutcomeStore {
  private readonly filePath: string;
  private readonly clock?: StoreClock;

  constructor(options: { stateDir?: string; clock?: StoreClock } = {}) {
    this.filePath = stateFilePath("proactivity-outcomes.ndjson", options.stateDir);
    this.clock = options.clock;
  }

  async append(record: ProactivityOutcomeRecord): Promise<ProactivityOutcomeStoreEvent> {
    return appendStoreEvent(
      this.filePath,
      "proactivity.outcome.recorded",
      record as ProactivityOutcomeRecord & Record<string, unknown>,
      { eventId: record.outcome_id, clock: this.clock }
    );
  }

  async replay(): Promise<ReplayResult<ProactivityOutcomeRecord & Record<string, unknown>>> {
    return replayStoreEvents(this.filePath, { quarantineCorruptFinalLine: true });
  }

  async list(): Promise<ProactivityOutcomeRecord[]> {
    const replay = await this.replay();
    return replay.records.map((record) => record.data);
  }
}
