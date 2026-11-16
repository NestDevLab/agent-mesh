/** Verify an actor's correlated response against a private state file. */
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';

// The caller must obtain response from the native correlated-result transport,
// bound to session and nonce. This function cannot authenticate arbitrary text.
export async function verifyStateResponse({ session, nonce, response, root, filename }) {
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
    return { schema: attestation.schema, session, nonce, filename, sha256: digest, bytes: bytes.length };
  } finally { await file.close(); }
}
