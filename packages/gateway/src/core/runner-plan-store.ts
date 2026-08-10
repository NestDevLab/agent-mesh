import type { RunnerPlanRecord } from "../schema/runner-plan.js";
import {
  appendStoreEvent,
  replayStoreEvents,
  stateFilePath,
  type ReplayResult,
  type StoreClock,
  type StoreEventEnvelope
} from "./ndjson-store.js";

export type RunnerPlanStoreEvent = StoreEventEnvelope<
  RunnerPlanRecord & Record<string, unknown>
>;

export class RunnerPlanStore {
  private readonly filePath: string;
  private readonly clock?: StoreClock;

  constructor(options: { stateDir?: string; clock?: StoreClock } = {}) {
    this.filePath = stateFilePath("runner-plans.ndjson", options.stateDir);
    this.clock = options.clock;
  }

  async append(plan: RunnerPlanRecord): Promise<RunnerPlanStoreEvent> {
    return appendStoreEvent(
      this.filePath,
      "runner_plan.recorded",
      plan as RunnerPlanRecord & Record<string, unknown>,
      {
        eventId: plan.id,
        clock: this.clock
      }
    );
  }

  async replay(): Promise<ReplayResult<RunnerPlanRecord & Record<string, unknown>>> {
    return replayStoreEvents(this.filePath, { quarantineCorruptFinalLine: true });
  }

  async list(): Promise<RunnerPlanRecord[]> {
    const replay = await this.replay();
    return replay.records.map((record) => record.data);
  }
}
