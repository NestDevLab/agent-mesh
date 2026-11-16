/** Validate a parsed restart block; never execute its instructions. */
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const nonempty = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 8192 && !value.includes('\0');

export function validateRestartState(block, { session, channel } = {}) {
  if (!isObject(block) || block.schema !== 'agent-mesh.restart.v1') throw new Error('invalid restart schema');
  for (const field of ['session', 'channel', 'harness', 'working_directory']) {
    if (!nonempty(block[field])) throw new Error(`invalid restart ${field}`);
  }
  if (session !== undefined && block.session !== session) throw new Error('restart session mismatch');
  if (channel !== undefined && block.channel !== channel) throw new Error('restart channel mismatch');
  if (!Array.isArray(block.skills) || block.skills.length > 256 || !block.skills.every(nonempty)) throw new Error('invalid restart skills');
  if (!Array.isArray(block.triggers) || block.triggers.length > 256) throw new Error('invalid restart triggers');
  const ids = new Set();
  for (const trigger of block.triggers) {
    if (!isObject(trigger) || !nonempty(trigger.id) || !nonempty(trigger.kind) || !isObject(trigger.config)) throw new Error('invalid restart trigger');
    const key = JSON.stringify([trigger.kind, trigger.id]);
    if (ids.has(key)) throw new Error('duplicate restart trigger');
    ids.add(key);
  }
  if (block.goal !== null && (!isObject(block.goal) || !nonempty(block.goal.objective) || !nonempty(block.goal.status))) throw new Error('invalid restart goal');
  return true;
}
