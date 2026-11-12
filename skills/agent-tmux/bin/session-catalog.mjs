/** Session labels and fenced singleton claims. The graph event log is authoritative. */
import { randomUUID } from 'node:crypto';
import { parseSessionId, parseCloudSessionId, sessionIdOf } from './plexus.mjs';

const SINGLETONS = new Set(['director', 'daily', 'holding-director', 'global-controller']);
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
export function parseCatalogSessionId(value) {
  if (typeof value === 'string' && value.startsWith('claude-cloud:')) {
    parseCloudSessionId(value);
    return value;
  }
  return parseSessionId(value);
}
function members(graph, session) {
  const nodes = graph.nodes.filter(node => sessionIdOf(node) === session);
  if (!nodes.length) throw new Error(`session not registered: ${session}`);
  return nodes;
}
/** Public metadata contract. Unknown archive state is intentionally visible. */
export function sessionMetadata(node) {
  return {
    title: node.catalogTitle || node.title || null,
    title_source: node.catalogTitle ? 'operator' : node.title ? 'native' : 'unavailable',
    catalog_status: node.catalogStatus || node.status || null,
    catalog_status_source: node.catalogStatus ? 'operator' : node.status ? 'graph-observation' : 'unavailable',
    activity_status: node.status || null,
    activity_status_source: node.status ? 'graph-observation' : 'unavailable',
    activity_observed_at: node.lastSeenAt || null,
    summary: node.summary || null,
    summary_source: node.summary ? (node.summarySource || 'legacy') : 'unavailable',
    summary_updated_at: node.summaryUpdatedAt || null,
    summary_freshness: !node.summary ? 'missing' : !node.summaryUpdatedAt ? 'unknown' :
      node.lifecycle?.lastHumanAt && Date.parse(node.lifecycle.lastHumanAt) > Date.parse(node.summaryUpdatedAt) ? 'stale' : 'current',
    last_activity_at: node.lastActivityAt || null,
    archived: typeof node.surface?.archived === 'boolean' ? node.surface.archived : null,
    archive_source: typeof node.surface?.archived === 'boolean' ? 'native' : 'unavailable',
  };
}
export function catalogMatches(row, options = {}) {
  const mode = options.archive || 'exclude';
  if (!['exclude', 'include', 'only'].includes(mode)) throw new Error('invalid archive filter');
  return (mode === 'include' || (mode === 'only' ? row.archived === true : row.archived !== true)) &&
    (!options.title || String(row.title || '').toLowerCase().includes(options.title.toLowerCase()));
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
    ...sessionMetadata(node), cwd: node.cwd || null, metadata_updated_at: node.updatedAt || null, last_seen_at: node.lastSeenAt || null, sessionId: session, runtime: node.agent, title: node.catalogTitle || node.title || `${node.agent} session ${session.split(':')[1].slice(0, 8)}`,
    titleSource: node.catalogTitle ? 'operator' : node.title ? 'native' : 'unavailable',
    role: node.catalogRole || 'unclassified', project: node.catalogProject || null,
    status: node.catalogStatus || node.status,
    ...(node.sessionLink ? { sessionLink: {
      link: node.sessionLink.link ?? null, status: node.sessionLink.status ?? null,
      lastKnown: node.sessionLink.lastKnown ?? null, checkedAt: node.sessionLink.checkedAt ?? null,
    } } : {}),
    claims: claims.filter(c => c.session === session).map(c => ({ ...c, status: claimState(c) })),
  })).filter(row => catalogMatches(row, options) && (!options.project || row.project === options.project) && (!options.role || row.role === options.role) && (!options.status || row.status === options.status)).sort((a,b) => a.sessionId.localeCompare(b.sessionId)) };
}
export function catalogUpdate(graph, session, options, makeEvent) {
  session = parseCatalogSessionId(session);
  const cloud = session.startsWith('claude-cloud:');
  if (cloud && ['agent', 'runtime-uuid', 'tmux-target', 'cwd', 'role-profile', 'summary', 'domains', 'domain', 'class'].some(key => options[key] !== undefined)) {
    throw new Error('cloud catalog supports role, project, title and status metadata only');
  }
  const nodes = members(graph, session);
  const role = options.role === undefined ? undefined : slug(options.role, 'role');
  const project = options.project === undefined ? undefined : slug(options.project, 'project');
  const summary = options.summary === undefined ? undefined : text(options.summary, 'summary');
  if (summary?.length > 240) throw new Error('summary must be at most 240 characters');
  const title = options.title === undefined ? undefined : text(options.title, 'title');
  if (options.status !== undefined && !['active','waiting','blocked','quiet','closed'].includes(options.status)) throw new Error('invalid catalog status');
  if (nodes.some(n => n.catalogStatus === 'superseded')) throw new Error('superseded sessions cannot be reclassified');
  // A label must never masquerade as a singleton grant, or move a granted role to another project.
  for (const node of cloud ? [] : nodes) {
    const targetRole = role ?? node.catalogRole;
    const targetProject = project ?? node.catalogProject;
    if (options['label-only'] && (graph.roleClaims || []).some(c => c.session === session && claimState(c) === 'active' && (c.role !== targetRole || c.project !== targetProject))) throw new Error('catalog label conflicts with own live claim');
    if (!options['label-only'] && SINGLETONS.has(targetRole) && !(graph.roleClaims || []).some(c => c.session === session && c.role === targetRole && c.project === targetProject && claimState(c) === 'active')) throw new Error('singleton labels require an active role claim');
  }
  const events = nodes.map(node => makeEvent('node.upserted', { node: { ...node,
    ...(role !== undefined ? { catalogRole: role } : {}), ...(project !== undefined ? { catalogProject: project } : {}),
    ...(summary !== undefined && summary !== node.summary ? { summary, summarySource: 'session', summaryUpdatedAt: new Date().toISOString() } : {}),
    ...(title !== undefined ? { catalogTitle: title, title } : {}), ...(options.status !== undefined ? { catalogStatus: options.status } : {}), updatedAt: new Date().toISOString(),
  } }));
  return { events, result: { session, changed: true } };
}

