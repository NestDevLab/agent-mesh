import type {
  DiscordControllerTaskState,
  DiscordControllerTurnInput,
  DiscordControllerTurnPlan
} from "../schema/discord-bot-controller.js";
import { planConversationTurn } from "./conversation-orchestrator.js";
import { canonicalInputHash } from "./ndjson-store.js";

export function planDiscordBotControllerTurn(
  input: DiscordControllerTurnInput
): DiscordControllerTurnPlan {
  const state = input.state;
  const contentHash = input.message_hash ?? canonicalInputHash(input.text.trim().toLowerCase());

  if (input.channel_id !== state.channel_id) {
    return rejected("channel_not_allowlisted", "pause");
  }
  if (!state.participant_allowlist.includes(input.actor_id)) {
    return rejected("participant_not_allowlisted", "pause");
  }
  if (state.seen_message_ids.includes(input.message_id)) {
    return rejected("duplicate_message_id", "none");
  }
  if (state.seen_content_hashes.includes(contentHash)) {
    return rejected("duplicate_content_hash", "none");
  }
  if (state.turn_budget_remaining <= 0) {
    return rejected("turn_budget_exhausted", "pause");
  }
  if (state.waiting_backoff_active && state.expected_next_actor && input.actor_id !== state.expected_next_actor) {
    return rejected("waiting_backoff_active", "none");
  }

  const turn = planConversationTurn({
    task_id: input.task_id,
    actor_id: input.actor_id,
    message_id: input.message_id,
    text: input.text
  });

  const nextState: Partial<DiscordControllerTaskState> = {
    seen_message_ids: [...state.seen_message_ids, input.message_id],
    seen_content_hashes: [...state.seen_content_hashes, contentHash],
    turn_budget_remaining: state.turn_budget_remaining - 1,
    expected_next_actor: turn.reduction.state.expected_next_actor,
    status: mapStatus(turn.reduction.state.status),
    waiting_backoff_active: turn.reduction.state.status === "waiting"
  };

  if (
    turn.reduction.next_action === "handoff" &&
    (
      !turn.act_record.target_agent_id ||
      turn.act_record.confidence < 0.75 ||
      !state.participant_allowlist.includes(turn.act_record.target_agent_id)
    )
  ) {
    return {
      dry_run: true,
      accepted: true,
      reason: "handoff_requires_confirmation",
      act: turn.act_record.act,
      next_action: "request_human",
      follow_up: {
        send: false,
        body: "Low-confidence handoff: confirm the exact next bot/agent before mentioning anyone."
      },
      state_transition: nextState
    };
  }

  return {
    dry_run: true,
    accepted: true,
    reason: turn.reduction.next_action,
    act: turn.act_record.act,
    next_action: mapNextAction(turn.reduction.next_action),
    ...(turn.reply_plan
      ? {
          follow_up: {
            send: false,
            body: turn.reply_plan.body,
            ...(turn.reply_plan.target_actor_id ? { mention_actor_id: turn.reply_plan.target_actor_id } : {})
          }
        }
      : {}),
    state_transition: nextState
  };
}

function rejected(reason: string, nextAction: DiscordControllerTurnPlan["next_action"]): DiscordControllerTurnPlan {
  return { dry_run: true, accepted: false, reason, next_action: nextAction };
}

function mapNextAction(action: string): DiscordControllerTurnPlan["next_action"] {
  switch (action) {
    case "pause":
      return "pause";
    case "verify_completion":
      return "verify_completion";
    case "create_human_request":
      return "request_human";
    case "handoff":
    case "answer_question":
      return "send_follow_up_dry_run";
    default:
      return "none";
  }
}

function mapStatus(status: string): DiscordControllerTaskState["status"] {
  switch (status) {
    case "waiting":
    case "blocked":
    case "paused":
    case "completed":
      return status;
    default:
      return "active";
  }
}
