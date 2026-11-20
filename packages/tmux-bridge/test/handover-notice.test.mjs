import assert from 'node:assert/strict';
import test from 'node:test';
import { successorLink, formatFinalNotice, matchesFinalNotice } from '../bin/handover-notice.mjs';

test('successor links preserve same-project anchors, cross-project links and Codex threads', () => {
  assert.equal(successorLink({ kind: 'cloud', sourceProject: 'chan_a', targetProject: 'chan_a', thread: 'cmsg_abc' }), '#cmsg_abc');
  assert.equal(successorLink({ kind: 'cloud', sourceProject: 'chan_a', targetProject: 'chan_b', thread: 'cmsg_abc' }), 'https://claude.ai/code/project/chan_b?thread=cmsg_abc');
  assert.equal(successorLink({ kind: 'codex', id: '22222222-2222-4222-8222-222222222222' }), 'codex://threads/22222222-2222-4222-8222-222222222222');
  for (const target of [{ kind: 'codex', id: 'short' }, { kind: 'cloud', sourceProject: 'a', targetProject: 'b?evil', thread: 'cmsg_abc' }, { kind: 'cloud', sourceProject: 'a', targetProject: 'a', thread: 'wrong' }]) assert.throws(() => successorLink(target));
});
test('notice text escapes labels and rejects injected lines', () => {
  const target = { kind: 'cloud', sourceProject: 'a', targetProject: 'a', thread: 'cmsg_abc' };
  assert.equal(formatFinalNotice({ target, label: 'Next [session]', prefix: 'Continue:' }), 'Continue: [Next \\[session\\]](#cmsg_abc)');
  assert.throws(() => formatFinalNotice({ target, label: 'next\nextra', prefix: 'Continue:' }));
});
test('a notice must be the observed final assistant message in the original session', () => {
  const expected = { session: 'codex:old', message: 'Continue here.' };
  const observation = { complete: true, session: expected.session, messages: [{ role: 'assistant', text: expected.message }] };
  assert.equal(matchesFinalNotice(observation, expected), true);
  assert.equal(matchesFinalNotice({ ...observation, complete: false }, expected), false);
  assert.equal(matchesFinalNotice({ ...observation, session: 'codex:other' }, expected), false);
  assert.equal(matchesFinalNotice({ ...observation, messages: [...observation.messages, { role: 'user', text: 'later' }] }, expected), false);
});
