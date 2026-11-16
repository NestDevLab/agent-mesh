/** Bounded, opt-in app-server sample. It does not start or resume a thread. */

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const statuses = new Set(['notStarted', 'starting', 'connected', 'authenticationRequired', 'failed', 'cancelled', 'disabled']);
const validName = name => typeof name === 'string' && name.length > 0 && name.length <= 512 && !/[\x00-\x1f\x7f]/.test(name);

/**
 * Do not treat this as launch or process evidence. Pagination is not an atomic
 * snapshot, and the provider does not echo the requested thread in a response.
 * A real provider call can restart an MCP; connect only to an isolated fixture.
 */
export async function sampleCodexMcpConnections({ threadId, generation, profileSha256 }, connect) {
  if (typeof threadId !== 'string' || !uuid.test(threadId) || !Number.isSafeInteger(generation) || generation < 1 || typeof profileSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(profileSha256) || typeof connect !== 'function') throw new Error('invalid MCP sample request');
  return connect({ clientName: 'agent-mesh-mcp-sample', timeout: 30000, timeoutMessage: 'MCP sample timed out' }, async request => {
    const startedAt = new Date().toISOString(), cursors = new Set(), names = new Set();
    let cursor = null, pages = 0, connected = 0, unavailable = 0;
    for (;;) {
      if (++pages > 32) throw new Error('MCP pagination limit exceeded');
      const result = await request('mcpServerStatus/list', { threadId, cursor, limit: 100, detail: 'toolsAndAuthOnly' });
      if (!result || !Array.isArray(result.data) || !Object.hasOwn(result, 'nextCursor') || !(result.nextCursor === null || (typeof result.nextCursor === 'string' && result.nextCursor.length > 0 && result.nextCursor.length <= 4096))) throw new Error('invalid MCP page');
      for (const item of result.data) {
        if (!item || !validName(item.name) || names.has(item.name)) throw new Error('invalid or duplicate MCP identity');
        names.add(item.name);
        if (names.size > 4096) throw new Error('MCP sample limit exceeded');
        const status = item.runtimeStatus ?? null;
        if (status !== null && !statuses.has(status)) throw new Error('invalid MCP runtime status');
        if (status === 'connected') connected++;
        if (status === null) unavailable++;
      }
      if (result.nextCursor === null) break;
      if (cursors.has(result.nextCursor)) throw new Error('MCP cursor loop');
      cursors.add(result.nextCursor); cursor = result.nextCursor;
    }
    return { schema: 'agent-mesh.codex-mcp-sample.v1', requestedThreadId: threadId, claimedGeneration: generation,
      claimedProfileSha256: profileSha256, profileBinding: 'unverified', startedAt, endedAt: new Date().toISOString(), pages,
      serversReturned: names.size, connectedObserved: connected, unavailableStatus: unavailable,
      completeness: 'unverified-non-atomic', mcpStarted: null, startupTokens: null };
  });
}
