/** Prepare explicit exclusions from an operator-supplied effective Codex config. */
const name = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const names = value => Array.isArray(value) && value.length <= 256 && value.every(name) && new Set(value).size === value.length;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// This is only a candidate override. Dynamic/plugin servers, changes between
// reading and launching, and permission enforcement require separate evidence.
export function planCodexMcpOverrides({ launchPlan, effectiveServers }) {
  if (!object(launchPlan) || launchPlan.schema !== 'agent-mesh.role-launch-plan.v1' || !names(launchPlan.mcpToStart) || !names(launchPlan.mcpUnavailable) || launchPlan.mcpToStart.some(item => launchPlan.mcpUnavailable.includes(item)) || !object(effectiveServers)) throw new Error('invalid MCP override inputs');
  const keys = Object.keys(effectiveServers);
  if (keys.length > 4096 || keys.some(key => !name(key) || !object(effectiveServers[key]) || (effectiveServers[key].enabled !== undefined && typeof effectiveServers[key].enabled !== 'boolean'))) throw new Error('invalid effective MCP inventory');
  for (const requested of launchPlan.mcpToStart) {
    if (!Object.hasOwn(effectiveServers, requested)) throw new Error('requested MCP missing from effective inventory');
    if (effectiveServers[requested].enabled === false) throw new Error('requested MCP is disabled');
  }
  const allowed = new Set(launchPlan.mcpToStart);
  const excluded = keys.filter(key => !allowed.has(key)).sort();
  const servers = Object.create(null);
  for (const key of excluded) servers[key] = { enabled: false };
  return { schema: 'agent-mesh.codex-mcp-overrides.v1', config: { mcp_servers: servers }, excludedCount: excluded.length, isolation: 'unverified' };
}
