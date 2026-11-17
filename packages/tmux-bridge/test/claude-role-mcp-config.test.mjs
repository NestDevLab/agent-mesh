import assert from 'node:assert/strict';
import test from 'node:test';
import { planClaudeMcpConfig } from '../bin/claude-role-mcp-config.mjs';

const launchPlan = { schema: 'agent-mesh.role-launch-plan.v1', mcpToStart: ['online'], mcpUnavailable: ['offline'] };
const inventory = { online: { command: 'fixture', args: ['one'] }, offline: { command: 'offline' }, other: { command: 'other' } };

test('candidate includes only available role MCP servers and requests strict mode', () => {
  const candidate = planClaudeMcpConfig({ launchPlan, inventory });
  assert.deepEqual(JSON.parse(JSON.stringify(candidate.config)), { mcpServers: { online: { command: 'fixture', args: ['one'] } } });
  assert.equal(candidate.strictMcpConfig, true);
  assert.equal(candidate.isolation, 'unverified');
  candidate.config.mcpServers.online.args.push('two');
  assert.deepEqual(inventory.online.args, ['one']);
});

test('empty role is strict and malformed or absent requested configurations fail closed', () => {
  assert.deepEqual(Object.keys(planClaudeMcpConfig({ launchPlan: { ...launchPlan, mcpToStart: [] }, inventory }).config.mcpServers), []);
  assert.throws(() => planClaudeMcpConfig({ launchPlan, inventory: {} }), /missing/);
  assert.throws(() => planClaudeMcpConfig({ launchPlan, inventory: { online: {} } }), /invalid/);
  assert.throws(() => planClaudeMcpConfig({ launchPlan: { ...launchPlan, mcpUnavailable: ['online'] }, inventory }), /invalid/);
});

test('role-authorized plugin MCP must be explicitly included in the inventory', () => {
  const plan = { ...launchPlan, mcpToStart: ['plugin:allowed'], mcpUnavailable: [] };
  assert.throws(() => planClaudeMcpConfig({ launchPlan: plan, inventory }), /missing/);
  const candidate = planClaudeMcpConfig({ launchPlan: plan, inventory: { 'plugin:allowed': { command: 'fixture-plugin' } } });
  assert.deepEqual(Object.keys(candidate.config.mcpServers), ['plugin:allowed']);
});
