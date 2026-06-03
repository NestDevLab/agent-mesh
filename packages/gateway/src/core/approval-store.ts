import type { ApprovalGateEvaluation } from "../schema/approval.js";
import {
  appendStoreEvent,
  replayStoreEvents,
  stateFilePath,
  type ReplayResult,
  type StoreClock,
  type StoreEventEnvelope
} from "./ndjson-store.js";

export type ApprovalStoreEvent = StoreEventEnvelope<
  ApprovalGateEvaluation & Record<string, unknown>
>;

export class ApprovalStore {
  private readonly filePath: string;
  private readonly clock?: StoreClock;

  constructor(options: { stateDir?: string; clock?: StoreClock } = {}) {
    this.filePath = stateFilePath("approval-events.ndjson", options.stateDir);
    this.clock = options.clock;
  }

  async append(evaluation: ApprovalGateEvaluation): Promise<ApprovalStoreEvent> {
    return appendStoreEvent(
      this.filePath,
      "approval_gate.evaluated",
      evaluation as ApprovalGateEvaluation & Record<string, unknown>,
      {
        eventId: evaluation.decision.id,
        clock: this.clock
      }
    );
  }

  async replay(): Promise<ReplayResult<ApprovalGateEvaluation & Record<string, unknown>>> {
    return replayStoreEvents(this.filePath, { quarantineCorruptFinalLine: true });
  }

  async list(): Promise<ApprovalGateEvaluation[]> {
    const replay = await this.replay();
    return replay.records.map((record) => record.data);
  }
}
