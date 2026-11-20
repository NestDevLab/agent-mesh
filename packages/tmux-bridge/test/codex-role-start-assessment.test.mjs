import assert from 'node:assert/strict';
import test from 'node:test';
import { assessCodexRoleStart } from '../bin/codex-role-start-assessment.mjs';

const id = '22222222-2222-4222-8222-222222222222';
const expected = { profile: { id: ':read-only', extends: null }, approvalPolicy: 'never', sandbox: { type: 'readOnly', networkAccess: false } };
const startResponse = { thread: { id }, activePermissionProfile: expected.profile, approvalPolicy: 'never', sandbox: expected.sandbox };
const sample = { schema: 'agent-mesh.codex-mcp-notification-sample.v1', requestedThreadId: id, permissionRequestObserved: null, invalidOrOverflow: false, counts: { ready: 1 } };

test('matching native fields remain incomplete without plugin and event coverage', () => {
  const receipt = assessCodexRoleStart({ startResponse, sample, expected });
  assert.equal(receipt.status, 'observed-incomplete');
  assert.equal(receipt.readyObserved, 1);
  assert.equal(receipt.mcpStarted, null);
  assert.equal(receipt.startupTokens, null);
  assert.ok(receipt.unknown.includes('plugin-isolation'));
});

test('permission request or exact-policy mismatch demands rollback', () => {
  const pending = assessCodexRoleStart({ startResponse, sample: { ...sample, permissionRequestObserved: true }, expected });
  assert.equal(pending.status, 'rollback-required');
  assert.ok(pending.failures.includes('unexpected-permission-request'));
  const wrong = assessCodexRoleStart({ startResponse: { ...startResponse, sandbox: { type: 'readOnly', networkAccess: true } }, sample, expected });
  assert.equal(wrong.status, 'rollback-required');
  assert.ok(wrong.failures.includes('sandbox-mismatch'));
  assert.throws(() => assessCodexRoleStart({ startResponse, sample: { ...sample, requestedThreadId: 'different' }, expected }), /invalid/);
});

test('unobserved fields and broken event coverage cannot prove readiness', () => {
  const receipt = assessCodexRoleStart({ startResponse: { ...startResponse, activePermissionProfile: null }, sample: { ...sample, invalidOrOverflow: true }, expected });
  assert.equal(receipt.status, 'observed-incomplete');
  assert.ok(receipt.unknown.includes('permission-profile'));
  assert.ok(receipt.unknown.includes('notification-integrity'));
});
