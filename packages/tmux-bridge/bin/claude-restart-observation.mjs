/** Observe one exact private restart frame in a stable local Claude transcript. */
import { constants } from 'node:fs';
import { lstat, open, realpath, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { parseRestartDeliveryFrame } from './restart-delivery-frame.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = value => createHash('sha256').update(value).digest('hex');

// Caller authenticates the successor and reservation and must protect `frame`.
// A user record proves transcript appearance only, not execution or ownership.
export async function observeClaudeRestartFrame({ root, session, frame, expectedStateSha256 }) {
  if (typeof root !== 'string' || !isAbsolute(root) || typeof session !== 'string' || !session.startsWith('claude:') || !UUID.test(session.slice(7)) || typeof expectedStateSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedStateSha256)) throw new Error('invalid restart observation request');
  const decoded = parseRestartDeliveryFrame(frame);
  if (decoded.stateSha256 !== expectedStateSha256) throw new Error('restart state digest mismatch');
  root = resolve(root);
  const dir = await lstat(root);
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid() || await realpath(root) !== root) throw new Error('invalid transcript root');
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const matches = entries.filter(entry => entry.isFile() && entry.name.toLowerCase() === `${session.slice(7).toLowerCase()}.jsonl`).map(entry => join(entry.parentPath, entry.name));
  if (matches.length !== 1 || await realpath(matches[0]) !== matches[0]) throw new Error('transcript identity unavailable or ambiguous');
  const path = matches[0], file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    const before = await file.stat();
    if (!before.isFile() || before.uid !== process.getuid() || before.nlink !== 1 || (before.mode & 0o022) !== 0 || before.size < 1 || before.size > 128 * 1024 * 1024) throw new Error('invalid transcript file');
    bytes = await file.readFile();
    const after = await file.stat(), current = await lstat(path);
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== after.dev || current.ino !== after.ino || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('transcript changed during observation');
  } finally { await file.close(); }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('invalid transcript encoding'); }
  if (!text.endsWith('\n')) throw new Error('partial transcript record');
  let count = 0;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let record; try { record = JSON.parse(line); } catch { throw new Error('invalid transcript record'); }
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('invalid transcript record');
    if (record.type !== 'user' || record.isSidechain || record.isMeta || record.message?.role !== 'user') continue;
    const content = record.message.content;
    const message = typeof content === 'string' ? content : Array.isArray(content) && content.length === 1 && content[0]?.type === 'text' ? content[0].text : null;
    if (message !== frame) continue;
    if (record.sessionId !== session.slice(7)) throw new Error('transcript session mismatch');
    count++;
  }
  if (count !== 1) throw new Error('restart frame not uniquely observed');
  const frameSha256 = hash(frame), transcriptSha256 = hash(bytes);
  return { schema: 'agent-mesh.claude-restart-observation.v1', session, stateSha256: expectedStateSha256, frameSha256, transcriptSha256, transcriptBytes: bytes.length };
}
