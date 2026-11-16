import { createHash } from "node:crypto";

const NAME = /^[a-z][a-z0-9-]{0,63}$/;
const KEY = /^[a-z][a-z0-9_-]{0,63}$/;

// A batch is one event, so graph changes and its checkpoint commit together.
export function validateModuleBatch(name, batch, graph, sessionIdOf) {
  if (typeof name !== "string" || !NAME.test(name)) throw new Error("invalid module name");
  if (!batch || typeof batch !== "object" || Array.isArray(batch) || Object.keys(batch).some(k => !["id", "cursor", "nextCursor", "attributes", "events"].includes(k))) throw new Error("invalid module batch");
  if (typeof batch.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(batch.id)) throw new Error("invalid batch id");
  for (const c of [batch.cursor, batch.nextCursor]) if (!(c === null || (typeof c === "string" && c.length <= 4096))) throw new Error("invalid module cursor");
  if (batch.nextCursor === null) throw new Error("next cursor is required");
  if (!Array.isArray(batch.attributes) || batch.attributes.length > 200 || !Array.isArray(batch.events) || batch.events.length > 200) throw new Error("invalid batch contents");
  if (Buffer.byteLength(JSON.stringify(batch)) > 1024 * 1024) throw new Error("module batch too large");
  const seen = new Set();
  for (const attr of batch.attributes) {
    if (!attr || Object.keys(attr).some(k => !["session", "key", "value"].includes(k)) || typeof attr.session !== "string" || typeof attr.key !== "string" || !KEY.test(attr.key) || !Object.hasOwn(attr, "value")) throw new Error("invalid module attribute");
    if (graph.nodes.filter(node => sessionIdOf(node) === attr.session).length !== 1) throw new Error("unknown or ambiguous session");
    const identity = `${attr.session}\0${attr.key}`;
    if (seen.has(identity)) throw new Error("duplicate module attribute");
    seen.add(identity);
  }
  for (const ev of batch.events) {
    if (!ev || Object.keys(ev).some(k => !["type", "session", "data"].includes(k)) || typeof ev.type !== "string" || !ev.type.startsWith(`${name}.`) || !KEY.test(ev.type.slice(name.length + 1)) || typeof ev.session !== "string" || graph.nodes.filter(node => sessionIdOf(node) === ev.session).length !== 1 || !Object.hasOwn(ev, "data")) throw new Error("invalid namespaced event");
  }
  const digest = createHash("sha256").update(JSON.stringify(batch)).digest("hex");
  const previous = (graph.moduleStates || []).find(item => item.name === name);
  if (previous?.batchId === batch.id) {
    if (previous.digest !== digest) throw new Error("batch id reused with different contents");
    return { duplicate: true, digest };
  }
  if ((previous?.cursor ?? null) !== batch.cursor) throw new Error("module cursor conflict");
  return { duplicate: false, digest };
}

export function applyModuleBatch(state, event, sessionIdOf) {
  if (!state.moduleStates) state.moduleStates = new Map();
  for (const attr of event.batch.attributes) {
    const node = [...state.nodes.values()].find(item => sessionIdOf(item) === attr.session);
    if (!node) throw new Error("module batch names unknown session");
    const modules = { ...(node.moduleAttributes || {}) };
    modules[event.module] = { ...(Object.hasOwn(modules, event.module) ? modules[event.module] : {}), [attr.key]: attr.value };
    state.nodes.set(node.id, { ...node, moduleAttributes: modules });
  }
  state.moduleStates.set(event.module, { name: event.module, cursor: event.batch.nextCursor, batchId: event.batch.id, digest: event.digest });
}
