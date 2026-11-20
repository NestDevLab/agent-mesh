/** Bind an operator-selected Claude CLI profile to an account scope. */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const SCOPE = /^[a-z][a-z0-9-]{0,63}$/;

export async function loadClaudeAccountProfile(path, scope, expectedDigest) {
  if (typeof path !== 'string' || !isAbsolute(path) || !SCOPE.test(scope || '') || (expectedDigest !== undefined && !/^[0-9a-f]{64}$/.test(expectedDigest))) throw new Error('invalid cloud profile reference');
  const parent = dirname(path), dir = await lstat(parent);
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid() || (dir.mode & 0o077) !== 0 || await realpath(parent) !== parent) throw new Error('cloud profile directory not private');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    const before = await file.stat();
    if (!before.isFile() || before.uid !== process.getuid() || before.nlink !== 1 || (before.mode & 0o077) !== 0 || before.size < 1 || before.size > 8192) throw new Error('invalid cloud profile file');
    bytes = await file.readFile();
    const after = await file.stat(), current = await lstat(path);
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== after.dev || current.ino !== after.ino || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('cloud profile changed');
  } finally { await file.close(); }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (expectedDigest !== undefined && digest !== expectedDigest) throw new Error('cloud profile changed');
  let profile; try { profile = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('invalid cloud profile'); }
  if (!profile || Object.keys(profile).sort().join(',') !== 'command,configDir,expectedSubjectHash,schema,scope' || profile.schema !== 'agent-mesh.cloud-account.v1' || profile.scope !== scope) throw new Error('cloud profile scope mismatch');
  return { profile, digest };
}

// Only a digest is returned. Raw identity and credentials are never returned
// or copied to a receipt; the operator must protect the configured profile.
export function claudeSubjectHash(status) {
  if (!status || status.loggedIn !== true || status.apiProvider !== 'firstParty' || status.authMethod !== 'claude.ai' || status.storedClaudeAiLogin !== true || typeof status.email !== 'string' || !status.email.trim() || typeof status.orgId !== 'string' || !status.orgId.trim()) throw new Error('Claude account identity unavailable');
  return createHash('sha256').update(JSON.stringify([status.email.trim().toLowerCase(), status.orgId.trim()])).digest('hex');
}

export async function verifyClaudeAccount(profile, run = execute) {
  if (!profile || typeof profile.scope !== 'string' || !SCOPE.test(profile.scope) || typeof profile.expectedSubjectHash !== 'string' || !/^[0-9a-f]{64}$/.test(profile.expectedSubjectHash) || typeof profile.configDir !== 'string' || !isAbsolute(profile.configDir) || typeof profile.command !== 'string' || !isAbsolute(profile.command)) throw new Error('invalid cloud account profile');
  const info = await lstat(profile.configDir);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0 || await realpath(profile.configDir) !== profile.configDir) throw new Error('cloud profile must be private and canonical');
  let output;
  try { output = await run(profile.command, ['auth', 'status', '--json'], { env: { ...process.env, CLAUDE_CONFIG_DIR: profile.configDir }, timeout: 10000, maxBuffer: 8192 }); }
  catch { throw new Error('Claude account check unavailable'); }
  let status;
  try { status = JSON.parse(output.stdout); } catch { throw new Error('invalid Claude account response'); }
  if (status.configDirectory !== profile.configDir || claudeSubjectHash(status) !== profile.expectedSubjectHash) throw new Error('Claude account scope mismatch');
  return { scope: profile.scope, subjectHash: profile.expectedSubjectHash };
}

// Check the same profile before and after an operation. A changed or unreadable
// profile after invocation leaves its result uncertain; callers must not resend.
export async function withClaudeAccount(profile, action, run = execute) {
  const binding = await verifyClaudeAccount(profile, run);
  let result;
  try { result = await action({ scope: binding.scope, configDir: profile.configDir, command: profile.command }); }
  catch { throw new Error('cloud operation outcome uncertain'); }
  try { await verifyClaudeAccount(profile, run); }
  catch { throw new Error('cloud operation outcome uncertain'); }
  return result;
}
