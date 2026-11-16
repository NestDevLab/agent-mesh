import assert from 'node:assert/strict';
import test from 'node:test';
import { sampleCodexMcpConnections } from '../bin/codex-mcp-observation.mjs';

const input = { threadId: '22222222-2222-4222-8222-222222222222', generation: 1, profileSha256: 'a'.repeat(64) };
const connect = fn => async (_options, work) => work(fn);

test('pagination returns a partial connection sample with no names or claimed startup count', async () => {
  const requests = [];
  const result = await sampleCodexMcpConnections(input, connect(async (method, params) => {
    requests.push({ method, params });
    return params.cursor === null ? { data: [{ name: 'first', runtimeStatus: 'connected', httpOrigin: 'private-fixture' }], nextCursor: 'page-2' } : { data: [{ name: 'second', runtimeStatus: null }], nextCursor: null };
  }));
  assert.equal(requests.length, 2);
  assert.ok(requests.every(item => item.method === 'mcpServerStatus/list' && item.params.threadId === input.threadId));
  assert.equal(result.connectedObserved, 1);
  assert.equal(result.unavailableStatus, 1);
  assert.equal(result.mcpStarted, null);
  assert.equal(result.startupTokens, null);
  assert.equal(result.profileBinding, 'unverified');
  assert.equal(result.completeness, 'unverified-non-atomic');
  assert.ok(!JSON.stringify(result).includes('first'));
  assert.ok(!JSON.stringify(result).includes('private-fixture'));
});

test('cursor loops, duplicate identities, omitted pagination and invalid status fail closed', async () => {
  for (const page of [
    { data: [], nextCursor: 'again' },
    { data: [{ name: 'same', runtimeStatus: 'connected' }, { name: 'same', runtimeStatus: 'failed' }], nextCursor: null },
    { data: [] },
    { data: [{ name: 'one', runtimeStatus: 'invented' }], nextCursor: null }
  ]) await assert.rejects(sampleCodexMcpConnections(input, connect(async () => page)));
  await assert.rejects(sampleCodexMcpConnections({ ...input, threadId: 'invalid' }, connect(async () => { throw new Error('must not call'); })), /invalid/);
});

test('an empty response does not claim a zero startup count', async () => {
  const result = await sampleCodexMcpConnections(input, connect(async () => ({ data: [], nextCursor: null })));
  assert.equal(result.connectedObserved, 0);
  assert.equal(result.mcpStarted, null);
  assert.equal(result.completeness, 'unverified-non-atomic');
});

test('there is no default live app-server connection', async () => {
  await assert.rejects(sampleCodexMcpConnections(input), /invalid MCP sample request/);
});
