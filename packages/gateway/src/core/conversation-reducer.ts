import type { ConversationActRecord, ConversationActType } from "../schema/conversation-act.js";

export type ConversationTaskStatus = "active" | "waiting" | "blocked" | "paused" | "completed" | "needs_human";

export interface ConversationTaskState {
  task_id: string;
  status: ConversationTaskStatus;
  progress_count: number;
  evidence: string[];
  blocked_reason?: string;
  waiting_reason?: string;
  expected_next_actor?: string;
  last_message_id?: string;
  reviewed_completion?: boolean;
}

export interface ConversationReduction {
  state: ConversationTaskState;
  next_action:
    | "record_only"
    | "answer_question"
    | "create_human_request"
    | "handoff"
    | "pause"
    | "verify_completion"
    | "suppress";
  stop: boolean;
}

export function reduceConversationAct(
  state: ConversationTaskState,
  act: ConversationActRecord
): ConversationReduction {
  const next: ConversationTaskState = {
    ...state,
    last_message_id: act.message_id
  };

  switch (act.act) {
    case "contribution":
    case "review":
      next.progress_count += 1;
      next.evidence = appendEvidence(next.evidence, act.summary);
      next.status = "active";
      return { state: next, next_action: "record_only", stop: false };
    case "progress_update":
      next.progress_count += 1;
      next.evidence = appendEvidence(next.evidence, act.summary);
      next.status = "active";
      return { state: next, next_action: "record_only", stop: false };
    case "waiting":
      next.status = "waiting";
      next.waiting_reason = act.summary;
      return { state: next, next_action: "pause", stop: true };
    case "blocked":
      next.status = "blocked";
      next.blocked_reason = act.summary;
      return { state: next, next_action: "create_human_request", stop: true };
    case "question":
      next.status = "needs_human";
      return { state: next, next_action: "answer_question", stop: false };
    case "handoff":
      next.expected_next_actor = act.target_agent_id ?? undefined;
      return { state: next, next_action: "handoff", stop: false };
    case "complete":
      next.status = "completed";
      next.reviewed_completion = false;
      next.evidence = appendEvidence(next.evidence, act.summary);
      return { state: next, next_action: "verify_completion", stop: true };
    case "correction":
      next.evidence = appendEvidence(next.evidence, `correction:${act.summary}`);
      next.status = "active";
      return { state: next, next_action: "record_only", stop: false };
    case "pause_ack":
      next.status = "paused";
      return { state: next, next_action: "pause", stop: true };
    case "commitment":
      next.waiting_reason = act.summary;
      next.status = "waiting";
      return { state: next, next_action: "pause", stop: true };
    case "noise":
    default:
      return { state: next, next_action: "suppress", stop: false };
  }
}

function appendEvidence(evidence: string[], summary: string): string[] {
  if (!summary.trim()) return evidence;
  if (evidence.includes(summary)) return evidence;
  return [...evidence, summary];
}

export function initialConversationTaskState(taskId: string): ConversationTaskState {
  return {
    task_id: taskId,
    status: "active",
    progress_count: 0,
    evidence: []
  };
}

export function terminalActs(): ConversationActType[] {
  return ["waiting", "blocked", "complete", "pause_ack", "commitment"];
}
