/** Serialized local transport admission, shared by native session sends. */
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

export async function commsLease(spec) {
  if (process.env.MESH_COMMS_REPLAY_FD) {
    const fd = Number(process.env.MESH_COMMS_REPLAY_FD);
    if (!Number.isInteger(fd) || fd < 3 || fd > 256) throw new Error('invalid replay descriptor');
    const stdio = ['pipe', 'pipe', 'pipe'];
    while (stdio.length <= fd) stdio.push('ignore');
    stdio[fd] = fd;
    const checked = spawnSync('python3', [join(dirname(fileURLToPath(import.meta.url)), 'mesh-comms.py'), 'verify'],
      { env: process.env, stdio, encoding: 'utf8', input: JSON.stringify(spec)+'\n' });
    if (checked.status !== 0) throw new Error(checked.stderr || 'invalid replay capability');
    const receipt = JSON.parse(checked.stdout);
    if (!receipt || receipt.status !== 'send') throw new Error('replay not authorized');
    return { ...receipt, complete: async (accepted, rejected = false) => {
      const done = spawnSync('python3', [join(dirname(fileURLToPath(import.meta.url)), 'mesh-comms.py'), 'complete',
        '--request', JSON.stringify({ ...receipt, accepted, rejected })], { encoding: 'utf8', env: process.env });
      if (done.status !== 0) throw new Error(done.stderr || 'replay completion failed');
    }};
  }
  const child = spawn('python3', [join(dirname(fileURLToPath(import.meta.url)), 'mesh-comms.py'), 'lease'], {
    stdio: ['pipe', 'pipe', 'pipe'], env: process.env
  });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  child.stdin.on('error', () => {});
  child.stdin.write(JSON.stringify(spec)+'\n');
  const lines = createInterface({ input: child.stdout });
  let receipt;
  for await (const line of lines) { receipt = JSON.parse(line); break; }
  if (!receipt) { await closed; throw new Error(errors || 'comms gate failed'); }
  return { ...receipt, complete: async (accepted, rejected = false) => {
    child.stdin.end(JSON.stringify({ accepted, rejected }) + '\n');
    const code = await closed;
    if (code !== 0) throw new Error(errors || 'comms acknowledgement failed');
  }};
}
