/** Validate and decode the exact bytes of a Linux sealed restart descriptor. */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRestartState, roleProfileDigest } from './restart-state.mjs';

const validator = join(dirname(fileURLToPath(import.meta.url)), 'sealed-restart-validate.py');

// The caller authenticates the receipt and is responsible for passing this same
// descriptor to the launcher. The parsed profile remains private to the caller.
export function validateSealedRestart({ fd, session, channel, expectedSha256 }) {
  if (!Number.isSafeInteger(fd) || fd < 3 || typeof session !== 'string' || !session || typeof channel !== 'string' || !channel || typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error('invalid sealed restart request');
  const result = spawnSync(process.env.PYTHON || 'python3', ['-I', validator, expectedSha256], { stdio: [fd, 'pipe', 'pipe'], encoding: 'utf8', timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error('sealed restart validation failed');
  let restart;
  try { restart = JSON.parse(result.stdout); } catch { throw new Error('invalid sealed restart result'); }
  validateRestartState(restart, { session, channel, requireRoleProfile: true });
  return { schema: 'agent-mesh.sealed-restart.v1', stateSha256: expectedSha256, profileSha256: roleProfileDigest(restart.role_profile), roleProfile: restart.role_profile };
}
