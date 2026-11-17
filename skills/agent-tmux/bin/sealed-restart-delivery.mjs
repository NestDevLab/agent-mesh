/** Build a private delivery payload from the same sealed restart descriptor. */
import { createHash } from 'node:crypto';
import { fstatSync, readSync } from 'node:fs';
import { validateSealedRestart } from './sealed-restart-validate.mjs';

// The caller must authenticate the receipt, protect this private payload, and
// prove that the intended successor received it. This function sends nothing.
export function readSealedRestartForDelivery({ fd, session, channel, expectedSha256, expectedProfileSha256 }) {
  if (typeof expectedProfileSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedProfileSha256)) throw new Error('invalid expected profile digest');
  const proof = validateSealedRestart({ fd, session, channel, expectedSha256 });
  if (proof.profileSha256 !== expectedProfileSha256) throw new Error('role profile digest mismatch');
  const { size } = fstatSync(fd);
  if (!Number.isSafeInteger(size) || size < 1 || size > 1024 * 1024) throw new Error('invalid sealed restart size');
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(fd, bytes, offset, size - offset, offset);
    if (count <= 0) throw new Error('sealed restart read incomplete');
    offset += count;
  }
  if (createHash('sha256').update(bytes).digest('hex') !== expectedSha256) throw new Error('sealed restart digest changed');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw new Error('invalid sealed restart encoding'); }
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('sealed restart encoding changed');
  return { schema: 'agent-mesh.sealed-restart-delivery.v1', stateSha256: expectedSha256, profileSha256: proof.profileSha256, text };
}
