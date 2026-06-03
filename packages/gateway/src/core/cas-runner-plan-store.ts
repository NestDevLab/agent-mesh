import type { CasRunnerPlanRecord } from "../schema/cas-runner-plan.js";
import {
  appendStoreEvent,
  replayStoreEvents,
  stateFilePath,
  type ReplayResult,
  type StoreClock,
  type StoreEventEnvelope
} from "./ndjson-store.js";

export type CasRunnerPlanStoreEvent = StoreEventEnvelope<
  CasRunnerPlanRecord & Record<string, unknown>
>;

export class CasRunnerPlanStore {
  private readonly filePath: string;
  private readonly clock?: StoreClock;

  constructor(options: { stateDir?: string; clock?: StoreClock } = {}) {
    this.filePath = stateFilePath("cas-runner-plans.ndjson", options.stateDir);
    this.clock = options.clock;
  }

  async append(plan: CasRunnerPlanRecord): Promise<CasRunnerPlanStoreEvent> {
    return appendStoreEvent(
      this.filePath,
      "cas_runner_plan.recorded",
      plan as CasRunnerPlanRecord & Record<string, unknown>,
      {
        eventId: plan.id,
        clock: this.clock
      }
    );
  }

  async replay(): Promise<ReplayResult<CasRunnerPlanRecord & Record<string, unknown>>> {
    return replayStoreEvents(this.filePath, { quarantineCorruptFinalLine: true });
  }

  async list(): Promise<CasRunnerPlanRecord[]> {
    const replay = await this.replay();
    return replay.records.map((record) => record.data);
  }
}
