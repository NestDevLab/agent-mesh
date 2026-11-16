import assert from 'node:assert/strict';
import test from 'node:test';
import { probeStdioMcp, roleProbeFromAllowlist } from '../bin/role-mcp-probe.mjs';
import { planRoleLaunch } from '../bin/role-launch-profile.mjs';

const fixture = `let buffer = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', data => { buffer += data; let index; while ((index = buffer.indexOf('\\n')) >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); const request = JSON.parse(line); if (request.method === 'initialize') console.log(JSON.stringify({jsonrpc:'2.0',id:1,result:{protocolVersion:'2024-11-05',capabilities:{},serverInfo:{name:'fixture',version:'1'}}})); if (request.method === 'ping') console.log(JSON.stringify({jsonrpc:'2.0',id:2,result:{}})); } });`;

test('only an initialized and responsive MCP is accepted by role planning', async () => {
  const good = { command: [process.execPath, '--input-type=module', '-e', fixture], timeoutMs: 2000 };
  const offline = { command: [process.execPath, '--input-type=module', '-e', 'setInterval(() => {}, 1000)'], timeoutMs: 150 };
  assert.equal(await probeStdioMcp(good), true);
  assert.equal(await probeStdioMcp(offline), false);
  const profile = { schema: 'agent-mesh.role-profile.v1', role: 'fixture', permissions: [], mcp: ['good', 'offline'], plugins: [] };
  const authority = { role: 'fixture', permissions: [], humanGatedPermissions: [], mcp: ['good', 'offline'], plugins: [] };
  const allowlist = { good, offline };
  const probe = roleProbeFromAllowlist(allowlist, 1000);
  const plan = await planRoleLaunch({ profile, authority, probe, timeoutMs: 3000 });
  assert.deepEqual(plan.mcpToStart, ['good']);
  assert.deepEqual(plan.mcpUnavailable, ['offline']);
  assert.throws(() => probe('unlisted'), /allowlisted/);
  await assert.rejects(probeStdioMcp({ command: ['relative-program'] }), /configuration/);
});
