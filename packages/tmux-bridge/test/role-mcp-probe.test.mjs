import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('a cancelled probe terminates its temporary MCP process', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-cancel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const started = join(root, 'started'), late = join(root, 'late');
  const code = "import {writeFileSync} from 'node:fs'; writeFileSync(process.argv[1], 'ok'); setTimeout(() => writeFileSync(process.argv[2], 'late'), 500); setInterval(() => {}, 1000);";
  const controller = new AbortController();
  const probe = probeStdioMcp({ command: [process.execPath, '--input-type=module', '-e', code, started, late], timeoutMs: 2000, signal: controller.signal });
  let seen = false;
  for (let i = 0; i < 100 && !seen; i++) {
    try { await access(started); seen = true; } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  assert.equal(seen, true, 'fixture process started');
  controller.abort();
  assert.equal(await probe, false);
  await new Promise(resolve => setTimeout(resolve, 600));
  await assert.rejects(access(late));
});

test('planner aborts its trusted probe when its deadline expires', async () => {
  const profile = { schema: 'agent-mesh.role-profile.v1', role: 'fixture', permissions: [], mcp: ['slow'], plugins: [] };
  const authority = { role: 'fixture', permissions: [], humanGatedPermissions: [], mcp: ['slow'], plugins: [] };
  let aborted = false;
  const plan = await planRoleLaunch({ profile, authority, timeoutMs: 20, probe: (_name, { signal }) => new Promise(resolve => signal.addEventListener('abort', () => { aborted = true; resolve(false); }, { once: true })) });
  assert.equal(aborted, true);
  assert.deepEqual(plan.mcpUnavailable, ['slow']);
});
