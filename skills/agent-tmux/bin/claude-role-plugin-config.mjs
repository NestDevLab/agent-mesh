/** Resolve role-approved plugin names to explicit local directories. */
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { observePluginTree } from './plugin-tree-observation.mjs';

const name = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Inventory is trusted caller input. This checks the directory identity at
// planning time and fingerprints its contents, not authorization or runtime startup.
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
    const tree = await observePluginTree(path);
    const after = await lstat(path, { bigint: true });
    if (after.dev !== info.dev || after.ino !== info.ino) throw new Error('plugin directory identity changed');
    directories.push({ name: plugin, path, device: String(info.dev), inode: String(info.ino), treeSha256: tree.sha256 });
  }
  return { schema: 'agent-mesh.claude-plugin-candidate.v1', directories, isolation: 'unverified' };
}

// Reobservation cannot prevent writes after this check or authenticate content.
export async function revalidateClaudePluginDirs(candidate) {
  if (!object(candidate) || candidate.schema !== 'agent-mesh.claude-plugin-candidate.v1' || !Array.isArray(candidate.directories)) throw new Error('invalid plugin candidate');
  const seenNames = new Set(), seenPaths = new Set();
  for (const entry of candidate.directories) {
    if (!object(entry) || !name(entry.name) || typeof entry.path !== 'string' || !isAbsolute(entry.path) || resolve(entry.path) !== entry.path || seenNames.has(entry.name) || seenPaths.has(entry.path) || !/^[0-9]+$/.test(entry.device) || !/^[0-9]+$/.test(entry.inode) || !/^[a-f0-9]{64}$/.test(entry.treeSha256)) throw new Error('invalid plugin candidate');
    const info = await lstat(entry.path, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(entry.path) !== entry.path || String(info.dev) !== entry.device || String(info.ino) !== entry.inode) throw new Error('plugin directory identity changed');
    const tree = await observePluginTree(entry.path);
    if (tree.sha256 !== entry.treeSha256) throw new Error('plugin content changed');
    const after = await lstat(entry.path, { bigint: true });
    if (after.dev !== info.dev || after.ino !== info.ino) throw new Error('plugin directory identity changed');
    seenNames.add(entry.name); seenPaths.add(entry.path);
  }
  return true;
}
