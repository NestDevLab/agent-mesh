/** Probe one authorized stdio MCP in a verified PID namespace. */
import { spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

const configurationError = message => Object.assign(new Error(message), { code: 'MCP_PROBE_CONFIGURATION' });

// The launcher is not an authorization boundary: the command is still trusted
// and retains the caller's filesystem and network access. Verify that bubblewrap
// created a separate PID namespace with an owned init before accepting a probe.
function verifyNamespace(raw, child) {
  const info = JSON.parse(raw), pid = info?.['child-pid'], inode = info?.['pid-namespace'];
  if (!Number.isSafeInteger(pid) || pid < 2 || !Number.isSafeInteger(inode) || !child.pid) throw new Error('invalid namespace identity');
  const path = `/proc/${pid}`, proc = statSync(path), ns = statSync(`${path}/ns/pid`);
  const stat = readFileSync(`${path}/stat`, 'utf8').split(') ').at(-1).split(' ');
  const status = readFileSync(`${path}/status`, 'utf8');
  const nested = status.match(/^NSpid:\s*(.*)$/m)?.[1].trim().split(/\s+/);
  if (proc.uid !== process.getuid() || Number(stat[1]) !== child.pid || ns.ino !== inode || ns.ino === statSync('/proc/self/ns/pid').ino || nested?.at(-1) !== '1') throw new Error('namespace ownership unverified');
}

export function roleProbeFromAllowlist(allowlist, timeoutMs = 3000) {
  if (!allowlist || typeof allowlist !== 'object' || Array.isArray(allowlist)) throw configurationError('invalid MCP allowlist');
  return (name, { signal } = {}) => {
    if (typeof name !== 'string' || !Object.hasOwn(allowlist, name)) throw configurationError('MCP is not allowlisted');
    const entry = allowlist[name];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw configurationError('invalid MCP allowlist entry');
    return probeStdioMcp({ command: entry.command, env: entry.env, timeoutMs, signal });
  };
}

// The profile contains identifiers only. Callers must resolve them using a
// trusted private allowlist; never construct this command from session text.
export async function probeStdioMcp({ command, env = {}, timeoutMs = 3000, signal, spawnProcess = spawn }) {
  if (!Array.isArray(command) || command.length < 1 || command.length > 64 || !command.every(value => typeof value === 'string' && value.length > 0 && value.length < 8192 && !value.includes('\0')) || !isAbsolute(command[0]) || !env || typeof env !== 'object' || Array.isArray(env) || !Object.entries(env).every(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === 'string' && !value.includes('\0')) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000 || (signal !== undefined && !(signal instanceof AbortSignal))) throw configurationError('invalid MCP probe configuration');
  return new Promise((resolve, reject) => {
    let child, timer, reapTimer, buffer = '', info = '', phase = 'initialize', finished = false, closed = false, desired = false, resolved = false, namespaceVerified = false, protocolReady = false;
    let onAbort;
    const done = result => { if (!resolved) { resolved = true; clearTimeout(reapTimer); if (!namespaceVerified) reject(configurationError('MCP probe containment unverified')); else resolve(result); } };
    const finish = result => {
      if (finished) return;
      finished = true; desired = result; clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      if (!closed && child?.pid && child.exitCode == null && child.signalCode == null) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
      if (!child || closed) done(child ? desired : false);
      else reapTimer = setTimeout(() => { if (!resolved) { resolved = true; reject(new Error('probe cancellation unconfirmed')); } }, 1000);
    };
    if (signal?.aborted) { resolved = true; resolve(false); return; }
    try { child = spawnProcess('/usr/bin/bwrap', ['--info-fd', '3', '--block-fd', '4', '--die-with-parent', '--bind', '/', '/', '--proc', '/proc', '--dev-bind', '/dev', '/dev', '--unshare-pid', '--', ...command], { detached: true, shell: false, stdio: ['pipe', 'pipe', 'ignore', 'pipe', 'pipe'], env }); }
    catch { finish(false); return; }
    timer = setTimeout(() => finish(false), timeoutMs);
    onAbort = () => finish(false);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) { finish(false); return; }
    if (!child.stdio?.[3] || !child.stdio?.[4]) { finish(false); return; }
    child.stdio[4].on('error', () => { if (!namespaceVerified) finish(false); });
    child.stdio[3].setEncoding('utf8');
    child.stdio[3].on('data', data => { info += data; if (Buffer.byteLength(info) > 8192) finish(false); });
    child.stdio[3].on('end', () => {
      if (finished) return;
      try { verifyNamespace(info, child); namespaceVerified = true; child.stdio[4].end('GO'); if (protocolReady) finish(true); }
      catch { finish(false); }
    });
    child.once('error', () => finish(false));
    child.once('close', () => { closed = true; if (!finished) finish(false); else done(desired); });
    child.stdin.on('error', () => finish(false));
    child.stdout.setEncoding('utf8');
    const write = message => child.stdin.write(`${JSON.stringify(message)}\n`);
    child.stdout.on('data', data => {
      if (finished) return;
      buffer += data;
      if (Buffer.byteLength(buffer) > 1024 * 1024) return finish(false);
      let index;
      while (!finished && (index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        let reply; try { reply = JSON.parse(line); } catch { return finish(false); }
        if (reply?.jsonrpc !== '2.0') return finish(false);
        if (phase === 'initialize' && reply.id === 1) {
          if (reply.error || !reply.result || reply.result.protocolVersion !== '2024-11-05' || !reply.result.capabilities || typeof reply.result.capabilities !== 'object' || Array.isArray(reply.result.capabilities) || typeof reply.result.serverInfo?.name !== 'string' || !reply.result.serverInfo.name || typeof reply.result.serverInfo.version !== 'string' || !reply.result.serverInfo.version) return finish(false);
          phase = 'ping';
          write({ jsonrpc: '2.0', method: 'notifications/initialized' });
          write({ jsonrpc: '2.0', id: 2, method: 'ping', params: {} });
        } else if (phase === 'ping' && reply.id === 2) {
          if (reply.error || !reply.result || typeof reply.result !== 'object' || Array.isArray(reply.result)) finish(false);
          else { protocolReady = true; if (namespaceVerified) finish(true); }
        } else if (reply.id !== undefined) return finish(false);
      }
    });
    write({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'role-profile-probe', version: '1' } } });
  });
}
