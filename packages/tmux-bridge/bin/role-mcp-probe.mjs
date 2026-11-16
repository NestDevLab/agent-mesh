/** Probe one operator-authorized stdio MCP in its own process group. */
import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';

export function roleProbeFromAllowlist(allowlist, timeoutMs = 3000) {
  if (!allowlist || typeof allowlist !== 'object' || Array.isArray(allowlist)) throw new Error('invalid MCP allowlist');
  return (name, { signal } = {}) => {
    if (typeof name !== 'string' || !Object.hasOwn(allowlist, name)) throw new Error('MCP is not allowlisted');
    const entry = allowlist[name];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('invalid MCP allowlist entry');
    return probeStdioMcp({ command: entry.command, env: entry.env, timeoutMs, signal });
  };
}

// The profile contains identifiers only. Callers must resolve them using a
// trusted private allowlist; never construct this command from session text.
export async function probeStdioMcp({ command, env = {}, timeoutMs = 3000, signal, spawnProcess = spawn }) {
  if (!Array.isArray(command) || command.length < 1 || command.length > 64 || !command.every(value => typeof value === 'string' && value.length > 0 && value.length < 8192 && !value.includes('\0')) || !isAbsolute(command[0]) || !env || typeof env !== 'object' || Array.isArray(env) || !Object.entries(env).every(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === 'string' && !value.includes('\0')) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000 || (signal !== undefined && !(signal instanceof AbortSignal))) throw new Error('invalid MCP probe configuration');
  return new Promise((resolve, reject) => {
    let child, timer, reapTimer, buffer = '', phase = 'initialize', finished = false, closed = false, desired = false, resolved = false;
    let onAbort;
    const done = result => { if (!resolved) { resolved = true; clearTimeout(reapTimer); resolve(result); } };
    const finish = result => {
      if (finished) return;
      finished = true; desired = result; clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
      if (!child || closed) done(child ? desired : false);
      else reapTimer = setTimeout(() => { if (!resolved) { resolved = true; reject(new Error('probe cancellation unconfirmed')); } }, 1000);
    };
    if (signal?.aborted) { finish(false); return; }
    try { child = spawnProcess(command[0], command.slice(1), { detached: true, shell: false, stdio: ['pipe', 'pipe', 'ignore'], env }); }
    catch { finish(false); return; }
    timer = setTimeout(() => finish(false), timeoutMs);
    onAbort = () => finish(false);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) { finish(false); return; }
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
          finish(!reply.error && !!reply.result && typeof reply.result === 'object' && !Array.isArray(reply.result));
        } else if (reply.id !== undefined) return finish(false);
      }
    });
    write({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'role-profile-probe', version: '1' } } });
  });
}
