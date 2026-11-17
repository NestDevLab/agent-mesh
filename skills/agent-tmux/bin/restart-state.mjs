import { createHash } from 'node:crypto';
/** Validate a parsed restart block; never execute its instructions. */
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const nonempty = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 8192 && !value.includes('\0');
const profileId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);

export function validateRoleProfile(profile) {
  if (!isObject(profile) || Object.keys(profile).sort().join(',') !== 'mcp,permissions,plugins,role,schema' || profile.schema !== 'agent-mesh.role-profile.v1' || !profileId(profile.role)) throw new Error('invalid role profile');
  for (const key of ['permissions', 'mcp', 'plugins']) {
    const values = profile[key];
    if (!Array.isArray(values) || values.length > 256 || !values.every(profileId) || new Set(values).size !== values.length) throw new Error(`invalid role profile ${key}`);
  }
  return true;
}

// Hash the validated identifier sets in a stable, order-independent form.
export function roleProfileDigest(profile) {
  validateRoleProfile(profile);
  const canonical = { schema: profile.schema, role: profile.role, permissions: [...profile.permissions].sort(), mcp: [...profile.mcp].sort(), plugins: [...profile.plugins].sort() };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function validateRestartState(block, { session, channel, requireRoleProfile = false } = {}) {
  if (!isObject(block) || block.schema !== 'agent-mesh.restart.v1') throw new Error('invalid restart schema');
  for (const field of ['session', 'channel', 'harness', 'working_directory']) {
    if (!nonempty(block[field])) throw new Error(`invalid restart ${field}`);
  }
  if (session !== undefined && block.session !== session) throw new Error('restart session mismatch');
  if (channel !== undefined && block.channel !== channel) throw new Error('restart channel mismatch');
  if (requireRoleProfile || block.role_profile !== undefined) validateRoleProfile(block.role_profile);
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
