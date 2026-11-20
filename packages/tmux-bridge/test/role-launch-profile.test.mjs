import assert from 'node:assert/strict';
import test from 'node:test';
import { validateRestartState } from '../bin/restart-state.mjs';
import { planRoleLaunch, assessRoleLaunch } from '../bin/role-launch-profile.mjs';

const profile = { schema: 'agent-mesh.role-profile.v1', role: 'operator', permissions: ['read'], mcp: ['alpha', 'beta'], plugins: ['example'] };
const authority = { role: 'operator', permissions: ['read', 'publish'], humanGatedPermissions: ['publish'], mcp: ['alpha', 'beta'], plugins: ['example'] };

test('restart role profile is explicit, bounded and never creates grants', () => {
  const state = { schema: 'agent-mesh.restart.v1', session: 'codex:example', channel: '#example', harness: 'codex', working_directory: '/workspace', skills: [], triggers: [], goal: null };
  assert.throws(() => validateRestartState(state, { requireRoleProfile: true }), /profile/);
  assert.equal(validateRestartState({ ...state, role_profile: profile }, { requireRoleProfile: true }), true);
  assert.throws(() => validateRestartState({ ...state, role_profile: { ...profile, permissions: ['read', 'read'] } }), /permissions/);
  assert.throws(() => validateRestartState({ ...state, role_profile: { ...profile, mcp: ['*'] } }), /mcp/);
});

test('unreachable MCP is excluded while unexpected permission requires rollback', async () => {
  const seen = [];
  const plan = await planRoleLaunch({ profile, authority, probe: async name => { seen.push(name); if (name === 'beta') throw new Error('offline'); return true; }, timeoutMs: 50 });
  assert.deepEqual(seen, ['alpha', 'beta']);
  assert.deepEqual(plan.mcpToStart, ['alpha']);
  assert.deepEqual(plan.mcpUnavailable, ['beta']);
  const observed = { mcpStarted: ['alpha'], pluginsStarted: ['example'], permissionPrompt: false, startupTokens: null };
  const receipt = assessRoleLaunch({ plan, observed });
  assert.equal(receipt.status, 'ready');
  assert.equal(receipt.mcpStarted, 1);
  assert.deepEqual(receipt.mcpUnavailable, ['beta']);
  assert.equal(receipt.startupTokens, null);
  assert.equal(assessRoleLaunch({ plan, observed: { ...observed, permissionPrompt: true } }).status, 'rollback-required');
  assert.equal(assessRoleLaunch({ plan, observed: { ...observed, mcpStarted: ['alpha', 'other'] } }).status, 'rollback-required');
  await assert.rejects(planRoleLaunch({ profile: { ...profile, permissions: ['publish'] }, authority, probe: async () => true }), /human-gated/);
  await assert.rejects(planRoleLaunch({ profile: { ...profile, mcp: ['other'] }, authority, probe: async () => true }), /exceeds/);
});
