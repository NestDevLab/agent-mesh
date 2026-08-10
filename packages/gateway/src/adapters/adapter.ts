import type { DeliveryRecord } from "../schema/delivery.js";
import type { AgentMessageEnvelopeV1 } from "../schema/envelope.js";

export interface AdapterDispatchResult {
  status: "delivered" | "failed" | "stubbed" | "waiting_capacity";
  external_id?: string;
  details?: Record<string, unknown>;
}

export interface MeshTransportAdapter {
  id: string;
  dispatch(
    delivery: DeliveryRecord,
    envelope: AgentMessageEnvelopeV1
  ): Promise<AdapterDispatchResult>;
}
