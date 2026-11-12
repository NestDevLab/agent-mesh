/** Deterministic link verification; native reads are injected and events remain replayable. */
import { sessionIdOf, parseSessionId, parseCloudSessionId, refDiffEvents } from './plexus.mjs';

export function linkTargets(graph, { session } = {}) {
  if (session !== undefined) {
    if (session.startsWith('claude-cloud:')) parseCloudSessionId(session);
    else session = parseSessionId(session);
  }
  const nodes = graph.nodes.filter(n => (n.catalogRole && n.catalogRole !== 'unclassified') || n.cloudIdentity)
    .filter(n => session === undefined || sessionIdOf(n) === session)
    .sort((a, b) => a.id.localeCompare(b.id));
  if (session !== undefined && !nodes.length) throw new Error('requested session has no classified catalog or cloud node');
  return nodes;
}
export function successor(graph, node) {
  const chain = [], seen = new Set();
  let session = sessionIdOf(node);
  while (session) {
    if (seen.has(session)) return { session, chain, error: 'successor-cycle' };
    seen.add(session); chain.push(session);
    const members = graph.nodes.filter(n => sessionIdOf(n) === session);
    if (!members.length) return { session, chain, error: 'successor-not-found' };
    const explicit = [...new Set(members.map(n => n.supersededBy).filter(Boolean))];
    const renewals = (graph.renewals || []).filter(r => r.from === session);
    const next = explicit.length ? explicit : renewals.length ? [renewals.at(-1).to] : [];
    if (next.length > 1) return { session, chain, error: 'ambiguous-successor' };
    if (!next.length) return { session, chain };
    session = next[0];
  }
  return { session, chain, error: 'session-identity-unavailable' };
}
function lastKnownLink(graph, node) {
  if (node.sessionLink?.link) return node.sessionLink.link;
  const refs = graph.migrated
    ? (graph.links || []).filter(l => l.session === sessionIdOf(node) && l.until === null)
      .sort((a, b) => String(b.since || '').localeCompare(String(a.since || '')) || String(a.id || a.ref).localeCompare(String(b.id || b.ref))).map(l => l.ref)
    : [...(node.refs || [])].sort();
  const ref = refs.find(r => /^session-link:session_[A-Za-z0-9]{1,128}$/.test(r));
  return ref ? `https://claude.ai/code/${ref.slice('session-link:'.length)}` : null;
}
export function verifyLinks(graph, observations, { apply = false, session, at = new Date().toISOString(), makeEvent } = {}) {
  const events = [], results = [], refSubjects = new Set();
  for (const node of linkTargets(graph, { session })) {
    const target = successor(graph, node);
    const observed = target.error ? { status: 'dead', reason: target.error } : observations[target.session] || { status: 'missing', reason: 'native-evidence-unavailable' };
    const prior = node.sessionLink;
    const link = observed.status === 'ok' ? observed.link || null : lastKnownLink(graph, node) || observed.link || null;
    const lastKnown = observed.status !== 'ok' && link !== null;
    const changed = observed.status === 'ok' && (prior?.link !== observed.link || prior?.resolvedSession !== target.session || prior?.status !== 'ok');
    const result = { nodeId: node.id, session: sessionIdOf(node), resolvedSession: target.session, role: node.catalogRole || 'unclassified', project: node.catalogProject || null, title: node.catalogTitle || node.title, ...observed, link, lastKnown, status: changed ? 'changed' : observed.status, chain: target.chain, previousLink: prior?.link || null };
    results.push(result);
    if (!apply) continue;
    const value = { link, lastKnown, resolvedSession: target.session, status: observed.status, source: observed.source || null, reason: observed.reason || null };
    events.push(makeEvent('node.upserted', { node: { ...node, sessionLink: { ...value, checkedAt: at, changedAt: !prior || Object.keys(value).some(k => prior[k] !== value[k]) ? at : prior.changedAt }, updatedAt: at } }));
    if (observed.status === 'ok' && observed.link) {
      const ref = node.agent === 'codex' || target.session.startsWith('codex:') ? `session-link:${target.session}` : `session-link:${observed.link.split('/').at(-1)}`;
      const subject = sessionIdOf(node);
      const currentRefs = graph.migrated ? (graph.links || []).filter(l => l.session === subject && l.until === null).map(l => l.ref) : node.refs || [];
      const refs = [...new Set([...currentRefs.filter(r => !r.startsWith('session-link:')), ref])];
      if (graph.migrated) {
        if (!refSubjects.has(subject)) events.push(...refDiffEvents(graph, subject, refs, makeEvent, 'reconciler'));
        refSubjects.add(subject);
      }
      else events[events.length - 1].node.refs = refs;
    }
  }
  return { events, result: { checkedAt: at, applied: apply, session: session || null, results } };
}
