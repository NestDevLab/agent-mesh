#!/usr/bin/env node
// Synthetic folder-backed adapter. No operational configuration or identities.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const schema = 'agent-mesh.ledger-adapter.v1';
const input = JSON.parse(readFileSync(0, 'utf8'));
const mode = process.env.FIXTURE_LEDGER_MODE;
if (mode === 'stderr') { console.error('private diagnostic must stay private'); process.exit(2); }
if (mode === 'timeout') { await new Promise(resolve => setTimeout(resolve, 1000)); }
if (mode === 'large') { console.log('x'.repeat(1024 * 1024 + 1)); process.exit(); }
if (mode === 'invalid') { console.log('{'); process.exit(); }
const items = readdirSync(process.env.FIXTURE_LEDGER_ROOT).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(process.env.FIXTURE_LEDGER_ROOT, name), 'utf8')));
const current = Object.fromEntries(items.map(item => [item.ref, createHash('sha256').update(JSON.stringify(item)).digest('hex')]));
const cursor = Buffer.from(JSON.stringify(current)).toString('base64url');
let result;
switch (process.argv[2]) {
case 'capabilities': result = { schemes: ['work'], operations: ['describe', 'changes'], sessionField: true }; break;
case 'describe': result = { items: items.filter(item => input.refs.includes(item.ref)), missing: input.refs.filter(ref => !current[ref]), errors: [] }; break;
case 'changes': {
  const before = input.cursor ? JSON.parse(Buffer.from(input.cursor, 'base64url').toString()) : {};
  const changed = input.cursor || input.full ? items.filter(item => before[item.ref] !== current[item.ref]) : [];
  const removed = Object.keys(before).filter(ref => !current[ref]).map(ref => ({ ref, title: 'Deleted item', status: 'deleted', updatedAt: '2026-09-01T12:00:00Z' }));
  result = { items: [...changed, ...removed], cursor, more: false, errors: mode === 'partial' ? [{ ref: 'work:A', error: 'private diagnostic' }] : [] }; break;
}
default: process.exit(2);
}
console.log(JSON.stringify({ schema, ...result }));
