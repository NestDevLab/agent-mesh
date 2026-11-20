import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, rename, writeFile, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { planClaudePluginDirs, revalidateClaudePluginDirs } from '../bin/claude-role-plugin-config.mjs';

const plan = plugins => ({ schema: 'agent-mesh.role-launch-plan.v1', plugins });

test('maps only role-approved plugins to canonical directories', async t => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-plan-')); t.after(() => rm(root, { recursive: true, force: true }));
  const approved = join(root, 'approved'), extra = join(root, 'extra');
  await mkdir(approved); await mkdir(extra);
  const result = await planClaudePluginDirs({ launchPlan: plan(['approved']), inventory: { approved, extra } });
  assert.deepEqual(result.directories.map(row => [row.name, row.path]), [['approved', approved]]);
  assert.equal(result.isolation, 'unverified');
});

test('rejects missing, relative, linked or shared plugin directories', async t => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-plan-')); t.after(() => rm(root, { recursive: true, force: true }));
  const approved = join(root, 'approved'), link = join(root, 'link');
  await mkdir(approved); await symlink(approved, link);
  for (const inventory of [{}, { a: './relative' }, { a: link }]) {
    await assert.rejects(planClaudePluginDirs({ launchPlan: plan(['a']), inventory }));
  }
  await assert.rejects(planClaudePluginDirs({ launchPlan: plan(['a', 'b']), inventory: { a: approved, b: approved } }));
  await assert.rejects(planClaudePluginDirs({ launchPlan: plan(['a', 'a']), inventory: { a: approved } }));
});

test('role preflight passes only the approved plugin candidate to the launcher plan', async t => {
  const { prepareClaudeRoleMcp } = await import('../bin/claude-role-mcp-preflight.mjs');
  const root = await mkdtemp(join(tmpdir(), 'plugin-preflight-')); t.after(() => rm(root, { recursive: true, force: true }));
  const approved = join(root, 'approved'), extra = join(root, 'extra');
  await mkdir(approved); await mkdir(extra);
  const profile = { schema: 'agent-mesh.role-profile.v1', role: 'operator', permissions: [], mcp: [], plugins: ['approved'] };
  const authority = { role: 'operator', permissions: [], humanGatedPermissions: [], mcp: [], plugins: ['approved'] };
  const options = { profile, authority, inventory: {}, pluginInventory: { approved, extra } };
  const result = await prepareClaudeRoleMcp(options);
  assert.deepEqual(result.pluginCandidate.directories.map(row => row.name), ['approved']);
  await assert.rejects(prepareClaudeRoleMcp({ ...options, pluginInventory: {} }));
  await assert.rejects(prepareClaudeRoleMcp({ ...options, authority: { ...authority, plugins: [] } }), /authority/);
});

test('revalidation rejects a directory replaced after planning', async t => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-revalidate-')); t.after(() => rm(root, { recursive: true, force: true }));
  const approved = join(root, 'approved'); await mkdir(approved);
  const candidate = await planClaudePluginDirs({ launchPlan: plan(['approved']), inventory: { approved } });
  assert.equal(await revalidateClaudePluginDirs(candidate), true);
  await rename(approved, join(root, 'previous')); await mkdir(approved);
  await assert.rejects(revalidateClaudePluginDirs(candidate), /identity changed/);
});

test('revalidation detects file changes and rejects links inside plugin trees', async t => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-content-')); t.after(() => rm(root, { recursive: true, force: true }));
  const approved = join(root, 'approved'); await mkdir(approved);
  const file = join(approved, 'entry.js'); await writeFile(file, 'first');
  const candidate = await planClaudePluginDirs({ launchPlan: plan(['approved']), inventory: { approved } });
  await writeFile(file, 'other');
  await assert.rejects(revalidateClaudePluginDirs(candidate), /content changed/);
  await symlink(file, join(approved, 'indirect'));
  await assert.rejects(planClaudePluginDirs({ launchPlan: plan(['approved']), inventory: { approved } }), /symlink/);
  await rm(join(approved, 'indirect'));
  await link(file, join(approved, 'hardlink'));
  await assert.rejects(planClaudePluginDirs({ launchPlan: plan(['approved']), inventory: { approved } }), /unsupported/);
});
