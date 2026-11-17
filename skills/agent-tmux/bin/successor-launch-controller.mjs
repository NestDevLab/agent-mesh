/** One conservative launch attempt. Adapters must be bound to the same trusted host. */
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

// markInvoking must durably serialize the exact reservation under the graph lock.
// preflight and launch are trusted adapters; their values are not self-authenticating.
// This function does not settle a reservation or claim a successor was created.
export async function invokeReservedSuccessor({ binding, preflight, markInvoking, launch }) {
  if (!binding || !id(binding.handoverId) || !id(binding.launchId) || !id(binding.session) || !Number.isSafeInteger(binding.generation) || binding.generation < 1 || !digest(binding.profileSha256) || !digest(binding.stateSha256) || typeof preflight !== 'function' || typeof markInvoking !== 'function' || typeof launch !== 'function') throw new Error('invalid successor invocation');
  const check = await preflight(structuredClone(binding));
  if (!check || check.schema !== 'agent-mesh.successor-preflight.v1' || check.status !== 'ready' || check.handoverId !== binding.handoverId || check.launchId !== binding.launchId || check.session !== binding.session || check.generation !== binding.generation || check.profileSha256 !== binding.profileSha256 || check.stateSha256 !== binding.stateSha256 || check.approvalPolicy !== 'never' || check.policyVerified !== true || check.roleProfileVerified !== true || check.mcpPreflightComplete !== true || check.pluginPlanVerified !== true || !Number.isSafeInteger(check.mcpChecked) || check.mcpChecked < 0) throw new Error('successor preflight incomplete or mismatched');
  const result = await markInvoking(structuredClone(binding));
  const channel = result?.channel, reservation = channel?.successorLaunch;
  if (!channel || channel.phase !== 'handover' || channel.handoverId !== binding.handoverId || channel.session !== binding.session || channel.generation !== binding.generation || !reservation || reservation.status !== 'invoking' || reservation.id !== binding.launchId || reservation.profileSha256 !== binding.profileSha256 || reservation.stateSha256 !== binding.stateSha256 || reservation.handoverId !== binding.handoverId || reservation.session !== binding.session || reservation.generation !== binding.generation || (binding.successorSession !== undefined && reservation.successorSession !== binding.successorSession) || (binding.bridgeLaunchId !== undefined && reservation.bridgeLaunchId !== binding.bridgeLaunchId)) throw new Error('invocation checkpoint unavailable or mismatched');
  try { await launch(structuredClone(binding)); }
  catch { return { schema: 'agent-mesh.successor-invocation.v1', status: 'outcome-uncertain', handoverId: binding.handoverId, launchId: binding.launchId }; }
  return { schema: 'agent-mesh.successor-invocation.v1', status: 'outcome-unverified', handoverId: binding.handoverId, launchId: binding.launchId };
}

// The caller supplies an authenticated authority, policy verifier, graph port,
// and launcher. No adapter can authenticate itself through this function.
// A launcher return is not proof of recipient observation or completion.
export async function invokeSealedSuccessor({ binding, fd, channel, authority, probe, verifyPolicy, markInvoking, launch }) {
  if (typeof verifyPolicy !== 'function' || typeof launch !== 'function') throw new Error('trusted launch adapters required');
  const { prepareSealedRoleLaunch } = await import('./bound-role-preflight.mjs');
  const { readSealedRestartForDelivery } = await import('./sealed-restart-delivery.mjs');
  const { frameRestartDelivery } = await import('./restart-delivery-frame.mjs');
  let plan;
  const preflight = async b => {
    const prepared = await prepareSealedRoleLaunch({ fd, channel, session: b.session, expectedStateSha256: b.stateSha256, expectedProfileSha256: b.profileSha256, authority, probe });
    const policy = await verifyPolicy({ binding: structuredClone(b), plan: structuredClone(prepared.plan) });
    plan = prepared.plan;
    return { schema: 'agent-mesh.successor-preflight.v1', status: 'ready', ...b, approvalPolicy: policy?.approvalPolicy, policyVerified: policy?.policyVerified, roleProfileVerified: true, mcpPreflightComplete: true, pluginPlanVerified: policy?.pluginPlanVerified, mcpChecked: prepared.mcpChecked };
  };
  return invokeReservedSuccessor({ binding, preflight, markInvoking, launch: async b => {
    const delivery = readSealedRestartForDelivery({ fd, session: b.session, channel, expectedSha256: b.stateSha256, expectedProfileSha256: b.profileSha256 });
    await launch({ binding: b, plan: structuredClone(plan), delivery, frame: frameRestartDelivery(delivery) });
  } });
}

// Candidate configuration is private and may contain credentials. It is passed
// only to the trusted launcher; never return it in a receipt or log it. Native
// launch, permission enforcement and complete MCP startup remain unverified.
export async function invokeSealedClaudeSuccessor({ binding, fd, channel, authority, inventory, pluginInventory = {}, verifyPolicy, markInvoking, launch }) {
  if (typeof verifyPolicy !== 'function' || typeof launch !== 'function' || !/^claude:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(binding?.successorSession || '') || binding.successorSession === binding.session || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(binding?.bridgeLaunchId || '')) throw new Error('trusted launch adapters and successor identity required');
  const { prepareSealedClaudeRoleMcp } = await import('./claude-role-mcp-preflight.mjs');
  const { readSealedRestartForDelivery } = await import('./sealed-restart-delivery.mjs');
  const { frameRestartDelivery } = await import('./restart-delivery-frame.mjs');
  const { revalidateClaudePluginDirs } = await import('./claude-role-plugin-config.mjs');
  let prepared;
  const preflight = async b => {
    prepared = await prepareSealedClaudeRoleMcp({ fd, channel, session: b.session, expectedStateSha256: b.stateSha256, expectedProfileSha256: b.profileSha256, authority, inventory, pluginInventory });
    const policy = await verifyPolicy({ binding: structuredClone(b), plan: structuredClone(prepared.plan) });
    await revalidateClaudePluginDirs(prepared.pluginCandidate);
    return { schema: 'agent-mesh.successor-preflight.v1', status: 'ready', ...b, approvalPolicy: policy?.approvalPolicy, policyVerified: policy?.policyVerified, roleProfileVerified: true, mcpPreflightComplete: true, pluginPlanVerified: policy?.pluginPlanVerified, mcpChecked: prepared.plan.mcpToStart.length + prepared.plan.mcpUnavailable.length };
  };
  return invokeReservedSuccessor({ binding, preflight, markInvoking, launch: async b => {
    await revalidateClaudePluginDirs(prepared.pluginCandidate);
    const delivery = readSealedRestartForDelivery({ fd, session: b.session, channel, expectedSha256: b.stateSha256, expectedProfileSha256: b.profileSha256 });
    await launch({ binding: b, plan: structuredClone(prepared.plan), candidate: structuredClone(prepared.candidate), pluginCandidate: structuredClone(prepared.pluginCandidate), delivery, frame: frameRestartDelivery(delivery) });
  } });
}
