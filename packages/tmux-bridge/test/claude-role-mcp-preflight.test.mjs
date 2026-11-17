import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareClaudeRoleMcp } from '../bin/claude-role-mcp-preflight.mjs';

const server = `let b='';process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const x=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(x.method==='initialize')console.log(JSON.stringify({jsonrpc:'2.0',id:1,result:{protocolVersion:'2024-11-05',capabilities:{},serverInfo:{name:'fixture',version:'1'}}}));if(x.method==='ping')console.log(JSON.stringify({jsonrpc:'2.0',id:2,result:{}}));}});`;
const profile = { schema: 'agent-mesh.role-profile.v1', role: 'fixture', permissions: [], mcp: ['online', 'offline'], plugins: [] };
const authority = { role: 'fixture', permissions: [], humanGatedPermissions: [], mcp: ['online', 'offline'], plugins: [] };

test('one inventory snapshot supplies both the probe and strict Claude candidate', async () => {
  const inventory = { online: { command: process.execPath, args: ['-e', server], env: { FIXTURE: 'ok' } }, offline: { command: '/bin/false' }, extra: { command: '/bin/false' } };
  const pending = prepareClaudeRoleMcp({ profile, authority, inventory });
  inventory.online.command = '/bin/false';
  const result = await pending;
  assert.deepEqual(result.plan.mcpToStart, ['online']);
  assert.deepEqual(result.plan.mcpUnavailable, ['offline']);
  assert.deepEqual(Object.keys(result.candidate.config.mcpServers), ['online']);
  assert.equal(result.candidate.config.mcpServers.online.command, process.execPath);
});

test('unknown, relative, unresolved and non-stdio inventory fails before launch', async () => {
  for (const value of [undefined, { command: 'relative' }, { command: '/bin/true', args: ['${CLAUDE_PLUGIN_ROOT}/x'] }, { type: 'http', command: '/bin/true' }, { command: '/bin/true', cwd: '/tmp' }]) {
    await assert.rejects(prepareClaudeRoleMcp({ profile: { ...profile, mcp: ['online'] }, authority, inventory: { online: value } }), /invalid private Claude MCP inventory/);
  }
});
