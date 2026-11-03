/** Session labels and fenced singleton claims. The graph event log is authoritative. */
import { randomUUID } from 'node:crypto';
import { parseSessionId, sessionIdOf } from './plexus.mjs';

const SINGLETONS = new Set(['director', 'daily', 'holding-director']);
const SLUG = /^[a-z][a-z0-9-]{0,63}$/;
export const DEFAULT_TTL = 4200;

function slug(value, name) {
  if (typeof value !== 'string' || !SLUG.test(value)) throw new Error(`${name} must be a lowercase slug`);
  return value;
}
function text(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\r\n\x00-\x1f]/.test(value)) throw new Error(`invalid ${name}`);
  return value.trim();
}
export function roleKey(role, project, session) {
  slug(role, 'role'); slug(project, 'project');
  return role === 'director' ? `${role}:${project}` : SINGLETONS.has(role) ? role : `${role}:${project}:${session}`;
}
export function claimState(claim, at = Date.now()) {
  return claim.status !== 'active' ? claim.status : Date.parse(claim.expiresAt) <= at ? 'stale' : 'active';
}
function members(graph, session) {
  const nodes = graph.nodes.filter(node => sessionIdOf(node) === session);
  if (!nodes.length) throw new Error(`session not registered: ${session}`);
  return nodes;
}
export function catalogList(graph, options = {}) {
  const grouped = new Map();
  for (const node of graph.nodes) {
    const session = sessionIdOf(node);
    if (!session) continue;
    const prior = grouped.get(session);
    if (!prior || String(node.updatedAt) > String(prior.updatedAt)) grouped.set(session, node);
  }
  const claims = graph.roleClaims || [];
  return { sessions: [...grouped].map(([session, node]) => ({
    sessionId: session, runtime: node.agent, title: node.catalogTitle || node.title,
    role: node.catalogRole || 'unclassified', project: node.catalogProject || null,
    status: node.catalogStatus || node.status,
    claims: claims.filter(c => c.session === session).map(c => ({ ...c, status: claimState(c) })),
  })).filter(row => (!options.project || row.project === options.project) && (!options.role || row.role === options.role) && (!options.status || row.status === options.status)).sort((a,b) => a.sessionId.localeCompare(b.sessionId)) };
}
export function catalogUpdate(graph, session, options, makeEvent) {
  session = parseSessionId(session);
  const nodes = members(graph, session);
  const role = options.role === undefined ? undefined : slug(options.role, 'role');
  const project = options.project === undefined ? undefined : slug(options.project, 'project');
  const title = options.title === undefined ? undefined : text(options.title, 'title');
  if (options.status !== undefined && !['active','waiting','blocked','quiet','closed'].includes(options.status)) throw new Error('invalid catalog status');
  if (nodes.some(n => n.catalogStatus === 'superseded')) throw new Error('superseded sessions cannot be reclassified');
  // A label must never masquerade as a singleton grant, or move a granted role to another project.
  for (const node of nodes) {
    const targetRole = role ?? node.catalogRole;
    const targetProject = project ?? node.catalogProject;
    if (SINGLETONS.has(targetRole) && !(graph.roleClaims || []).some(c => c.session === session && c.role === targetRole && c.project === targetProject && claimState(c) === 'active')) throw new Error('singleton labels require an active role claim');
  }
  const events = nodes.map(node => makeEvent('node.upserted', { node: { ...node,
    ...(role !== undefined ? { catalogRole: role } : {}), ...(project !== undefined ? { catalogProject: project } : {}),
    ...(title !== undefined ? { catalogTitle: title, title } : {}), ...(options.status !== undefined ? { catalogStatus: options.status } : {}), updatedAt: new Date().toISOString(),
  } }));
  return { events, result: { session, changed: true } };
}

