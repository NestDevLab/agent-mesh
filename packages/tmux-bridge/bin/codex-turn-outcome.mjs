/** Bind terminal Codex turn notifications to an exact thread and turn. */
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);

// Notifications are evidence of the native runtime's report, not authorization
// to retry, stop a session, settle a handover, or infer external side effects.
export function createCodexTurnOutcomeObserver() {
  let binding = null, overflow = false, observed = null;
  const pending = [];
  function apply(item) {
    if (!binding || item.thread !== binding.thread || item.turn !== binding.turn) return;
    const outcome = item.status === 'failed' && item.error === 'usageLimitExceeded' ? 'usage-limit' : 'other-terminal';
    if (observed === null) observed = outcome;
    else if (observed !== outcome) observed = 'ambiguous';
  }
  function onNotification(message) {
    const turn = message?.params?.turn, thread = message?.params?.threadId;
    if (message?.method !== 'turn/completed' || !uuid(thread) || !uuid(turn?.id) || !['completed', 'failed', 'interrupted'].includes(turn?.status)) return;
    const item = { thread, turn: turn.id, status: turn.status, error: typeof turn.error?.codexErrorInfo === 'string' ? turn.error.codexErrorInfo : null };
    if (binding) apply(item);
    else if (pending.length < 128) pending.push(item);
    else overflow = true;
  }
  function bind(thread, turn) {
    if (binding || !uuid(thread) || !uuid(turn)) throw new Error('invalid or repeated turn binding');
    binding = { thread, turn };
    for (const item of pending) apply(item);
    pending.length = 0;
  }
  function snapshot() {
    return { schema: 'agent-mesh.codex-turn-outcome-observation.v1', status: !binding || overflow ? 'unverified' : observed ?? 'unverified', retry: 'not-authorized' };
  }
  return { onNotification, bind, snapshot };
}
