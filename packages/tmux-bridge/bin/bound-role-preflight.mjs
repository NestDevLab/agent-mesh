/** Revalidate a restart snapshot and build an authority-scoped MCP launch plan. */
import { revalidateStateProof } from './handover-state-proof.mjs';
import { planRoleLaunch } from './role-launch-profile.mjs';

// authority and probe are trusted host inputs, never taken from the session file.
// The returned plan is private. The file may change after this snapshot; callers
// must provide their own exclusion and verify the native launch separately.
export async function prepareBoundRoleLaunch({ root, channel, session, generation, statePreparation, expectedProfileSha256, authority, probe, timeoutMs }) {
  if (typeof expectedProfileSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedProfileSha256)) throw new Error('invalid expected profile digest');
  const proof = await revalidateStateProof({ root, channel, session, generation, statePreparation, includeRoleProfile: true });
  if (proof.profileSha256 !== expectedProfileSha256) throw new Error('role profile digest mismatch');
  const plan = await planRoleLaunch({ profile: proof.roleProfile, authority, probe, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  return { schema: 'agent-mesh.bound-role-plan.v1', stateSha256: proof.sha256, profileSha256: proof.profileSha256, mcpChecked: plan.mcpToStart.length + plan.mcpUnavailable.length, plan };
}
