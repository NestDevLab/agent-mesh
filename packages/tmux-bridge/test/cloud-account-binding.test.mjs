import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { claudeSubjectHash, verifyClaudeAccount, withClaudeAccount } from '../bin/cloud-account-binding.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cloud-binding-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const status = { loggedIn: true, apiProvider: 'firstParty', authMethod: 'claude.ai', storedClaudeAiLogin: true, email: 'fixture@example.invalid', orgId: 'synthetic-org', configDirectory: root };
  const profile = { scope: 'fixture', configDir: root, command: '/synthetic/claude', expectedSubjectHash: claudeSubjectHash(status) };
  return { root, status, profile };
}

test('matching provider, profile and account produce only a bound digest', async t => {
  const f = await fixture(t);
  const run = async (command, args, options) => {
    assert.equal(command, f.profile.command); assert.deepEqual(args, ['auth', 'status', '--json']);
    assert.equal(options.env.CLAUDE_CONFIG_DIR, f.root);
    return { stdout: JSON.stringify(f.status) };
  };
  const value = await verifyClaudeAccount(f.profile, run);
  assert.deepEqual(value, { scope: 'fixture', subjectHash: f.profile.expectedSubjectHash });
  assert.ok(!JSON.stringify(value).includes(f.status.email));
  let invoked = false;
  assert.equal(await withClaudeAccount(f.profile, async context => { invoked = true; assert.equal(context.configDir, f.root); return 'receipt'; }, run), 'receipt');
  assert.equal(invoked, true);
});

test('wrong account or profile fails before the action', async t => {
  const f = await fixture(t); let invoked = false;
  const run = async () => ({ stdout: JSON.stringify({ ...f.status, orgId: 'other' }) });
  await assert.rejects(withClaudeAccount(f.profile, async () => { invoked = true; }, run), /scope mismatch/);
  assert.equal(invoked, false);
  await assert.rejects(verifyClaudeAccount(f.profile, async () => ({ stdout: JSON.stringify({ ...f.status, configDirectory: '/other' }) })), /scope mismatch/);
  await assert.rejects(verifyClaudeAccount(f.profile, async () => ({ stdout: JSON.stringify({ ...f.status, loggedIn: false }) })), /identity unavailable/);
  await chmod(f.root, 0o755);
  await assert.rejects(verifyClaudeAccount(f.profile, run), /private/);
});

test('account changes or transport errors after invocation stay uncertain', async t => {
  const f = await fixture(t); let count = 0, actions = 0;
  const run = async () => ({ stdout: JSON.stringify(++count === 1 ? f.status : { ...f.status, email: 'other@example.invalid' }) });
  await assert.rejects(withClaudeAccount(f.profile, async () => { actions++; return 'accepted'; }, run), /outcome uncertain/);
  assert.equal(actions, 1);
  await assert.rejects(withClaudeAccount(f.profile, async () => { throw new Error('transport'); }, async () => ({ stdout: JSON.stringify(f.status) })), /outcome uncertain/);
});
