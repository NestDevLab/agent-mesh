/** Build probe commands and a Claude MCP candidate from one private snapshot. */
import { isAbsolute } from 'node:path';
import { planRoleLaunch } from './role-launch-profile.mjs';
import { roleProbeFromAllowlist } from './role-mcp-probe.mjs';
import { planClaudeMcpConfig } from './claude-role-mcp-config.mjs';
import { planClaudePluginDirs } from './claude-role-plugin-config.mjs';

const invalid = () => Object.assign(new Error('invalid private Claude MCP inventory'), { code: 'MCP_PROBE_CONFIGURATION' });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// authority and inventory are trusted host inputs, not values from RIAVVIO.
// This binds stdio command, args and explicit environment to a single snapshot;
// it does not authenticate the inventory, pin executables, match inherited
// environment, or prove that Claude ultimately consumes this candidate.
export async function prepareClaudeRoleMcp({ profile, authority, inventory, pluginInventory = {}, timeoutMs = 5000 }) {
  let snapshot, pluginSnapshot;
  try { snapshot = JSON.parse(JSON.stringify(inventory)); pluginSnapshot = JSON.parse(JSON.stringify(pluginInventory)); } catch { throw invalid(); }
  if (!object(snapshot) || !object(pluginSnapshot)) throw invalid();
  const probe = async (name, options) => {
    const entry = Object.hasOwn(snapshot, name) ? snapshot[name] : undefined;
    if (!object(entry) || Object.keys(entry).some(key => !['type', 'command', 'args', 'env'].includes(key)) || (entry.type !== undefined && entry.type !== 'stdio') || typeof entry.command !== 'string' || !isAbsolute(entry.command) || (entry.args !== undefined && (!Array.isArray(entry.args) || !entry.args.every(value => typeof value === 'string'))) || (entry.env !== undefined && (!object(entry.env) || !Object.values(entry.env).every(value => typeof value === 'string'))) || JSON.stringify(entry).includes('${CLAUDE_PLUGIN_ROOT}')) throw invalid();
    const allowlist = { [name]: { command: [entry.command, ...(entry.args || [])], env: entry.env || {} } };
    return roleProbeFromAllowlist(allowlist, timeoutMs)(name, options);
  };
  const plan = await planRoleLaunch({ profile, authority, probe, timeoutMs });
  const candidate = planClaudeMcpConfig({ launchPlan: plan, inventory: snapshot });
  const pluginCandidate = await planClaudePluginDirs({ launchPlan: plan, inventory: pluginSnapshot });
  return { schema: 'agent-mesh.claude-role-mcp-preflight.v1', plan, candidate, pluginCandidate };
}

// The caller authenticates the graph receipt and must keep the same sealed
// descriptor alive until the native successor receives it. Neither a matching
// digest nor a responsive server proves trusted authority or native startup.
export async function prepareSealedClaudeRoleMcp({ fd, session, channel, expectedStateSha256, expectedProfileSha256, authority, inventory, pluginInventory = {}, timeoutMs }) {
  if (typeof expectedProfileSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedProfileSha256)) throw new Error('invalid expected profile digest');
  const { validateSealedRestart } = await import('./sealed-restart-validate.mjs');
  const proof = validateSealedRestart({ fd, session, channel, expectedSha256: expectedStateSha256 });
  if (proof.profileSha256 !== expectedProfileSha256) throw new Error('role profile digest mismatch');
  const result = await prepareClaudeRoleMcp({ profile: proof.roleProfile, authority, inventory, pluginInventory, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  const final = validateSealedRestart({ fd, session, channel, expectedSha256: expectedStateSha256 });
  if (final.profileSha256 !== proof.profileSha256) throw new Error('sealed role profile changed');
  return { ...result, stateSha256: proof.stateSha256, profileSha256: proof.profileSha256 };
}
