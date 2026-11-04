/** Serialized local transport admission, shared by native session sends. */
import { spawn } from 'node:child_process';
import { fstatSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

export async function commsLease(spec) {
  if (process.env.MESH_COMMS_REPLAY_FD) {
    const root = process.env.MESH_COMMS_STATE || join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'agent-mesh/comms');
    const actual = fstatSync(Number(process.env.MESH_COMMS_REPLAY_FD));
    const expected = statSync(join(root, 'delivery.lock'));
    if (actual.dev !== expected.dev || actual.ino !== expected.ino) throw new Error('invalid comms replay descriptor');
    return { status: 'send', id: process.env.MESH_COMMS_PERMIT, complete: async () => {} };
  }
  const child = spawn('python3', [join(dirname(fileURLToPath(import.meta.url)), 'mesh-comms.py'), 'lease', '--request', JSON.stringify(spec)], {
    stdio: ['pipe', 'pipe', 'pipe'], env: process.env
  });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  child.stdin.on('error', () => {});
  const lines = createInterface({ input: child.stdout });
  let receipt;
  for await (const line of lines) { receipt = JSON.parse(line); break; }
  if (!receipt) { await closed; throw new Error(errors || 'comms gate failed'); }
  return { ...receipt, complete: async accepted => {
    child.stdin.end(JSON.stringify({ accepted }) + '\n');
    const code = await closed;
    if (code !== 0) throw new Error(errors || 'comms acknowledgement failed');
  }};
}
