import {
  appendStoreEvent,
  replayStoreEvents,
  stateFilePath,
  type ReplayResult,
  type StoreClock,
  type StoreEventEnvelope
} from "./ndjson-store.js";

export interface GatewayControlState extends Record<string, unknown> {
  paused: boolean;
  kill_switch: boolean;
  updated_at: string;
}

export type GatewayControlStoreEvent = StoreEventEnvelope<GatewayControlState>;

export class GatewayControlStore {
  private readonly filePath: string;
  private readonly clock?: StoreClock;

  constructor(options: { stateDir?: string; clock?: StoreClock } = {}) {
    this.filePath = stateFilePath("gateway-control-events.ndjson", options.stateDir);
    this.clock = options.clock;
  }

  async append(state: GatewayControlState): Promise<GatewayControlStoreEvent> {
    return appendStoreEvent(this.filePath, "gateway.control.updated", state, {
      clock: this.clock
    });
  }

  async replay(): Promise<ReplayResult<GatewayControlState>> {
    return replayStoreEvents(this.filePath, { quarantineCorruptFinalLine: true });
  }

  async current(): Promise<GatewayControlState | undefined> {
    const replay = await this.replay();
    return replay.records.at(-1)?.data;
  }
}
