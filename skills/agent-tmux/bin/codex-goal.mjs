import { withCodexAppServer } from "./codex-app-server.mjs";

export const GOAL_RESUME_MODES = ["blocked", "any", "off"];

// Codex keeps continuing a goal only while it is `active`. A model that sets its own goal to
// `blocked` while it waits for input never leaves that state by itself, so the message that
// carries the awaited input must reactivate it. `paused` is a deliberate stop and stays put
// unless the sender asks for `any`. Limited and complete goals are never touched.
export function goalDecision(goal, { objective, resume = "blocked" } = {}) {
  if (objective) {
    if (goal?.status === "active" && goal.objective === objective) {
      return { action: "none", reason: "same objective already active" };
    }
    return { action: "set", params: { objective, status: "active" } };
  }
  if (!goal) return { action: "none", reason: "no goal" };
  if (goal.status === "blocked" && resume !== "off") return { action: "resume", params: { status: "active" } };
  if (goal.status === "paused" && resume === "any") return { action: "resume", params: { status: "active" } };
  return { action: "none", reason: `goal ${goal.status}` };
}

export async function reconcileCodexGoal(threadId, options, timeout) {
  return withCodexAppServer({
    clientName: "agent-mesh-goal-on-send",
    timeout,
    timeoutMessage: "app-server goal call timed out; goal state unknown",
  }, async (request) => {
    await request("thread/resume", { threadId });
    const { goal } = await request("thread/goal/get", { threadId });
    const decision = goalDecision(goal, options);
    const before = goal?.status ?? null;
    if (decision.action === "none") return { action: "none", before, after: before, reason: decision.reason };
    const updated = await request("thread/goal/set", { threadId, ...decision.params, origin: "user" });
    return { action: decision.action, before, after: updated?.goal?.status ?? null };
  });
}
