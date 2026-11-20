/** In-memory rehearsal only. No native session, service, timer or graph is changed. */
import { beginHandover, abortHandover, createChannel, enqueue, switchHandover, reserveStatePreparation, completeStatePreparation } from './channel-state.mjs';
import { planRoleLaunch, assessRoleLaunch } from './role-launch-profile.mjs';

export async function rehearseHandover({ role, oldSession, newSession, profile, authority, offlineMcp = [], fault = 'none', messageDuringHandover = false }) {
  if (typeof role !== 'string' || profile?.role !== role || !['none', 'interrupted', 'quota', 'permission'].includes(fault) || !Array.isArray(offlineMcp) || !offlineMcp.every(name => typeof name === 'string') || typeof messageDuringHandover !== 'boolean') throw new Error('invalid rehearsal');
  let channel = beginHandover(createChannel(`fixture-${role}`, oldSession), 'fixture-handover');
  if (messageDuringHandover) channel = enqueue(channel, 'fixture-message', 'synthetic message');
  const plan = await planRoleLaunch({ profile, authority, probe: async name => !offlineMcp.includes(name) });
  const observed = { mcpStarted: [...plan.mcpToStart], pluginsStarted: [...plan.plugins], permissionPrompt: fault === 'permission', startupTokens: null };
  const launch = assessRoleLaunch({ plan, observed });
  if (fault === 'interrupted' || fault === 'quota' || launch.status !== 'ready') {
    channel = abortHandover(channel, { handoverId: 'fixture-handover', session: oldSession, generation: 1 });
    return { schema: 'agent-mesh.handover-rehearsal.v1', simulated: true, outcome: 'rolled-back', reason: fault === 'none' ? launch.reason : fault, channel, launch };
  }
  channel = reserveStatePreparation(channel, 'fixture-state');
  channel = completeStatePreparation(channel, { schema: 'agent-mesh.handover-state.v1', session: oldSession, nonce: 'fixture-state', filename: 'fixture.yaml', sha256: 'a'.repeat(64), bytes: 1 });
  channel = switchHandover(channel, newSession, true);
  return { schema: 'agent-mesh.handover-rehearsal.v1', simulated: true, outcome: 'switched-awaiting-delivery', reason: null, channel, launch };
}
