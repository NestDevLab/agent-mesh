import type { ConversationActRecord, ConversationActType } from "../schema/conversation-act.js";
import {
  CONVERSATION_ACT_SCHEMA,
  validateConversationActRecord
} from "../schema/conversation-act.js";
import {
  initialConversationTaskState,
  reduceConversationAct,
  type ConversationReduction,
  type ConversationTaskState
} from "./conversation-reducer.js";
import { canonicalInputHash, isoNow, type StoreClock } from "./ndjson-store.js";

export interface ConversationTurnInput {
  task_id: string;
  actor_id: string;
  message_id: string;
  text: string;
  state?: ConversationTaskState;
}

export interface ConversationTurnPlan {
  dry_run: true;
  act_record: ConversationActRecord;
  reduction: ConversationReduction;
  reply_plan?: {
    send: false;
    target_actor_id?: string;
    body: string;
  };
}

export function planConversationTurn(
  input: ConversationTurnInput,
  options: { clock?: StoreClock } = {}
): ConversationTurnPlan {
  const actRecord: ConversationActRecord = {
    schema: CONVERSATION_ACT_SCHEMA,
    task_id: input.task_id,
    message_id: input.message_id,
    actor_id: input.actor_id,
    observed_at: isoNow(options.clock),
    ...classifyConversationAct(input.text)
  };

  const validation = validateConversationActRecord(actRecord);
  if (!validation.ok) {
    throw new Error(`Invalid ConversationActRecord: ${validation.issues.map((issue) => `${issue.path} ${issue.message}`).join(", ")}`);
  }

  const state = input.state ?? initialConversationTaskState(input.task_id);
  const reduction = reduceConversationAct(state, actRecord);
  const replyPlan = buildReplyPlan(actRecord, reduction);
  return {
    dry_run: true,
    act_record: actRecord,
    reduction,
    ...(replyPlan ? { reply_plan: replyPlan } : {})
  };
}

export function classifyConversationAct(text: string): Pick<ConversationActRecord, "act" | "summary" | "confidence" | "target_agent_id" | "metadata"> {
  const normalized = text.trim();
  const lower = normalized.toLowerCase();
  const targetAgentId = extractMention(lower);

  if (!normalized) return { act: "noise", summary: "empty message", confidence: 0.99 };
  if (matches(lower, ["done", "complete", "completed", "finished", "resolved"])) {
    return { act: "complete", summary: normalized, confidence: 0.86 };
  }
  if (matches(lower, ["blocked", "cannot", "can't", "failed", "missing access", "error"])) {
    return { act: "blocked", summary: normalized, confidence: 0.84 };
  }
  if (matches(lower, ["waiting", "awaiting", "pending", "hold", "stand by"])) {
    return { act: "waiting", summary: normalized, confidence: 0.82 };
  }
  if (lower.includes("?")) {
    return { act: "question", summary: normalized, confidence: 0.78 };
  }
  if (matches(lower, ["handoff", "ask", "delegate", "forward to", "next:"])) {
    return {
      act: "handoff",
      summary: normalized,
      confidence: targetAgentId ? 0.81 : 0.62,
      ...(targetAgentId ? { target_agent_id: targetAgentId } : {})
    };
  }
  if (matches(lower, ["pause", "stop here", "pausing"])) {
    return { act: "pause_ack", summary: normalized, confidence: 0.9 };
  }
  if (matches(lower, ["will", "i'll", "i will", "follow up", "later"])) {
    return { act: "commitment", summary: normalized, confidence: 0.7 };
  }
  if (matches(lower, ["progress", "working", "implemented", "updated", "added"])) {
    return { act: "progress_update", summary: normalized, confidence: 0.72 };
  }
  if (matches(lower, ["review", "checked", "verified"])) {
    return { act: "review", summary: normalized, confidence: 0.74 };
  }
  if (matches(lower, ["correction", "actually", "fix:"])) {
    return { act: "correction", summary: normalized, confidence: 0.7 };
  }
  return { act: "contribution", summary: normalized, confidence: 0.58, metadata: { content_hash: canonicalInputHash(normalized) } };
}

function buildReplyPlan(
  actRecord: ConversationActRecord,
  reduction: ConversationReduction
): ConversationTurnPlan["reply_plan"] | undefined {
  switch (reduction.next_action) {
    case "answer_question":
      return { send: false, body: "Answer or convert this into a human-request packet before continuing." };
    case "create_human_request":
      return { send: false, body: "Create a human request packet and pause the task until a decision arrives." };
    case "handoff":
      return { send: false, target_actor_id: actRecord.target_agent_id ?? undefined, body: "Plan a bounded handoff to the allowlisted next actor." };
    case "verify_completion":
      return { send: false, body: "Verify the completion claim against evidence before closing the task." };
    default:
      return undefined;
  }
}

function matches(text: string, fragments: string[]): boolean {
  return fragments.some((fragment) => text.includes(fragment));
}

function extractMention(text: string): string | undefined {
  const mention = text.match(/<@([a-z0-9:_-]+)>/i);
  if (mention?.[1]) return mention[1];
  const named = text.match(/(?:to|ask|delegate)\s+([a-z][a-z0-9:_-]+)/i);
  return named?.[1];
}
