import assert from 'node:assert/strict';
import test from 'node:test';
import { rehearseHandover } from '../bin/handover-dry-run.mjs';

const role = name => ({ role: name, oldSession: `codex:${name}-old`, newSession: `codex:${name}-new`, profile: { schema: 'agent-mesh.role-profile.v1', role: name, permissions: ['read'], mcp: ['core', 'optional'], plugins: ['plugin'] }, authority: { role: name, permissions: ['read'], humanGatedPermissions: ['external'], mcp: ['core', 'optional'], plugins: ['plugin'] } });

test('two synthetic roles preserve messages and rollback on isolated faults', async () => {
  for (const name of ['one', 'two']) {
    const fixture = role(name);
    const offline = await rehearseHandover({ ...fixture, offlineMcp: ['optional'], messageDuringHandover: true });
    assert.equal(offline.simulated, true);
    assert.equal(offline.outcome, 'switched');
    assert.equal(offline.channel.session, fixture.newSession);
    assert.equal(offline.channel.queue[0].state, 'pending');
    assert.equal(offline.launch.mcpStarted, 1);
    assert.deepEqual(offline.launch.mcpUnavailable, ['optional']);
    assert.equal(offline.launch.startupTokens, null);
    for (const fault of ['permission', 'interrupted', 'quota']) {
      const result = await rehearseHandover({ ...fixture, fault, messageDuringHandover: true });
      assert.equal(result.outcome, 'rolled-back');
      assert.equal(result.channel.session, fixture.oldSession);
      assert.equal(result.channel.phase, 'active');
      assert.equal(result.channel.queue[0].state, 'pending');
    }
  }
});
