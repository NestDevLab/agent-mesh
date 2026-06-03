import type { ConversationActType } from "./conversation-act.js";

export type DiscordControllerNextAction =
  | "none"
  | "send_follow_up_dry_run"
  | "pause"
  | "stop"
  | "verify_completion"
  | "request_human";

export interface DiscordControllerTaskState {
  task_id: string;
  channel_id: string;
  participant_allowlist: string[];
  expected_next_actor?: string;
  seen_message_ids: string[];
  seen_content_hashes: string[];
  turn_budget_remaining: number;
  waiting_backoff_active?: boolean;
  status: "active" | "waiting" | "blocked" | "paused" | "completed";
}

export interface DiscordControllerTurnInput {
  task_id: string;
  channel_id: string;
  actor_id: string;
  actor_label?: string;
  message_id: string;
  text: string;
  message_hash?: string;
  state: DiscordControllerTaskState;
}

export interface DiscordControllerTurnPlan {
  dry_run: true;
  accepted: boolean;
  reason: string;
  act?: ConversationActType;
  next_action: DiscordControllerNextAction;
  follow_up?: {
    send: false;
    body: string;
    mention_actor_id?: string;
  };
  state_transition?: Partial<DiscordControllerTaskState>;
}
