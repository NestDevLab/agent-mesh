/** Build a role-scoped launch plan without granting capabilities or starting services. */
import { validateRoleProfile } from './restart-state.mjs';

const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const list = value => Array.isArray(value) && value.length <= 256 && value.every(id) && new Set(value).size === value.length;

export async function planRoleLaunch({ profile, authority, probe, timeoutMs = 3000 }) {
  validateRoleProfile(profile);
  if (!authority || authority.role !== profile.role || !list(authority.permissions) || !list(authority.mcp) || !list(authority.plugins) || !list(authority.humanGatedPermissions) || typeof probe !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('invalid role authority');
  for (const field of ['permissions', 'mcp', 'plugins']) if (profile[field].some(value => !authority[field].includes(value))) throw new Error('role profile exceeds authority');
  if (profile.permissions.some(value => authority.humanGatedPermissions.includes(value))) throw new Error('human-gated permission cannot be pregranted');
  const available = [], unavailable = [];
  for (const name of profile.mcp) {
    let timer, cleanupTimer; const controller = new AbortController(), timedOut = Symbol('timeout'), cleanupTimedOut = Symbol('cleanup-timeout');
    const pending = Promise.resolve().then(() => probe(name, { signal: controller.signal }));
    try {
      const result = await Promise.race([pending, new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(timedOut); }, timeoutMs); })]);
      if (result === timedOut) {
        const cleanup = await Promise.race([pending.then(() => true, () => true), new Promise(resolve => { cleanupTimer = setTimeout(() => resolve(cleanupTimedOut), 1500); })]);
        if (cleanup === cleanupTimedOut) throw new Error('probe cancellation unconfirmed');
        unavailable.push(name); continue;
      }
      (result === true ? available : unavailable).push(name);
    } catch (error) { if (error?.message === 'probe cancellation unconfirmed') throw error; unavailable.push(name); }
    finally { clearTimeout(timer); clearTimeout(cleanupTimer); controller.abort(); }
  }
  return { schema: 'agent-mesh.role-launch-plan.v1', role: profile.role, permissions: [...profile.permissions], plugins: [...profile.plugins], mcpToStart: available, mcpUnavailable: unavailable };
}

/** Assess observed startup; the caller owns rollback and native observation. */
export function assessRoleLaunch({ plan, observed }) {
  if (!plan || plan.schema !== 'agent-mesh.role-launch-plan.v1' || !list(plan.permissions) || !list(plan.plugins) || !list(plan.mcpToStart) || !list(plan.mcpUnavailable) || !observed || !list(observed.mcpStarted) || !list(observed.pluginsStarted) || typeof observed.permissionPrompt !== 'boolean' || !(observed.startupTokens === null || (Number.isSafeInteger(observed.startupTokens) && observed.startupTokens >= 0))) throw new Error('invalid launch observation');
  const unexpected = observed.mcpStarted.some(value => !plan.mcpToStart.includes(value)) || observed.pluginsStarted.some(value => !plan.plugins.includes(value));
  const failed = observed.permissionPrompt || unexpected;
  return { schema: 'agent-mesh.role-launch-receipt.v1', status: failed ? 'rollback-required' : 'ready', reason: observed.permissionPrompt ? 'unexpected-permission' : unexpected ? 'unexpected-component' : null, mcpStarted: observed.mcpStarted.length, mcpUnavailable: [...new Set([...plan.mcpUnavailable, ...plan.mcpToStart.filter(value => !observed.mcpStarted.includes(value))])], startupTokens: observed.startupTokens };
}
