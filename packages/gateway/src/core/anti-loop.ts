import type { AgentMessageEnvelopeV1 } from "../schema/envelope.js";
import type { Clock } from "./clock.js";

export interface AntiLoopResult {
  accepted: boolean;
  reason?: string;
}

export interface AntiLoopOptions {
  clock?: Clock;
  maxRepliesPerConversation?: number;
  history?: readonly AgentMessageEnvelopeV1[];
}

export function evaluateAntiLoop(
  envelope: AgentMessageEnvelopeV1,
  options: AntiLoopOptions = {}
): AntiLoopResult {
  const now = options.clock?.now() ?? new Date();
  const maxRepliesPerConversation = options.maxRepliesPerConversation ?? 8;
  const history = options.history ?? [];

  if (envelope.hop_count >= envelope.ttl) {
    return reject("ttl_exhausted");
  }

  if (envelope.expires_at !== undefined && Date.parse(envelope.expires_at) <= now.getTime()) {
    return reject("message_expired");
  }

  if (envelope.created_at !== undefined && Date.parse(envelope.created_at) > now.getTime() + 300000) {
    return reject("created_at_too_far_in_future");
  }

  if (envelope.from === envelope.to && !allowsSelfMessage(envelope)) {
    return reject("self_message_not_allowed");
  }

  const replyCount = history.filter(
    (record) =>
      record.conversation_id === envelope.conversation_id &&
      record.intent === "reply"
  ).length;
  if (envelope.intent === "reply" && replyCount >= maxRepliesPerConversation) {
    return reject("max_replies_per_conversation_exceeded");
  }

  if (envelope.content_hash !== undefined && envelope.content_hash !== null) {
    const pingPong = history.find(
      (record) =>
        record.conversation_id === envelope.conversation_id &&
        record.from === envelope.to &&
        record.to === envelope.from &&
        record.content_hash === envelope.content_hash
    );

    if (pingPong !== undefined) {
      return reject("repeated_bidirectional_content_hash");
    }
  }

  return { accepted: true };
}

function allowsSelfMessage(envelope: AgentMessageEnvelopeV1): boolean {
  return envelope.metadata?.allow_self_message === true;
}

function reject(reason: string): AntiLoopResult {
  return { accepted: false, reason };
}
