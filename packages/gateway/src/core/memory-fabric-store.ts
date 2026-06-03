import type { MemoryFabricPolicyEvaluation } from "../schema/memory-fabric.js";
import {
  appendStoreEvent,
  replayStoreEvents,
  stateFilePath,
  type ReplayResult,
  type StoreClock,
  type StoreEventEnvelope
} from "./ndjson-store.js";

export type MemoryFabricStoreEvent = StoreEventEnvelope<
  MemoryFabricPolicyEvaluation & Record<string, unknown>
>;

export class MemoryFabricStore {
  private readonly filePath: string;
  private readonly clock?: StoreClock;

  constructor(options: { stateDir?: string; clock?: StoreClock } = {}) {
    this.filePath = stateFilePath("memory-fabric-events.ndjson", options.stateDir);
    this.clock = options.clock;
  }

  async append(evaluation: MemoryFabricPolicyEvaluation): Promise<MemoryFabricStoreEvent> {
    return appendStoreEvent(
      this.filePath,
      eventTypeForEvaluation(evaluation),
      evaluation as MemoryFabricPolicyEvaluation & Record<string, unknown>,
      {
        eventId: evaluation.decision.id,
        clock: this.clock
      }
    );
  }

  async replay(): Promise<ReplayResult<MemoryFabricPolicyEvaluation & Record<string, unknown>>> {
    return replayStoreEvents(this.filePath, { quarantineCorruptFinalLine: true });
  }

  async list(): Promise<MemoryFabricPolicyEvaluation[]> {
    const replay = await this.replay();
    return replay.records.map((record) => record.data);
  }
}

function eventTypeForEvaluation(evaluation: MemoryFabricPolicyEvaluation): string {
  if (evaluation.decision.decision === "deny") {
    return "memory.proposal.denied";
  }
  if (evaluation.decision.decision === "ask-human") {
    return "memory.proposal.requires_human";
  }
  return "memory.proposal.allowed_stubbed";
}
