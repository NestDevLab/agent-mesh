/** Read-only final-notice evidence from a local Codex transcript snapshot. */
import { constants } from 'node:fs';
import { lstat, open, realpath, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TRANSCRIPT = 128 * 1024 * 1024;

function textOf(record, role) {
  const payload = record?.payload;
  if (record?.type === 'event_msg' && payload?.type === (role === 'user' ? 'user_message' : 'agent_message')) return typeof payload.message === 'string' ? payload.message : null;
  if (record?.type !== 'response_item' || payload?.type !== 'message' || payload.role !== role || !Array.isArray(payload.content)) return null;
  const type = role === 'user' ? 'input_text' : 'output_text';
  const parts = payload.content.filter(item => item?.type === type && typeof item.text === 'string').map(item => item.text);
  return parts.length ? parts.join('\n') : null;
}

/** An observation proves only the snapshot read; a later turn may still arrive. */
export async function observeCodexFinalNotice({ root, id, nonce, message }) {
  if (!isAbsolute(root) || typeof id !== 'string' || !UUID.test(id) || typeof nonce !== 'string' || !nonce.startsWith('handover-') || !UUID.test(nonce.slice('handover-'.length)) ||
      typeof message !== 'string' || !message || Buffer.byteLength(message) > 8192) throw new Error('invalid notice observation request');
  root = resolve(root);
  const directory = await lstat(root);
  if (!directory.isDirectory() || directory.isSymbolicLink() || await realpath(root) !== root) throw new Error('invalid transcript root');
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const candidates = entries.filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith(`${id.toLowerCase()}.jsonl`))
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
    const after = await handle.stat();
    const current = await lstat(path);
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== after.dev || current.ino !== after.ino || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('transcript changed during observation');
  } finally { await handle.close(); }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('invalid transcript encoding'); }
  if (!text.endsWith('\n')) throw new Error('partial transcript record');
  let meta = false, anchored = false, lastAssistant = null, completed = false;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let record;
    try { record = JSON.parse(line); } catch { throw new Error('invalid transcript record'); }
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('invalid transcript record');
    if (record.type === 'session_meta') {
      if (meta || record?.payload?.id !== id) throw new Error('transcript session mismatch');
      meta = true;
      continue;
    }
    if (!meta) throw new Error('transcript session metadata missing');
    const user = textOf(record, 'user');
    if (user !== null) {
      const newAnchor = user.includes(`[HANDOVER:${nonce}]`);
      // Native transcripts can repeat the same user message in two formats.
      if (!(anchored && newAnchor && lastAssistant === null && !completed)) { anchored = newAnchor; lastAssistant = null; completed = false; }
      continue;
    }
    if (record.type === 'event_msg' && record?.payload?.type === 'task_started' && completed) { anchored = false; completed = false; lastAssistant = null; }
    if (anchored && record.type === 'response_item' && ['function_call', 'custom_tool_call'].includes(record?.payload?.type)) { lastAssistant = null; completed = false; }
    const assistant = textOf(record, 'assistant');
    if (assistant !== null && anchored) { if (completed) completed = false; lastAssistant = assistant; }
    if (record.type === 'event_msg' && record?.payload?.type === 'task_complete' && anchored) {
      completed = lastAssistant === message && record.payload.last_agent_message === message;
    }
  }
  if (!meta || !anchored || !completed) throw new Error('final notice not proven in transcript snapshot');
  return { schema: 'agent-mesh.final-notice-observation.v1', session: `codex:${id}`, nonce,
    messageSha256: createHash('sha256').update(message).digest('hex'), transcriptSha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}
