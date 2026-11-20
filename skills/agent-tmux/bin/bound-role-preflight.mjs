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
  const final = await revalidateStateProof({ root, channel, session, generation, statePreparation });
  if (final.sha256 !== proof.sha256 || final.profileSha256 !== proof.profileSha256) throw new Error('restart state changed during role preflight');
  return { schema: 'agent-mesh.bound-role-plan.v1', stateSha256: proof.sha256, profileSha256: proof.profileSha256, mcpChecked: plan.mcpToStart.length + plan.mcpUnavailable.length, plan };
}

// This variant reads only the inherited sealed descriptor, never the source
// path. The caller still authenticates the receipt and must pass the same bytes
// to the native consumer; planning alone does not establish consumption.
export async function prepareSealedRoleLaunch({ fd, channel, session, expectedStateSha256, expectedProfileSha256, authority, probe, timeoutMs }) {
  if (typeof expectedProfileSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedProfileSha256)) throw new Error('invalid expected profile digest');
  const { validateSealedRestart } = await import('./sealed-restart-validate.mjs');
  const proof = validateSealedRestart({ fd, session, channel, expectedSha256: expectedStateSha256 });
  if (proof.profileSha256 !== expectedProfileSha256) throw new Error('role profile digest mismatch');
  const plan = await planRoleLaunch({ profile: proof.roleProfile, authority, probe, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  const final = validateSealedRestart({ fd, session, channel, expectedSha256: expectedStateSha256 });
  if (final.profileSha256 !== proof.profileSha256) throw new Error('sealed role profile changed');
  return { schema: 'agent-mesh.bound-role-plan.v1', stateSha256: proof.stateSha256, profileSha256: proof.profileSha256, mcpChecked: plan.mcpToStart.length + plan.mcpUnavailable.length, plan };
}
