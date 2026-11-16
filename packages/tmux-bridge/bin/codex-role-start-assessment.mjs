/** Compare a native start response and passive observations to trusted policy. */
import { isDeepStrictEqual } from 'node:util';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Neither argument authenticates itself. The caller must bind the start response
// and events to the same trusted native connection and authorized role policy.
export function assessCodexRoleStart({ startResponse, sample, expected }) {
  if (!object(startResponse) || !object(sample) || sample.schema !== 'agent-mesh.codex-mcp-notification-sample.v1' || !object(expected) || !object(expected.profile) || typeof expected.profile.id !== 'string' || !expected.profile.id || !object(expected.sandbox) || expected.approvalPolicy !== 'never' || typeof startResponse.thread?.id !== 'string' || !uuid.test(startResponse.thread.id) || sample.requestedThreadId !== startResponse.thread.id || ![true, null].includes(sample.permissionRequestObserved) || typeof sample.invalidOrOverflow !== 'boolean' || !object(sample.counts) || !Number.isSafeInteger(sample.counts.ready) || sample.counts.ready < 0) throw new Error('invalid role start observation');
  const failures = [];
  if (sample.permissionRequestObserved === true) failures.push('unexpected-permission-request');
  if (startResponse.approvalPolicy !== expected.approvalPolicy) failures.push('approval-policy-mismatch');
  if (startResponse.activePermissionProfile != null && !isDeepStrictEqual(startResponse.activePermissionProfile, expected.profile)) failures.push('permission-profile-mismatch');
  if (startResponse.sandbox != null && !isDeepStrictEqual(startResponse.sandbox, expected.sandbox)) failures.push('sandbox-mismatch');
  const unknown = ['plugin-isolation', 'mcp-coverage', 'startup-tokens'];
  if (startResponse.activePermissionProfile == null) unknown.push('permission-profile');
  if (startResponse.sandbox == null) unknown.push('sandbox');
  if (sample.invalidOrOverflow) unknown.push('notification-integrity');
  return { schema: 'agent-mesh.codex-role-start-assessment.v1', session: `codex:${startResponse.thread.id}`,
    status: failures.length ? 'rollback-required' : 'observed-incomplete', failures, unknown,
    readyObserved: sample.counts.ready, mcpStarted: null, startupTokens: null };
}
