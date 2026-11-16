/** Passive, bounded sampling of already delivered native startup notifications. */
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const statuses = new Set(['starting', 'ready', 'failed', 'cancelled']);
const permissionMethods = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'mcpServer/elicitation/request']);
const validName = name => typeof name === 'string' && name.length > 0 && name.length <= 512 && !/[\x00-\x1f\x7f]/.test(name);

// Attach before starting the thread. The native response can bind the thread
// after notifications arrive. Captured names never leave this in-memory object.
export function createCodexMcpStartupObserver() {
  const buffered = []; let threadId = null, invalid = false;
  return {
    onNotification(event) {
      const permission = permissionMethods.has(event?.method);
      if (!permission && event?.method !== 'mcpServer/startupStatus/updated') return;
      const p = event.params;
      if (permission) {
        if (!Object.hasOwn(event, 'id') || !p || typeof p.threadId !== 'string' || !uuid.test(p.threadId)) { invalid = true; return; }
        if (threadId && p.threadId !== threadId) return;
        if (buffered.length >= 4096) { invalid = true; return; }
        buffered.push({ threadId: p.threadId, permission: true });
        return;
      }
      if (!p || typeof p.threadId !== 'string' || !uuid.test(p.threadId) || !validName(p.name) || !statuses.has(p.status)) { invalid = true; return; }
      if (threadId && p.threadId !== threadId) return;
      if (buffered.length >= 4096) { invalid = true; return; }
      buffered.push({ threadId: p.threadId, name: p.name, status: p.status });
    },
    bindThread(id) {
      if (threadId !== null || typeof id !== 'string' || !uuid.test(id)) throw new Error('invalid startup thread binding');
      threadId = id;
    },
    snapshot() {
      if (!threadId) throw new Error('startup thread is not bound');
      const latest = new Map(); let permissionRequestObserved = null;
      for (const row of buffered) if (row.threadId === threadId) {
        if (row.permission) permissionRequestObserved = true;
        else latest.set(row.name, row.status);
      }
      const counts = { starting: 0, ready: 0, failed: 0, cancelled: 0 };
      for (const status of latest.values()) counts[status]++;
      return { schema: 'agent-mesh.codex-mcp-notification-sample.v1', requestedThreadId: threadId, counts,
        completeness: 'unverified', invalidOrOverflow: invalid, permissionRequestObserved, mcpStarted: null, startupTokens: null };
    }
  };
}
