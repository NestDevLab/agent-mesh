/** Frame private restart bytes so trailing newlines survive interactive delivery. */
import { createHash, randomBytes } from 'node:crypto';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const max = 1024 * 1024;

// A digest and frame establish byte integrity, not sender identity, authority,
// receipt, or permission to act. The message and returned text are private.
export function frameRestartDelivery(delivery) {
  if (!delivery || delivery.schema !== 'agent-mesh.sealed-restart-delivery.v1' || typeof delivery.text !== 'string' || !/^[a-f0-9]{64}$/.test(delivery.stateSha256 || '')) throw new Error('invalid restart delivery');
  const body = Buffer.from(delivery.text, 'utf8');
  if (!body.length || body.length > max || body.toString('utf8') !== delivery.text || sha(body) !== delivery.stateSha256) throw new Error('restart delivery digest mismatch');
  let nonce, end;
  do { nonce = randomBytes(16).toString('hex'); end = `\nAGENT-MESH-RESTART-END ${nonce}`; } while (delivery.text.includes(end));
  return { schema: 'agent-mesh.restart-delivery-frame.v1', text: `AGENT-MESH-RESTART ${nonce} ${body.length} ${delivery.stateSha256}\n${delivery.text}${end}` };
}

/** Verify and decode a complete frame from a trusted transport observation. */
export function parseRestartDeliveryFrame(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > max + 256) throw new Error('invalid restart frame');
  const bytes = Buffer.from(text, 'utf8'), newline = bytes.indexOf(10);
  if (newline < 0 || newline > 160) throw new Error('invalid restart frame');
  const headerBytes = bytes.subarray(0, newline), headerText = headerBytes.toString('ascii');
  if (!Buffer.from(headerText, 'ascii').equals(headerBytes)) throw new Error('invalid restart frame');
  const header = headerText.match(/^AGENT-MESH-RESTART ([a-f0-9]{32}) ([1-9][0-9]*) ([a-f0-9]{64})$/);
  if (!header) throw new Error('invalid restart frame');
  const size = Number(header[2]), end = Buffer.from(`\nAGENT-MESH-RESTART-END ${header[1]}`);
  if (!Number.isSafeInteger(size) || size > max || bytes.length !== newline + 1 + size + end.length || !bytes.subarray(newline + 1 + size).equals(end)) throw new Error('incomplete restart frame');
  const body = bytes.subarray(newline + 1, newline + 1 + size);
  if (sha(body) !== header[3]) throw new Error('restart frame digest mismatch');
  let result;
  try { result = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body); } catch { throw new Error('invalid restart frame encoding'); }
  if (!Buffer.from(result, 'utf8').equals(body)) throw new Error('invalid restart frame encoding');
  return { schema: 'agent-mesh.restart-delivery-observation.v1', stateSha256: header[3], text: result };
}
