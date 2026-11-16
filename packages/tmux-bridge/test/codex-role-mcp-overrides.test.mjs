import assert from 'node:assert/strict';
import test from 'node:test';
import { planCodexMcpOverrides } from '../bin/codex-role-mcp-overrides.mjs';

const launchPlan = { schema: 'agent-mesh.role-launch-plan.v1', mcpToStart: ['allowed'], mcpUnavailable: ['offline'] };
const inventory = { allowed: { enabled: true }, offline: { enabled: true }, extra: { command: 'private-fixture' } };

test('explicitly disables each excluded effective server without copying its config', () => {
  const result = planCodexMcpOverrides({ launchPlan, effectiveServers: inventory });
  assert.deepEqual(JSON.parse(JSON.stringify(result.config)), { mcp_servers: { extra: { enabled: false }, offline: { enabled: false } } });
  assert.equal(result.excludedCount, 2);
  assert.equal(result.isolation, 'unverified');
  assert.ok(!JSON.stringify(result).includes('private-fixture'));
});

test('missing, disabled, malformed and overlapping inputs fail closed', () => {
  assert.throws(() => planCodexMcpOverrides({ launchPlan, effectiveServers: { other: {} } }), /missing/);
  assert.throws(() => planCodexMcpOverrides({ launchPlan, effectiveServers: { allowed: { enabled: false } } }), /disabled/);
  assert.throws(() => planCodexMcpOverrides({ launchPlan, effectiveServers: { allowed: { enabled: 'yes' } } }), /invalid/);
  assert.throws(() => planCodexMcpOverrides({ launchPlan: { ...launchPlan, mcpUnavailable: ['allowed'] }, effectiveServers: inventory }), /invalid/);
});

test('an empty allowed role disables every server in the supplied inventory', () => {
  const result = planCodexMcpOverrides({ launchPlan: { ...launchPlan, mcpToStart: [] }, effectiveServers: inventory });
  assert.equal(result.excludedCount, 3);
  assert.ok(Object.values(result.config.mcp_servers).every(item => item.enabled === false));
});
