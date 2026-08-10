import type { DeliveryRecord } from "../schema/delivery.js";
import type { AgentMessageEnvelopeV1 } from "../schema/envelope.js";
import type { CapacityAdmissionResult, CapacityRoutePolicy, CapacityWorkClass } from "../schema/capacity-admission.js";
import { appendStoreEvent, replayStoreEvents, stateFilePath, type ReplayResult, type StoreClock, type StoreEventEnvelope } from "./ndjson-store.js";

export type CapacityQueueStatus = "waiting_capacity" | "dispatched" | "failed";

export interface CapacityQueueRecord {
  id: string;
  idempotency_key: string;
  work_class: CapacityWorkClass;
  status: CapacityQueueStatus;
  retry_at: number;
  attempts: number;
  delivery: DeliveryRecord;
  envelope: AgentMessageEnvelopeV1;
  route: CapacityRoutePolicy;
  decision?: CapacityAdmissionResult;
  reason: string;
  updated_at: string;
}

export type CapacityQueueStoreEvent = StoreEventEnvelope<CapacityQueueRecord & Record<string, unknown>>;

export class CapacityQueueStore {
  private readonly filePath: string;
  private readonly clock?: StoreClock;

  constructor(options: { stateDir?: string; clock?: StoreClock } = {}) {
    this.filePath = stateFilePath("capacity-queue-events.ndjson", options.stateDir);
    this.clock = options.clock;
  }

  async append(record: CapacityQueueRecord): Promise<CapacityQueueStoreEvent> {
    return appendStoreEvent(this.filePath, `capacity_queue.${record.status}`, record as CapacityQueueRecord & Record<string, unknown>, { eventId: `${record.id}.${record.attempts}.${record.status}`, clock: this.clock });
  }

  async replay(): Promise<ReplayResult<CapacityQueueRecord & Record<string, unknown>>> {
    return replayStoreEvents(this.filePath, { quarantineCorruptFinalLine: true });
  }

  async latest(): Promise<CapacityQueueRecord[]> {
    const replay = await this.replay();
    const latest = new Map<string, CapacityQueueRecord>();
    for (const event of replay.records) latest.set(event.data.idempotency_key, event.data);
    return [...latest.values()];
  }

  async waiting(now?: number): Promise<CapacityQueueRecord[]> {
    const priority: Record<CapacityWorkClass, number> = { L1: 0, L2: 1, L3: 2 };
    return (await this.latest())
      .filter(record => record.status === "waiting_capacity" && (now === undefined || record.retry_at <= now))
      .sort((left, right) => priority[left.work_class] - priority[right.work_class] || left.retry_at - right.retry_at || left.idempotency_key.localeCompare(right.idempotency_key));
  }
}
