import {
  canonicalInputHash,
  replayStoreEvents,
  appendStoreEvent,
  stateFilePath,
  type ReplayResult,
  type StoreClock,
  type StoreEventEnvelope
} from "./ndjson-store.js";

export type IdempotencyDecision =
  | {
      status: "new";
      key: string;
      input_hash: string;
    }
  | {
      status: "duplicate";
      key: string;
      input_hash: string;
    }
  | {
      status: "conflict";
      key: string;
      input_hash: string;
      existing_hash: string;
    };

export interface IdempotencyRecord extends Record<string, unknown> {
  key: string;
  input_hash: string;
  created_at: string;
}

export type IdempotencyStoreEvent = StoreEventEnvelope<IdempotencyRecord>;

export class IdempotencyStore {
  private readonly filePath: string;
  private readonly clock?: StoreClock;
  private hydrated = false;
  private readonly hashesByKey = new Map<string, string>();

  constructor(options: { stateDir?: string; clock?: StoreClock } = {}) {
    this.filePath = stateFilePath("idempotency-events.ndjson", options.stateDir);
    this.clock = options.clock;
  }

  async has(key: string): Promise<boolean> {
    await this.hydrate();
    return this.hashesByKey.has(key);
  }

  async remember(key: string): Promise<void> {
    await this.checkAndRemember(key, key);
  }

  async check(key: string, canonicalInput: unknown): Promise<IdempotencyDecision> {
    await this.hydrate();
    const inputHash = canonicalInputHash(canonicalInput);
    const existingHash = this.hashesByKey.get(key);

    if (existingHash === undefined) {
      return { status: "new", key, input_hash: inputHash };
    }

    if (existingHash === inputHash) {
      return { status: "duplicate", key, input_hash: inputHash };
    }

    return {
      status: "conflict",
      key,
      input_hash: inputHash,
      existing_hash: existingHash
    };
  }

  async checkAndRemember(key: string, canonicalInput: unknown): Promise<IdempotencyDecision> {
    const decision = await this.check(key, canonicalInput);

    if (decision.status !== "new") {
      return decision;
    }

    const record: IdempotencyRecord = {
      key,
      input_hash: decision.input_hash,
      created_at: (this.clock?.now() ?? new Date()).toISOString()
    };

    await appendStoreEvent(this.filePath, "idempotency.recorded", record, {
      eventId: key,
      clock: this.clock
    });
    this.hashesByKey.set(key, decision.input_hash);
    return decision;
  }

  async replay(): Promise<ReplayResult<IdempotencyRecord>> {
    return replayStoreEvents(this.filePath, { quarantineCorruptFinalLine: true });
  }

  async hydrate(): Promise<ReplayResult<IdempotencyRecord>> {
    const replay = await this.replay();
    this.hashesByKey.clear();

    for (const event of replay.records) {
      this.hashesByKey.set(event.data.key, event.data.input_hash);
    }

    this.hydrated = true;
    return replay;
  }

  async list(): Promise<IdempotencyRecord[]> {
    const replay = await this.hydrate();
    return replay.records.map((record) => record.data);
  }
}
