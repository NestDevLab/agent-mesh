import type { AdapterDispatchResult, MeshTransportAdapter } from "./adapter.js";
import type { DeliveryRecord } from "../schema/delivery.js";
import type { AgentMessageEnvelopeV1 } from "../schema/envelope.js";

export class SimulatedAgentAdapter implements MeshTransportAdapter {
  readonly id = "simulated-agent";

  async dispatch(
    delivery: DeliveryRecord,
    envelope: AgentMessageEnvelopeV1
  ): Promise<AdapterDispatchResult> {
    return {
      status: "delivered",
      external_id: `simulated:${delivery.id}`,
      details: {
        simulated: true,
        target_agent_id: delivery.target_agent_id,
        message_id: envelope.message_id,
        conversation_id: envelope.conversation_id
      }
    };
  }
}
