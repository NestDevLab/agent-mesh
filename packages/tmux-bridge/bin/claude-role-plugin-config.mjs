/** Resolve role-approved plugin names to explicit local directories. */
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

const name = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Inventory is trusted caller input. This checks the directory identity at
// planning time, not plugin content, authorization, or runtime startup.
// A caller must revalidate and secure the tree before a native launch.
export async function planClaudePluginDirs({ launchPlan, inventory }) {
  if (!object(launchPlan) || launchPlan.schema !== 'agent-mesh.role-launch-plan.v1' ||
      !Array.isArray(launchPlan.plugins) || launchPlan.plugins.length > 256 ||
      !launchPlan.plugins.every(name) || new Set(launchPlan.plugins).size !== launchPlan.plugins.length ||
      !object(inventory)) throw new Error('invalid plugin plan or inventory');
  const directories = [], seen = new Set();
  for (const plugin of launchPlan.plugins) {
    const path = Object.hasOwn(inventory, plugin) ? inventory[plugin] : undefined;
    if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || /[\u0000\r\n]/.test(path)) throw new Error('invalid plugin directory');
    const info = await lstat(path, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path || seen.has(path)) throw new Error('invalid or duplicate plugin directory');
    seen.add(path);
    directories.push({ name: plugin, path, device: String(info.dev), inode: String(info.ino) });
  }
  return { schema: 'agent-mesh.claude-plugin-candidate.v1', directories, isolation: 'unverified' };
}

// Directory identity is not a content seal and cannot prevent later replacement.
export async function revalidateClaudePluginDirs(candidate) {
  if (!object(candidate) || candidate.schema !== 'agent-mesh.claude-plugin-candidate.v1' || !Array.isArray(candidate.directories)) throw new Error('invalid plugin candidate');
  const seenNames = new Set(), seenPaths = new Set();
  for (const entry of candidate.directories) {
    if (!object(entry) || !name(entry.name) || typeof entry.path !== 'string' || !isAbsolute(entry.path) || resolve(entry.path) !== entry.path || seenNames.has(entry.name) || seenPaths.has(entry.path) || !/^[0-9]+$/.test(entry.device) || !/^[0-9]+$/.test(entry.inode)) throw new Error('invalid plugin candidate');
    const info = await lstat(entry.path, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(entry.path) !== entry.path || String(info.dev) !== entry.device || String(info.ino) !== entry.inode) throw new Error('plugin directory identity changed');
    seenNames.add(entry.name); seenPaths.add(entry.path);
  }
  return true;
}