/** One append-only event commits each whole transition, including inherited graph relationships. */
export function roleOperation(graph, operation, options, makeEvent) {
  if (operation === 'list') return { events: [], result: { claims: (graph.roleClaims || []).filter(c => (!options.project || c.project === options.project) && (!options.role || c.role === options.role)).map(c => ({ ...c, status: claimState(c) })) } };
  const session = parseSessionId(options.session);
  const nodes = members(graph, session);
  const role = slug(options.role, 'role'), project = slug(options.project, 'project');
  const key = roleKey(role, project, session), at = new Date().toISOString();
  const active = (graph.roleClaims || []).find(c => c.key === key && c.status === 'active');
  const ttl = Number(options.ttl ?? DEFAULT_TTL);
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 86400) throw new Error('ttl must be 1..86400 seconds');
  if (['heartbeat','release','check'].includes(operation)) {
    if (nodes.some(n => n.catalogStatus === 'superseded') || !active || active.session !== session || active.id !== options['claim-id'] || (operation !== 'release' && claimState(active) !== 'active')) throw new Error(`claim fenced or expired; current holder: ${active?.session || 'none'} claim: ${active?.id || 'none'}`);
    if (operation === 'check') return { events: [], result: { claim: active, valid: true } };
    const claim = { ...active, ...(operation === 'release' ? { status: 'released', releasedAt: at } : { heartbeatAt: at, expiresAt: new Date(Date.now() + active.ttl * 1000).toISOString() }) };
    return { events: [makeEvent('role.changed', { claim, nodes: [], links: [], edges: [] })], result: { claim, changed: true } };
  }
  if (operation !== 'claim') throw new Error('role operation must be claim, heartbeat, check, release or list');
  if (nodes.some(n => n.catalogStatus === 'superseded' || n.status === 'closed')) throw new Error('closed or superseded session cannot claim a role');
  if (active) {
    if (active.session === session && claimState(active) === 'active' && !options['take-over']) return { events: [], result: { claim: active, changed: false } };
    if (options['take-over'] !== active.id) throw new Error(`role held by ${active.session} claim ${active.id} (${claimState(active)}); explicit --take-over ${active.id} required`);
    text(options.reason, 'takeover reason');
  } else if (options['take-over']) throw new Error('takeover claim is no longer current');
  if ((graph.roleClaims || []).some(c => c.session === session && c.status === 'active' && c.key !== key)) throw new Error('session already holds another role; release it before changing role or project');
  const claim = { id: `claim-${randomUUID()}`, key, role, project, session, status: 'active', ttl, claimedAt: at, heartbeatAt: at, expiresAt: new Date(Date.now() + ttl * 1000).toISOString(), ...(active ? { predecessor: active.id, reason: options.reason } : {}) };
  const replacements = nodes.map(n => ({ ...n, catalogRole: role, catalogProject: project, catalogStatus: 'active', updatedAt: at }));
  const links = [], edges = [];
  if (active && active.session !== session) {
    const oldNodes = graph.nodes.filter(n => sessionIdOf(n) === active.session);
    const oldIds = new Set(oldNodes.map(n => n.id));
    replacements.push(...oldNodes.map(n => ({ ...n, catalogStatus: 'superseded', supersededBy: session, updatedAt: at })));
    for (const link of graph.links || []) if (link.session === active.session && link.until === null) {
      links.push({ ...link, until: at, closedBy: 'role-takeover' });
      if (!(graph.links || []).some(l => l.session === session && l.ref === link.ref && l.role === link.role && l.until === null)) links.push({ ...link, id: `link-${randomUUID()}`, session, since: at, inheritedFrom: link.id });
    }
    for (const edge of graph.edges) if (!edge.endedAt && (oldIds.has(edge.from) || oldIds.has(edge.to))) {
      edges.push({ ...edge, endedAt: at, endedBy: 'role-takeover' });
      const from = oldIds.has(edge.from) ? nodes[0].id : edge.from, to = oldIds.has(edge.to) ? nodes[0].id : edge.to;
      if (from !== to && !graph.edges.some(e => !e.endedAt && e.from === from && e.to === to && e.type === edge.type)) edges.push({ ...edge, id: `edge-${randomUUID()}`, from, to, createdAt: at, inheritedFrom: edge.id });
    }
  }
  return { events: [makeEvent('role.changed', { claim, ...(active ? { previous: { ...active, status: active.session === session ? 'renewed' : 'superseded', supersededBy: claim.id, endedAt: at, staleAtTakeover: claimState(active) === 'stale' } } : {}), nodes: replacements, links, edges })], result: { claim, changed: true } };
}
