/** Native queue adapter; this module does not authorize or perform a cutover. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatFinalNotice } from './handover-notice.mjs';
import { observeCodexFinalNotice } from './handover-codex-observation.mjs';
import { observeClaudeFinalNotice } from './handover-claude-observation.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const nativeBin = join(dirname(fileURLToPath(import.meta.url)), 'agent-native-call.mjs');
const digest = value => createHash('sha256').update(value).digest('hex');
const exec = (command, args, { input, ...options }) => new Promise((resolve, reject) => {
  const child = execFile(command, args, options, (error, stdout) => error ? reject(new Error('native notice delivery uncertain')) : resolve({ stdout }));
  child.stdin.on('error', () => {});
  child.stdin.end(input);
});

/** The caller must first durably reserve this nonce and verify the successor. */
export async function queueLocalFinalNotice({ session, nonce, target, label, prefix, managedInboxRoot }, runNative = exec) {
  if (typeof session !== 'string') throw new Error('invalid local notice session');
  const [agent, id, ...extra] = session.split(':');
  if (!['codex', 'claude'].includes(agent) || !uuid.test(id || '') || extra.length || typeof nonce !== 'string' || !nonce.startsWith('handover-') || !uuid.test(nonce.slice('handover-'.length))) throw new Error('invalid local notice request');
  if (agent === 'claude' && (typeof managedInboxRoot !== 'string' || !isAbsolute(managedInboxRoot))) throw new Error('managed inbox required');
  if (agent === 'codex' && managedInboxRoot !== undefined) throw new Error('managed inbox only for Claude');
  const notice = formatFinalNotice({ target, label, prefix });
  const prompt = `[HANDOVER:${nonce}] The successor has been verified. As your final message, output exactly the following notice and nothing else. Do not call any tools after writing it.\n${notice}`;
  const args = [nativeBin, '--agent', agent, '--session', id, '--correlation-id', nonce, '--timeout', '5', '--message-stdin', '--delivery-only'];
  if (agent === 'codex') args.push('--no-resume');
  else args.push('--managed-inbox-root', managedInboxRoot);
  let result;
  try { result = await runNative(process.execPath, args, { input: prompt, timeout: 10000, maxBuffer: 8192 }); }
  catch { throw new Error('native notice delivery uncertain; do not resend'); }
  let receipt;
  try { receipt = JSON.parse(result?.stdout); } catch { throw new Error('native notice delivery uncertain; do not resend'); }
  if (!receipt || receipt.agent !== agent || receipt.sessionId !== id || receipt.correlationId !== nonce || receipt.held === true || receipt.status !== 'queued') throw new Error('native notice delivery unconfirmed; do not resend');
  return { schema: 'agent-mesh.notice-queue.v1', session, nonce, noticeSha256: digest(notice), status: 'queued-unverified' };
}

/** Call only after reserving in the trusted graph and acquiring lifecycle exclusion. */
export async function queueReservedFinalNotice({ reservation, target, label, prefix, managedInboxRoot }, runNative = exec) {
  if (!reservation || reservation.status !== 'requested' || typeof reservation.session !== 'string' || typeof reservation.id !== 'string' || !target || target.kind !== 'codex' || reservation.successor !== `codex:${target.id}` || reservation.noticeSha256 !== digest(formatFinalNotice({ target, label, prefix }))) throw new Error('final notice reservation does not match request');
  return queueLocalFinalNotice({ session: reservation.session, nonce: reservation.id, target, label, prefix, managedInboxRoot }, runNative);
}

/** Obtain local native transcript evidence independently from the queue receipt. */
export async function observeLocalFinalNotice({ session, nonce, target, label, prefix, transcriptRoot }) {
  if (typeof session !== 'string') throw new Error('invalid local notice session');
  const [agent, id, ...extra] = session.split(':');
  if (!['codex', 'claude'].includes(agent) || !uuid.test(id || '') || extra.length) throw new Error('invalid local notice session');
  const message = formatFinalNotice({ target, label, prefix });
  const observe = agent === 'codex' ? observeCodexFinalNotice : observeClaudeFinalNotice;
  return observe({ root: transcriptRoot, id, nonce, message });
}
