/** Verify an actor's correlated response against a private state file. */
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRestartState } from './restart-state.mjs';

const nativeBin = join(dirname(fileURLToPath(import.meta.url)), 'agent-native-call.mjs');
const yamlBin = join(dirname(fileURLToPath(import.meta.url)), 'restart-yaml.py');
const exec = (command, args, { input, ...options }) => new Promise((resolve, reject) => {
  const child = execFile(command, args, options, (error, stdout) => {
    if (error) reject(new Error('native state request failed'));
    else resolve({ stdout });
  });
  child.stdin.on('error', () => {});
  child.stdin.end(input);
});

// reserve and complete are atomic host mutations; a failed request deliberately
// leaves the reservation unresolved so a caller cannot silently resend it.
export async function prepareState({ reserve, request, complete }) {
  const reservation = reserve();
  const pending = reservation?.statePreparation;
  if (!pending || pending.status !== 'requested' || typeof pending.session !== 'string' || typeof pending.id !== 'string') throw new Error('state preparation reservation unavailable');
  const proof = await request(pending);
  return complete(proof);
}

/** Obtain a correlated native-session result, then bind it to file bytes. */
export async function requestStateProof({ session, channel, root, filename, managedInboxRoot, nonce = `handover-${randomUUID()}` }, runNative = exec) {
  if (!/^(codex|claude):[0-9a-f-]{36}$/.test(session) || !isAbsolute(root) || /[\r\n\x00]/.test(root) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(filename)) throw new Error('invalid state proof request');
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || rootInfo.uid !== process.getuid() || (rootInfo.mode & 0o077) !== 0 || await realpath(root) !== root) throw new Error('state root must be private and canonical');
  const [agent, nativeId] = session.split(':');
  if (agent === 'claude' && (typeof managedInboxRoot !== 'string' || !isAbsolute(managedInboxRoot))) throw new Error('managed inbox required');
  if (typeof nonce !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/.test(nonce)) throw new Error('invalid request nonce');
  if (typeof channel !== 'string' || !/^#?[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(channel)) throw new Error('invalid state proof channel');
  const message = `Write your handover state with a RIAVVIO YAML block using agent-mesh.restart.v1 to ${join(root, filename)} with private permissions. Bind the block to session ${session} and channel ${channel}, and include harness, working_directory, skills, triggers, goal and role_profile with schema agent-mesh.role-profile.v1, role and exact identifier lists permissions, mcp, plugins. List only existing grants; do not grant anything. Return only JSON with schema agent-mesh.handover-state.v1, session ${session}, nonce ${nonce}, filename ${filename}, and sha256 containing the lowercase SHA-256 of the completed file.`;
  const argv = [nativeBin, '--agent', agent, '--session', nativeId, '--correlation-id', nonce, '--timeout', '120', '--message-stdin'];
  if (agent === 'codex') argv.push('--no-resume');
  if (agent === 'claude') argv.push('--managed-inbox-root', managedInboxRoot);
  const result = await runNative(process.execPath, argv, { input: message, timeout: 125000, maxBuffer: 8192 });
  if (!result || typeof result.stdout !== 'string') throw new Error('native result unavailable');
  return verifyStateResponse({ session, channel, nonce, response: result.stdout, root, filename });
}

// The caller must obtain response from the native correlated-result transport,
// bound to session and nonce. This function cannot authenticate arbitrary text.
export async function verifyStateResponse({ session, channel, nonce, response, root, filename }) {
  if (!/^(codex|claude):[0-9a-f-]{36}$/.test(session) || !/^[a-zA-Z0-9._:-]{1,128}$/.test(nonce) || !isAbsolute(root) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(filename)) throw new Error('invalid state proof request');
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || rootInfo.uid !== process.getuid() || (rootInfo.mode & 0o077) !== 0 || await realpath(root) !== root) throw new Error('state root must be private and canonical');
  if (typeof response !== 'string' || Buffer.byteLength(response) > 8192) throw new Error('invalid state response');
  let attestation;
  try { attestation = JSON.parse(response); } catch { throw new Error('invalid state response'); }
  if (!attestation || attestation.schema !== 'agent-mesh.handover-state.v1' || attestation.session !== session || attestation.nonce !== nonce || attestation.filename !== filename || !/^[0-9a-f]{64}$/.test(attestation.sha256)) throw new Error('state response binding mismatch');
  const file = await open(join(root, filename), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.uid !== process.getuid() || before.nlink !== 1 || (before.mode & 0o077) !== 0 || before.size < 1 || before.size > 1024 * 1024) throw new Error('invalid state file');
    const bytes = await file.readFile();
    const after = await file.stat();
    if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('state file changed during verification');
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== attestation.sha256) throw new Error('state file digest mismatch');
    if (typeof channel !== 'string' || !/^#?[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(channel)) throw new Error('invalid state proof channel');
    const decoded = spawnSync(process.env.PYTHON || 'python3', ['-I', yamlBin], { input: bytes, encoding: 'utf8', timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
    if (decoded.error || decoded.status !== 0) throw new Error('restart YAML unavailable or invalid');
    let restart;
    try { restart = JSON.parse(decoded.stdout); } catch { throw new Error('invalid restart YAML result'); }
    validateRestartState(restart, { session, channel, requireRoleProfile: true });
    return { schema: attestation.schema, session, nonce, filename, sha256: digest, bytes: bytes.length };
  } finally { await file.close(); }
}
