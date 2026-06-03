import { createHash } from "crypto";
import { mkdir, unlink, writeFile } from "fs/promises";
import { dirname } from "path";
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

  /**
   * Atomically claim an idempotency key before a real send. Returns true if this
   * caller won the claim, false if another dispatch already holds it. Uses an
   * exclusive file create (O_EXCL), which is atomic on a local filesystem and so
   * is safe across concurrent dispatches and across processes — closing the
   * check-then-send race that a plain listByIdempotencyKey lookup leaves open.
   */
  async claim(key: string): Promise<boolean> {
    const path = this.claimPath(key);
    await mkdir(dirname(path), { recursive: true });
    try {
      await writeFile(path, "", { flag: "wx" });
      return true;
    } catch (error) {
      if (isAlreadyExists(error)) {
        return false;
      }
      throw error;
    }
  }

  /** Release a claim so a failed send can be retried. */
  async releaseClaim(key: string): Promise<void> {
    try {
      await unlink(this.claimPath(key));
    } catch (error) {
      if (isNotFound(error)) {
        // No claim to release is fine.
        return;
      }
      throw error;
    }
  }

  private claimPath(key: string): string {
    const digest = createHash("sha256").update(key).digest("hex");
    return `${this.filePath}.claims/${digest}.claim`;
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "EEXIST"
  );
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
