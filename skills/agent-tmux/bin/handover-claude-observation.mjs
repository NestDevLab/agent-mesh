/** Read-only final-notice evidence from one stable local Claude transcript snapshot. */
import { constants } from 'node:fs';
import { lstat, open, realpath, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TRANSCRIPT = 128 * 1024 * 1024;

/** Proves only the stable snapshot read; later turns can invalidate the notice. */
export async function observeClaudeFinalNotice({ root, id, nonce, message }) {
  if (typeof root !== 'string' || !isAbsolute(root) || typeof id !== 'string' || !UUID.test(id) ||
      typeof nonce !== 'string' || !nonce.startsWith('handover-') || !UUID.test(nonce.slice('handover-'.length)) ||
      typeof message !== 'string' || !message || Buffer.byteLength(message) > 8192) throw new Error('invalid notice observation request');
  root = resolve(root);
  const directory = await lstat(root);
  if (!directory.isDirectory() || directory.isSymbolicLink() || await realpath(root) !== root) throw new Error('invalid transcript root');
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const candidates = entries.filter(entry => entry.isFile() && entry.name.toLowerCase() === `${id.toLowerCase()}.jsonl`)
    .map(entry => join(entry.parentPath, entry.name));
  if (candidates.length !== 1) throw new Error('transcript identity unavailable or ambiguous');
  const path = candidates[0];
  if (await realpath(path) !== path) throw new Error('non-canonical transcript');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.uid !== process.getuid() || before.nlink !== 1 || (before.mode & 0o022) !== 0 || before.size < 1 || before.size > MAX_TRANSCRIPT) throw new Error('invalid transcript file');
    bytes = await handle.readFile();
    const after = await handle.stat(), current = await lstat(path);
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== after.dev || current.ino !== after.ino || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('transcript changed during observation');
  } finally { await handle.close(); }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('invalid transcript encoding'); }
  if (!text.endsWith('\n')) throw new Error('partial transcript record');
  let anchored = false, responseId = null, answer = '', completed = false;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let record;
    try { record = JSON.parse(line); } catch { throw new Error('invalid transcript record'); }
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('invalid transcript record');
    if (record.isSidechain || record.isMeta || !['user', 'assistant'].includes(record.type)) continue;
    if (record.sessionId !== id) throw new Error('transcript session mismatch');
    const content = record.message?.content;
    if (record.type === 'user') {
      const parts = typeof content === 'string' ? [content] : Array.isArray(content) ? content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text) : [];
      if (parts.length) { anchored = parts.join('\n').includes(`[HANDOVER:${nonce}]`); responseId = null; answer = ''; completed = false; }
      continue;
    }
    if (!anchored) continue;
    const native = record.message;
    if (!native || typeof native.id !== 'string' || !native.id || !Array.isArray(content)) throw new Error('invalid assistant record');
    if (native.id !== responseId) { responseId = native.id; answer = ''; completed = false; }
    const toolUse = content.some(part => part?.type === 'tool_use');
    const parts = content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text);
    if (parts.length) answer += parts.join('\n');
    if (toolUse) completed = false;
    else if (native.stop_reason === 'end_turn') completed = true;
    else if (native.stop_reason !== null && native.stop_reason !== undefined) completed = false;
  }
  if (!anchored || !completed || answer !== message) throw new Error('final notice not proven in transcript snapshot');
  return { schema: 'agent-mesh.final-notice-observation.v1', session: `claude:${id}`, nonce,
    messageSha256: createHash('sha256').update(message).digest('hex'), transcriptSha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}
