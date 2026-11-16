import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, access, rm, writeFile } from 'node:fs/promises';
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
  assert.equal(await probeStdioMcp({ command: ['/bin/false'], timeoutMs: 2000 }), false);
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
  const code = "import {writeFileSync} from 'node:fs'; writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => writeFileSync(process.argv[2], 'late'), 500); setInterval(() => {}, 1000);";
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

test('planner refuses to continue if cancellation is not acknowledged', async () => {
  const profile = { schema: 'agent-mesh.role-profile.v1', role: 'fixture', permissions: [], mcp: ['slow'], plugins: [] };
  const authority = { role: 'fixture', permissions: [], humanGatedPermissions: [], mcp: ['slow'], plugins: [] };
  await assert.rejects(planRoleLaunch({ profile, authority, timeoutMs: 5, probe: () => new Promise(() => {}) }), /cancellation unconfirmed/);
});

test('unobserved process closure fails planning instead of treating MCP as offline', async () => {
  const { EventEmitter } = await import('node:events');
  const child = new EventEmitter();
  child.stdin = new EventEmitter(); child.stdin.write = () => true;
  child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
  child.stdio = [child.stdin, child.stdout, null, new EventEmitter(), new EventEmitter()]; child.stdio[3].setEncoding = () => {}; child.stdio[4].end = () => {};
  const profile = { schema: 'agent-mesh.role-profile.v1', role: 'fixture', permissions: [], mcp: ['stuck'], plugins: [] };
  const authority = { role: 'fixture', permissions: [], humanGatedPermissions: [], mcp: ['stuck'], plugins: [] };
  const probe = (_name, { signal }) => probeStdioMcp({ command: [process.execPath], timeoutMs: 5, signal, spawnProcess: () => child });
  await assert.rejects(planRoleLaunch({ profile, authority, probe, timeoutMs: 1400 }), /probe cancellation unconfirmed/);
});

test('missing or invalid private MCP configuration stops planning', async () => {
  const profile = { schema: 'agent-mesh.role-profile.v1', role: 'fixture', permissions: [], mcp: ['wanted'], plugins: [] };
  const authority = { role: 'fixture', permissions: [], humanGatedPermissions: [], mcp: ['wanted'], plugins: [] };
  await assert.rejects(planRoleLaunch({ profile, authority, probe: roleProbeFromAllowlist({}) }), /not allowlisted/);
  await assert.rejects(planRoleLaunch({ profile, authority, probe: roleProbeFromAllowlist({ wanted: { command: ['relative-program'] } }) }), /invalid MCP probe configuration/);
});

test('the contained probe stops a detached descendant before returning', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-contained-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const late = join(root, 'late'), started = join(root, 'started');
  const childCode = `require('node:fs').writeFileSync(process.argv[1], 'started'); setTimeout(() => require('node:fs').writeFileSync(process.argv[2], 'late'), 600); setInterval(() => {}, 1000)`;
  const server = `const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e',${JSON.stringify(childCode)},${JSON.stringify(started)},${JSON.stringify(late)}],{detached:true,stdio:'ignore'});c.unref(); let b='';process.stdin.on('data',d=>{b+=d;let n;while((n=b.indexOf('\\n'))>=0){const x=JSON.parse(b.slice(0,n));b=b.slice(n+1);if(x.method==='initialize')console.log(JSON.stringify({jsonrpc:'2.0',id:1,result:{protocolVersion:'2024-11-05',capabilities:{},serverInfo:{name:'fixture',version:'1'}}}));if(x.method==='ping'){const timer=setInterval(()=>{if(require('node:fs').existsSync(${JSON.stringify(started)})){clearInterval(timer);console.log(JSON.stringify({jsonrpc:'2.0',id:2,result:{}}));}},10);}}});`;
  assert.equal(await probeStdioMcp({ command: [process.execPath, '-e', server], timeoutMs: 2000 }), true);
  await access(started);
  await new Promise(resolve => setTimeout(resolve, 900));
  await assert.rejects(access(late));
});

test('unavailable namespace containment stops planning before command release', async () => {
  const { EventEmitter } = await import('node:events');
  const child = new EventEmitter();
  child.stdin = new EventEmitter(); child.stdin.write = () => true;
  child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
  const info = new EventEmitter(); info.setEncoding = () => {};
  const gate = new EventEmitter(); let released = false; gate.end = () => { released = true; };
  child.stdio = [child.stdin, child.stdout, null, info, gate];
  const result = probeStdioMcp({ command: [process.execPath], timeoutMs: 1000, spawnProcess: () => child });
  queueMicrotask(() => { info.emit('data', '{}'); info.emit('end'); child.emit('close'); });
  await assert.rejects(result, error => error.code === 'MCP_PROBE_CONFIGURATION');
  assert.equal(released, false);
});

test('the execution gate rejects EOF, partial and invalid permits', async t => {
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const root = await mkdtemp(join(tmpdir(), 'mcp-gate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const gate = fileURLToPath(new URL('../bin/role-mcp-exec-gate.py', import.meta.url));
  const execute = (input, marker) => new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/python3', ['-B', gate, '--', '/usr/bin/touch', marker], { stdio: ['pipe', 'pipe', 'ignore'] });
    let output = ''; child.stdout.on('data', chunk => { output += chunk; });
    child.on('error', reject); child.on('close', code => resolve({ code, output }));
    child.stdin.end(input);
  });
  for (const input of ['', 'G', 'NO\n']) {
    const marker = join(root, `no-${input.length}`);
    const result = await execute(input, marker);
    assert.equal(result.code, 125); assert.equal(result.output, '');
    await assert.rejects(access(marker));
  }
  const marker = join(root, 'yes');
  const result = await execute('GO\n', marker);
  assert.equal(result.code, 0); assert.equal(result.output, '{"agentMeshMcpGate":"released"}\n');
  await access(marker);
});

test('an already cancelled probe never starts a process', async () => {
  const controller = new AbortController(); controller.abort();
  let spawned = false;
  const result = await probeStdioMcp({ command: [process.execPath], signal: controller.signal, spawnProcess: () => { spawned = true; } });
  assert.equal(result, false); assert.equal(spawned, false);
});


test('missing gate acknowledgement is a configuration error, not an offline MCP', async t => {
  const { spawn } = await import('node:child_process');
  const root = await mkdtemp(join(tmpdir(), 'mcp-no-ack-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fakeGate = join(root, 'no-ack.py'), marker = join(root, 'target-started');
  await writeFile(fakeGate, 'import os\nos.read(0, 3)\n');
  const spawnWithoutAcknowledgement = (command, args, options) => {
    const modified = [...args], index = modified.findIndex(value => value.endsWith('/role-mcp-exec-gate.py'));
    assert.notEqual(index, -1); modified[index] = fakeGate;
    return spawn(command, modified, options);
  };
  await assert.rejects(probeStdioMcp({ command: ['/usr/bin/touch', marker], timeoutMs: 2000, spawnProcess: spawnWithoutAcknowledgement }), error => error.code === 'MCP_PROBE_CONFIGURATION');
  await assert.rejects(access(marker));
});
