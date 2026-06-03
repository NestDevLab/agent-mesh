import type { DiscordDeliveryPlan } from "../schema/discord-delivery-plan.js";
import {
  appendStoreEvent,
  replayStoreEvents,
  stateFilePath,
  type ReplayResult,
  type StoreClock,
  type StoreEventEnvelope
} from "./ndjson-store.js";

export type DiscordDeliveryPlanStoreEvent = StoreEventEnvelope<
  DiscordDeliveryPlan & Record<string, unknown>
>;

export class DiscordDeliveryPlanStore {
  private readonly filePath: string;
  private readonly clock?: StoreClock;

  constructor(options: { stateDir?: string; clock?: StoreClock } = {}) {
    this.filePath = stateFilePath("discord-delivery-plans.ndjson", options.stateDir);
    this.clock = options.clock;
  }

  async append(plan: DiscordDeliveryPlan): Promise<DiscordDeliveryPlanStoreEvent> {
    return appendStoreEvent(
      this.filePath,
      eventTypeForPlan(plan),
      plan as DiscordDeliveryPlan & Record<string, unknown>,
      {
        eventId: plan.id,
        clock: this.clock
      }
    );
  }

  async replay(): Promise<ReplayResult<DiscordDeliveryPlan & Record<string, unknown>>> {
    return replayStoreEvents(this.filePath, { quarantineCorruptFinalLine: true });
  }

  async list(): Promise<DiscordDeliveryPlan[]> {
    const replay = await this.replay();
    return replay.records.map((record) => record.data);
  }
}

function eventTypeForPlan(plan: DiscordDeliveryPlan): string {
  if (plan.decision === "deny") {
    return "discord.delivery_plan.denied";
  }
  if (plan.decision === "ask-human") {
    return "discord.delivery_plan.requires_human";
  }
  return "discord.delivery_plan.planned_stubbed";
}
