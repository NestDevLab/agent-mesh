/** Build probe commands and a Claude MCP candidate from one private snapshot. */
import { isAbsolute } from 'node:path';
import { planRoleLaunch } from './role-launch-profile.mjs';
import { roleProbeFromAllowlist } from './role-mcp-probe.mjs';
import { planClaudeMcpConfig } from './claude-role-mcp-config.mjs';

const invalid = () => Object.assign(new Error('invalid private Claude MCP inventory'), { code: 'MCP_PROBE_CONFIGURATION' });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// authority and inventory are trusted host inputs, not values from RIAVVIO.
// This binds stdio command, args and explicit environment to a single snapshot;
// it does not authenticate the inventory, pin executables, match inherited
// environment, or prove that Claude ultimately consumes this candidate.
export async function prepareClaudeRoleMcp({ profile, authority, inventory, timeoutMs = 5000 }) {
  let snapshot;
  try { snapshot = JSON.parse(JSON.stringify(inventory)); } catch { throw invalid(); }
  if (!object(snapshot)) throw invalid();
  const probe = async (name, options) => {
    const entry = Object.hasOwn(snapshot, name) ? snapshot[name] : undefined;
    if (!object(entry) || Object.keys(entry).some(key => !['type', 'command', 'args', 'env'].includes(key)) || (entry.type !== undefined && entry.type !== 'stdio') || typeof entry.command !== 'string' || !isAbsolute(entry.command) || (entry.args !== undefined && (!Array.isArray(entry.args) || !entry.args.every(value => typeof value === 'string'))) || (entry.env !== undefined && (!object(entry.env) || !Object.values(entry.env).every(value => typeof value === 'string'))) || JSON.stringify(entry).includes('${CLAUDE_PLUGIN_ROOT}')) throw invalid();
    const allowlist = { [name]: { command: [entry.command, ...(entry.args || [])], env: entry.env || {} } };
    return roleProbeFromAllowlist(allowlist, timeoutMs)(name, options);
  };
  const plan = await planRoleLaunch({ profile, authority, probe, timeoutMs });
  const candidate = planClaudeMcpConfig({ launchPlan: plan, inventory: snapshot });
  return { schema: 'agent-mesh.claude-role-mcp-preflight.v1', plan, candidate };
}
