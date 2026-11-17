/** Read-only observation of one managed inbox record in a local Claude transcript. */
import { constants, lstatSync, realpathSync } from 'node:fs';
import { lstat, open, realpath, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const hash = data => createHash('sha256').update(data).digest('hex');

export async function observeClaudeDelivery({ root, session, generation, messageId, payload, snapshotBytes }) {
  if (typeof root !== 'string' || !isAbsolute(root) || typeof session !== 'string' || !session.startsWith('claude:') || !UUID.test(session.slice(7)) || !Number.isSafeInteger(generation) || generation < 1 || typeof messageId !== 'string' || !TOKEN.test(messageId) || typeof payload !== 'string' || !payload || Buffer.byteLength(payload) > 65536) throw new Error('invalid delivery observation request');
  if (snapshotBytes !== undefined && (!Number.isSafeInteger(snapshotBytes) || snapshotBytes < 1 || snapshotBytes > 128 * 1024 * 1024)) throw new Error('invalid transcript snapshot size');
  root = resolve(root);
  const directory = await lstat(root);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid() || await realpath(root) !== root) throw new Error('invalid transcript root');
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const matches = entries.filter(entry => entry.isFile() && entry.name.toLowerCase() === `${session.slice(7).toLowerCase()}.jsonl`).map(entry => join(entry.parentPath, entry.name));
  if (matches.length !== 1 || await realpath(matches[0]) !== matches[0]) throw new Error('transcript identity unavailable or ambiguous');
  const path = matches[0], file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes, snapshotIdentity;
  try {
    const before = await file.stat();
    if (!before.isFile() || before.uid !== process.getuid() || before.nlink !== 1 || (before.mode & 0o022) !== 0 || before.size < 1 || before.size > 128 * 1024 * 1024) throw new Error('invalid transcript file');
    bytes = await file.readFile();
    const after = await file.stat(), current = await lstat(path);
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== after.dev || current.ino !== after.ino || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('transcript changed during observation');
    snapshotIdentity = { path, dev: after.dev, ino: after.ino, size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs };
  } finally { await file.close(); }
  if (snapshotBytes !== undefined) {
    if (snapshotBytes > bytes.length) throw new Error('transcript snapshot truncated');
    bytes = bytes.subarray(0, snapshotBytes);
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('invalid transcript encoding'); }
  if (!text.endsWith('\n')) throw new Error('partial transcript record');
  let found = 0, queued = 0, queuedLine = null;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let record; try { record = JSON.parse(line); } catch { throw new Error('invalid transcript record'); }
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('invalid transcript record');
    const isQueue = record.type === 'queue-operation' && record.operation === 'enqueue';
    const isUser = record.type === 'user' && !record.isSidechain && record.message?.role === 'user';
    if (!isQueue && !isUser) continue;
    const content = isQueue ? record.content : record.message?.content;
    const parts = typeof content === 'string' ? [content] : Array.isArray(content) ? content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text) : [];
    for (const part of parts) for (const entry of part.split('\n')) {
      if (!entry.startsWith('AGENT_MESH_INBOX ')) continue;
      let inbox; try { inbox = JSON.parse(entry.slice('AGENT_MESH_INBOX '.length)); } catch { throw new Error('invalid inbox record'); }
      if (inbox?.deliveryId === messageId || inbox?.meshId === messageId) {
        if (record.sessionId !== session.slice(7)) throw new Error('transcript session mismatch');
        if (inbox.schema !== 'agent-mesh.monitor-inbox.v1' || inbox.deliveryId !== messageId || inbox.meshId !== messageId || inbox.prompt !== payload) throw new Error('inbox correlation mismatch');
        if (isQueue) { queued++; queuedLine = entry; }
        else { if (queued !== 1 || queuedLine !== entry) throw new Error('matching prior enqueue unavailable'); found++; }
      }
    }
  }
  if (queued !== 1 || found !== 1) throw new Error('delivery not uniquely observed');
  const payloadSha256 = hash(payload), transcriptSha256 = hash(bytes);
  const evidence = `claude-transcript:${hash(JSON.stringify([session, generation, messageId, payloadSha256, transcriptSha256]))}`;
  return { schema: 'agent-mesh.delivery-observation.v1', session, generation, messageId, payloadSha256, transcriptSha256, transcriptBytes: bytes.length, evidence, snapshotIdentity };
}

// Narrows the snapshot-to-graph race; it cannot exclude a writer after this check.
export function assertClaudeDeliverySnapshotCurrent(proof) {
  const snapshot = proof?.snapshotIdentity;
  if (!snapshot || typeof snapshot.path !== 'string' || !isAbsolute(snapshot.path)) throw new Error('transcript snapshot identity unavailable');
  let current;
  try { current = lstatSync(snapshot.path); if (realpathSync(snapshot.path) !== snapshot.path) throw new Error(); }
  catch { throw new Error('transcript snapshot unavailable'); }
  if (!current.isFile() || current.isSymbolicLink() || current.uid !== process.getuid() || current.nlink !== 1 || (current.mode & 0o022) !== 0 || current.dev !== snapshot.dev || current.ino !== snapshot.ino || current.size !== snapshot.size || current.mtimeMs !== snapshot.mtimeMs || current.ctimeMs !== snapshot.ctimeMs) throw new Error('transcript changed after observation');
}
