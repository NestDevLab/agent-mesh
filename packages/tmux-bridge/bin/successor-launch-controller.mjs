/** One conservative launch attempt. Adapters must be bound to the same trusted host. */
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

// markInvoking must durably serialize the exact reservation under the graph lock.
// preflight and launch are trusted adapters; their values are not self-authenticating.
// This function does not settle a reservation or claim a successor was created.
export async function invokeReservedSuccessor({ binding, preflight, markInvoking, launch }) {
  if (!binding || !id(binding.handoverId) || !id(binding.launchId) || !id(binding.session) || !Number.isSafeInteger(binding.generation) || binding.generation < 1 || !digest(binding.profileSha256) || !digest(binding.stateSha256) || typeof preflight !== 'function' || typeof markInvoking !== 'function' || typeof launch !== 'function') throw new Error('invalid successor invocation');
  const check = await preflight(structuredClone(binding));
  if (!check || check.schema !== 'agent-mesh.successor-preflight.v1' || check.status !== 'ready' || check.handoverId !== binding.handoverId || check.launchId !== binding.launchId || check.session !== binding.session || check.generation !== binding.generation || check.profileSha256 !== binding.profileSha256 || check.stateSha256 !== binding.stateSha256 || check.permissionPrompt !== false || check.approvalPolicy !== 'never' || check.roleProfileVerified !== true || check.mcpComplete !== true || check.pluginsVerified !== true || !Number.isSafeInteger(check.mcpStarted) || check.mcpStarted < 0) throw new Error('successor preflight incomplete or mismatched');
  const result = await markInvoking(structuredClone(binding));
  const channel = result?.channel, reservation = channel?.successorLaunch;
  if (!channel || channel.phase !== 'handover' || channel.handoverId !== binding.handoverId || channel.session !== binding.session || channel.generation !== binding.generation || !reservation || reservation.status !== 'invoking' || reservation.id !== binding.launchId || reservation.profileSha256 !== binding.profileSha256 || reservation.stateSha256 !== binding.stateSha256 || reservation.handoverId !== binding.handoverId || reservation.session !== binding.session || reservation.generation !== binding.generation) throw new Error('invocation checkpoint unavailable or mismatched');
  try { await launch(structuredClone(binding)); }
  catch { return { schema: 'agent-mesh.successor-invocation.v1', status: 'outcome-uncertain', handoverId: binding.handoverId, launchId: binding.launchId }; }
  return { schema: 'agent-mesh.successor-invocation.v1', status: 'outcome-unverified', handoverId: binding.handoverId, launchId: binding.launchId };
}
