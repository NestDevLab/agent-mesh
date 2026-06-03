import type { PolicyDecisionRecord } from "../schema/policy-decision.js";
import {
  appendStoreEvent,
  replayStoreEvents,
  stateFilePath,
  type ReplayResult,
  type StoreClock,
  type StoreEventEnvelope
} from "./ndjson-store.js";

export type PolicyDecisionStoreEvent = StoreEventEnvelope<
  PolicyDecisionRecord & Record<string, unknown>
>;

export class PolicyDecisionStore {
  private readonly filePath: string;
  private readonly clock?: StoreClock;

  constructor(options: { stateDir?: string; clock?: StoreClock } = {}) {
    this.filePath = stateFilePath("policy-decisions.ndjson", options.stateDir);
    this.clock = options.clock;
  }

  async append(decision: PolicyDecisionRecord): Promise<PolicyDecisionStoreEvent> {
    return appendStoreEvent(
      this.filePath,
      "policy_decision.recorded",
      decision as PolicyDecisionRecord & Record<string, unknown>,
      {
        eventId: decision.decision_id,
        clock: this.clock
      }
    );
  }

  async replay(): Promise<ReplayResult<PolicyDecisionRecord & Record<string, unknown>>> {
    return replayStoreEvents(this.filePath, { quarantineCorruptFinalLine: true });
  }

  async list(): Promise<PolicyDecisionRecord[]> {
    const replay = await this.replay();
    return replay.records.map((record) => record.data);
  }
}
