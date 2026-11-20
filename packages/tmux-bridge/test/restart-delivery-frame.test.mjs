import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { frameRestartDelivery, parseRestartDeliveryFrame } from '../bin/restart-delivery-frame.mjs';

const make = text => ({ schema: 'agent-mesh.sealed-restart-delivery.v1', text, stateSha256: createHash('sha256').update(text).digest('hex') });

test('frame preserves exact UTF-8 and trailing newlines', () => {
  for (const body of ['fixture\n', 'fixture\n\n', 'role: café 😴\n', 'no trailing newline']) {
    const delivery = make(body), frame = frameRestartDelivery(delivery);
    const parsed = parseRestartDeliveryFrame(frame.text);
    assert.equal(parsed.text, body);
    assert.equal(parsed.stateSha256, delivery.stateSha256);
    assert.ok(!frame.text.endsWith('\n'));
  }
});

test('truncation, modification, malformed headers and incorrect digest fail closed', () => {
  const frame = frameRestartDelivery(make('fixture\n')).text;
  for (const invalid of [frame.slice(0, -1), frame + '\n', frame.replace('fixture', 'Fixture'), frame.replace('AGENT-MESH-RESTART ', 'OTHER ')]) assert.throws(() => parseRestartDeliveryFrame(invalid));
  assert.throws(() => frameRestartDelivery({ ...make('fixture'), stateSha256: 'a'.repeat(64) }), /digest/);
});
