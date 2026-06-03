import type { AdapterDispatchResult, MeshTransportAdapter } from "./adapter.js";
import type { DeliveryRecord } from "../schema/delivery.js";
import type { AgentMessageEnvelopeV1 } from "../schema/envelope.js";

export class DiscordTranscriptStubAdapter implements MeshTransportAdapter {
  readonly id = "discord-transcript-stub";

  async dispatch(
    delivery: DeliveryRecord,
    envelope: AgentMessageEnvelopeV1
  ): Promise<AdapterDispatchResult> {
    const discordMetadata = readDiscordMetadata(envelope);
    const internalToDiscordCorrelation = {
      schema: "openclaw.discord_transcript_correlation.v1",
      mode: "stub",
      no_external_send: true,
      internal: {
        message_id: envelope.message_id,
        conversation_id: envelope.conversation_id,
        correlation_id: envelope.correlation_id ?? null,
        trace_id: envelope.trace_id ?? null,
        causation_id: envelope.causation_id ?? null,
        from_agent_id: envelope.from,
        to_agent_id: envelope.to
      },
      discord: {
        account_id: discordMetadata.account_id,
        guild_id: discordMetadata.guild_id,
        channel_id: discordMetadata.channel_id,
        thread_id: discordMetadata.thread_id,
        message_id: null
      },
      delivery: {
        delivery_id: delivery.id,
        adapter_id: delivery.adapter_id,
        target_agent_id: delivery.target_agent_id
      }
    };

    return {
      status: "stubbed",
      external_id: `discord-transcript-stub:${delivery.id}`,
      details: {
        no_external_send: true,
        mirrored_message_id: envelope.message_id,
        conversation_id: envelope.conversation_id,
        correlation_id: envelope.correlation_id ?? null,
        trace_id: envelope.trace_id ?? null,
        causation_id: envelope.causation_id ?? null,
        internal_to_discord_correlation: internalToDiscordCorrelation
      }
    };
  }
}

function readDiscordMetadata(envelope: AgentMessageEnvelopeV1): {
  account_id: string | null;
  guild_id: string | null;
  channel_id: string | null;
  thread_id: string | null;
} {
  const discord = envelope.metadata?.discord;
  if (
    discord === undefined ||
    discord === null ||
    typeof discord !== "object" ||
    Array.isArray(discord)
  ) {
    return {
      account_id: null,
      guild_id: null,
      channel_id: null,
      thread_id: null
    };
  }

  const record = discord as Record<string, unknown>;
  return {
    account_id: stringOrNull(record.account_id),
    guild_id: stringOrNull(record.guild_id),
    channel_id: stringOrNull(record.channel_id),
    thread_id: stringOrNull(record.thread_id)
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