/** One append-only event commits each whole transition, including inherited graph relationships. */
export function roleOperation(graph, operation, options, makeEvent) {
  if (operation === 'list') return { events: [], result: { claims: (graph.roleClaims || []).filter(c => (!options.project || c.project === options.project) && (!options.role || c.role === options.role)).map(c => ({ ...c, status: claimState(c) })) } };
  const session = parseCatalogSessionId(options.session);
  const nodes = members(graph, session);
  const role = slug(options.role, 'role'), project = slug(options.project, 'project');
  const key = roleKey(role, project, session), at = new Date().toISOString();
  const active = (graph.roleClaims || []).find(c => c.key === key && c.status === 'active');
  const ttl = Number(options.ttl ?? DEFAULT_TTL);
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 86400) throw new Error('ttl must be 1..86400 seconds');
  if (operation === 'maintain') {
    if (role !== 'global-controller' || nodes.some(n => n.catalogStatus === 'superseded') ||
        !active || active.session !== session || active.id !== options['claim-id'] || claimState(active) !== 'active') {
      throw new Error('active global-controller token required for lease maintenance');
    }
    const projects = JSON.parse(options.input || '{}').projects;
    if (!Array.isArray(projects) || projects.some(p => typeof p !== 'string' || !SLUG.test(p))) throw new Error('maintain requires projects slugs');
    const events = (graph.roleClaims || []).filter(c => c.role === 'director' && projects.includes(c.project) &&
      claimState(c) === 'active' && !graph.nodes.some(n => sessionIdOf(n) === c.session && n.catalogStatus === 'superseded'))
      .map(c => makeEvent('role.changed', { claim: { ...c, heartbeatAt: at,
        expiresAt: new Date(Date.now() + c.ttl * 1000).toISOString() }, nodes: [], links: [], edges: [] }));
    return { events, result: { maintained: events.length } };
  }
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
