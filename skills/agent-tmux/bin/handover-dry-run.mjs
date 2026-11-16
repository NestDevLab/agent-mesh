/** In-memory rehearsal only. No native session, service, timer or graph is changed. */
import { beginHandover, createChannel, enqueue, finishHandover } from './channel-state.mjs';
import { planRoleLaunch, assessRoleLaunch } from './role-launch-profile.mjs';

export async function rehearseHandover({ role, oldSession, newSession, profile, authority, offlineMcp = [], fault = 'none', messageDuringHandover = false }) {
  if (typeof role !== 'string' || profile?.role !== role || !['none', 'interrupted', 'quota', 'permission'].includes(fault) || !Array.isArray(offlineMcp) || !offlineMcp.every(name => typeof name === 'string') || typeof messageDuringHandover !== 'boolean') throw new Error('invalid rehearsal');
  let channel = beginHandover(createChannel(`fixture-${role}`, oldSession));
  if (messageDuringHandover) channel = enqueue(channel, 'fixture-message', 'synthetic message');
  const plan = await planRoleLaunch({ profile, authority, probe: async name => !offlineMcp.includes(name) });
  const observed = { mcpStarted: [...plan.mcpToStart], pluginsStarted: [...plan.plugins], permissionPrompt: fault === 'permission', startupTokens: null };
  const launch = assessRoleLaunch({ plan, observed });
  if (fault === 'interrupted' || fault === 'quota' || launch.status !== 'ready') {
    channel = { ...channel, phase: 'active' };
    return { schema: 'agent-mesh.handover-rehearsal.v1', simulated: true, outcome: 'rolled-back', reason: fault === 'none' ? launch.reason : fault, channel, launch };
  }
  channel = finishHandover(channel, newSession, true);
  return { schema: 'agent-mesh.handover-rehearsal.v1', simulated: true, outcome: 'switched', reason: null, channel, launch };
}
