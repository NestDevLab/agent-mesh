/** Prepare a private candidate for Claude's strict MCP configuration. */
const name = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const names = value => Array.isArray(value) && value.length <= 256 && value.every(name) && new Set(value).size === value.length;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

// Inventory must come from a trusted, private source and correspond to the
// configuration probed. The result may contain secrets: never log it or pass
// it as a command-line JSON argument. Strict mode and actual isolation must be
// verified by the native launcher; this function neither starts nor authorizes it.
// Strict mode can also exclude MCP servers contributed by enabled plugins.
// Include any role-authorized plugin MCP explicitly in the trusted inventory;
// enabling a plugin alone is not evidence that its MCP server will start.
export function planClaudeMcpConfig({ launchPlan, inventory }) {
  if (!object(launchPlan) || launchPlan.schema !== 'agent-mesh.role-launch-plan.v1' || !names(launchPlan.mcpToStart) || !names(launchPlan.mcpUnavailable) || launchPlan.mcpToStart.some(item => launchPlan.mcpUnavailable.includes(item)) || !object(inventory)) throw new Error('invalid MCP plan or inventory');
  const entries = Object.keys(inventory);
  if (entries.length > 4096 || entries.some(key => !name(key))) throw new Error('invalid MCP inventory');
  const mcpServers = Object.create(null);
  for (const key of launchPlan.mcpToStart) {
    if (!Object.hasOwn(inventory, key) || !object(inventory[key])) throw new Error('requested MCP missing from inventory');
    let value;
    try { value = JSON.parse(JSON.stringify(inventory[key])); } catch { throw new Error('invalid MCP configuration'); }
    if (!object(value) || Object.keys(value).length === 0) throw new Error('invalid MCP configuration');
    mcpServers[key] = value;
  }
  return { schema: 'agent-mesh.claude-mcp-candidate.v1', config: { mcpServers }, strictMcpConfig: true, isolation: 'unverified' };
}
