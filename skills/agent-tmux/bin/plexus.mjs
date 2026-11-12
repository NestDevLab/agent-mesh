/**
 * Plexus: session <-> ledger links, neighbours, resume info and the change feed,
 * derived from the mesh-graph event stream. Pure functions; mesh-graph.mjs owns I/O.
 * Contract: docs/design/plexus.md.
 */

import { createHmac, randomUUID } from "node:crypto";
import { posix } from "node:path";
import { createHash } from "node:crypto";
import {
  LEDGER_VIEW_SCHEMA, LEDGER_VIEW_SORT, buildLedgerViewRows,
  ledgerViewProfileRevision, ledgerViewValue, validateLedgerViewProfile
} from "./ledger-view.mjs";
export { renderLedgerView, ledgerViewProfileRevision, validateLedgerViewProfile } from "./ledger-view.mjs";

export const LINK_ROLES = new Set(["owns", "works-on", "reviews", "coordinates", "discusses", "observes", "mentioned"]);
export const LINK_SOURCES = /^(bridge-launch|hook|ledger-write|reconciler|operator|legacy-node-refs|ui:[A-Za-z0-9._:-]{1,128}|hook:[a-z-]{1,32})$/;
export const ROLE_WEIGHTS = { owns: 1, "works-on": 1, coordinates: 0.8, reviews: 0.7, discusses: 0.6, observes: 0.3, mentioned: 0.2 };
export const HALF_LIFE_DAYS = 7;
export const TOUCH_COALESCE_MS = 10 * 60 * 1000;
export const PLEXUS_EVENTS = new Set(["role.changed", "link.opened", "link.touched", "link.closed", "link.resolved", "edge.ended", "session.renewed", "store.migrated"]);
const HARNESSES = new Set(["codex", "claude"]);
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const SESSION_ID = /^(codex|claude):[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const CLOUD_SESSION_ID = /^(claude-cloud):([a-z][a-z0-9-]{0,63}):((?:session|cse)_[A-Za-z0-9]{1,128})$/;
const LIVE_ATTENTION = ["working", "waiting-user", "waiting-joseph"];

export function hostLabel() {
  return process.env.MESH_PLEXUS_HOST || "local";
}

export function isHarness(agent) {
  return HARNESSES.has(agent);
}

export function sessionIdOf(node) {
  if (node?.cloudIdentity || node?.origin === "cloud") return cloudSessionIdOf(node);
  return node && HARNESSES.has(node.agent) && UUID.test(node.runtimeUuid || "") ? `${node.agent}:${node.runtimeUuid.toLowerCase()}` : null;
}

export function parseCloudSessionId(value) {
  const match = typeof value === "string" && CLOUD_SESSION_ID.exec(value);
  if (!match || match[0] !== value) throw new Error("session must be claude-cloud:<account-scope>:<exact cloud ID>");
  return { provider: match[1], accountScope: match[2], nativeId: match[3] };
}

export function cloudSessionIdOf(node) {
  const { provider, accountScope, nativeId } = node?.cloudIdentity || {};
  if (node?.origin !== "cloud" || ![provider, accountScope, nativeId].every((value) => typeof value === "string")) return null;
  const value = `${provider}:${accountScope}:${nativeId}`;
  return CLOUD_SESSION_ID.exec(value)?.[0] === value ? value : null;
}

function isCloudSessionId(value) {
  return typeof value === "string" && value.startsWith("claude-cloud:");
}

function parseGraphSessionId(value) {
  if (!isCloudSessionId(value)) return parseSessionId(value);
  parseCloudSessionId(value);
  return value;
}

export function linkSubject(node) {
  return sessionIdOf(node) || `pending:${node.id}`;
}

export function parseSessionId(value) {
  if (typeof value !== "string" || !SESSION_ID.test(value.toLowerCase())) throw new Error("session must be <codex|claude>:<uuid>");
  return value.toLowerCase();
}

export function validateLink(link) {
  if (!link || typeof link !== "object") throw new Error("link event is missing a link");
  for (const key of ["id", "session", "ref", "role", "since", "source"]) {
    if (typeof link[key] !== "string") throw new Error(`link '${link.id || "?"}' has invalid ${key}`);
  }
  if (!LINK_ROLES.has(link.role)) throw new Error(`link '${link.id}' has invalid role`);
  if (!(link.until === null || typeof link.until === "string")) throw new Error(`link '${link.id}' has invalid until`);
}

/** Applies one Plexus event to the mutable projection state and returns its effects for the feed. */
export function applyPlexusEvent(state, item) {
  const effects = [];
  const openLinks = () => [...state.links.values()].filter((link) => link.until === null);
  switch (item.type) {
    case "role.changed":
      if (!state.roleClaims) state.roleClaims = new Map();
      if (item.previous) state.roleClaims.set(item.previous.id, item.previous);
      state.roleClaims.set(item.claim.id, item.claim);
      for (const node of item.nodes) {
        const previous = state.nodes.get(node.id);
        const id = sessionIdOf(node);
        if (id) effects.push({ kind: "session.updated", session: id, lastKnown: previous ? { cwd: previous.cwd, domains: previous.domains, harness: previous.agent } : null });
        state.nodes.set(node.id, node);
      }
      for (const link of item.links) {
        const prior = state.links.get(link.id);
        state.links.set(link.id, link);
        if (link.until !== null && prior?.until === null) effects.push({ kind: "link.ended", link });
        else if (link.until === null) effects.push({ kind: "link.added", link });
      }
      for (const edge of item.edges) {
        state.edges.set(edge.id, edge);
        effects.push({ kind: edge.endedAt ? "edge.ended" : "edge.added", edge });
      }
      break;
    case "link.opened":
      validateLink(item.link);
      state.links.set(item.link.id, item.link);
      effects.push({ kind: "link.added", link: item.link });
      break;
    case "link.touched": {
      const link = state.links.get(item.linkId);
      if (!link) throw new Error(`link.touched names unknown link ${item.linkId}`);
      state.links.set(link.id, { ...link, lastActivityAt: maxTime(link.lastActivityAt, item.at), evidence: union(link.evidence, item.evidence) });
      break;
    }
    case "link.closed": {
      const link = state.links.get(item.linkId);
      if (!link) throw new Error(`link.closed names unknown link ${item.linkId}`);
      if (link.until !== null) break;
      const closed = { ...link, until: item.at, ...(item.closedBy ? { closedBy: item.closedBy } : {}) };
      state.links.set(link.id, closed);
      effects.push({ kind: "link.ended", link: closed });
      break;
    }
    case "link.resolved":
      for (const link of openLinks().filter((candidate) => candidate.session === item.from)) {
        const target = openLinks().find((other) => other.session === item.to && other.ref === link.ref && other.role === link.role);
        if (target) {
          state.links.set(target.id, {
            ...target,
            since: minTime(target.since, link.since),
            lastActivityAt: maxTime(target.lastActivityAt, link.lastActivityAt),
            evidence: union(target.evidence, link.evidence),
          });
          state.links.set(link.id, { ...link, until: item.at, mergedInto: target.id });
        } else {
          const resolved = { ...link, session: item.to, resolvedFrom: item.from };
          state.links.set(link.id, resolved);
          effects.push({ kind: "link.added", link: resolved });
        }
      }
      break;
    case "edge.ended": {
      const edge = state.edges.get(item.edgeId);
      if (!edge) throw new Error(`edge.ended names unknown edge ${item.edgeId}`);
      if (edge.endedAt) break;
      const ended = { ...edge, endedAt: item.at, ...(item.source ? { endedBy: item.source } : {}) };
      state.edges.set(edge.id, ended);
      effects.push({ kind: "edge.ended", edge: ended });
      break;
    }
    case "session.renewed":
      state.renewals.push({ from: parseSessionId(item.from), to: parseSessionId(item.to), at: item.at });
      effects.push({ kind: "session.renewed", from: item.from, to: item.to });
      break;
    case "store.migrated":
      state.migrated = true;
      break;
    default:
      throw new Error(`unsupported event type '${item.type}'`);
  }
  return effects;
}

/** node.refs is a derived projection of open links once the store is migrated. */
export function projectNodeRefs(nodes, links) {
  const bySubject = new Map();
  for (const link of links) {
    if (link.until !== null) continue;
    if (!bySubject.has(link.session)) bySubject.set(link.session, new Set());
    bySubject.get(link.session).add(link.ref);
  }
  return nodes.map((node) => {
    const refs = new Set([...(bySubject.get(sessionIdOf(node)) || []), ...(bySubject.get(`pending:${node.id}`) || [])]);
    return { ...node, refs: [...refs].sort() };
  });
}

/** Link events that move a subject's open refs to `desired`, the legacy `--refs` / `ref add|remove` contract. */
export function refDiffEvents(graph, subjects, desired, makeEvent, source = "operator") {
  const list = Array.isArray(subjects) ? subjects : [subjects];
  const subject = list[0];
  const open = graph.links.filter((link) => list.includes(link.session) && link.until === null);
  const events = [];
  for (const ref of desired) {
    if (open.some((link) => link.ref === ref)) continue;
    events.push(makeEvent("link.opened", { link: newLink({ session: subject, ref, role: "works-on", source }) }));
  }
  for (const link of open) if (!desired.includes(link.ref)) events.push(makeEvent("link.closed", { linkId: link.id, closedBy: source }));
  return events;
}

export function newLink({ session, ref, role, source, title, evidence, createdBy, at }) {
  const timestamp = at || new Date().toISOString();
  return {
    id: `link-${randomUUID()}`,
    session, ref, role, since: timestamp, until: null, source,
    lastActivityAt: null, evidence: evidence ? [...new Set(evidence)] : [],
    host: hostLabel(),
    ...(title ? { title } : {}),
    ...(createdBy ? { createdBy } : {}),
  };
}

// ---------------------------------------------------------------------------
// Sessions and scope

export function sessionIndex(graph) {
  const groups = new Map();
  for (const node of graph.nodes) {
    const id = sessionIdOf(node);
    if (!id) continue;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(node);
  }
  const sessions = new Map();
  for (const [id, nodes] of groups) {
    nodes.sort((a, b) => String(b.lastSeenAt || b.updatedAt).localeCompare(String(a.lastSeenAt || a.updatedAt)) || a.id.localeCompare(b.id));
    const newest = nodes[0];
    sessions.set(id, {
      sessionId: id,
      harness: newest.agent,
      nativeId: newest.cloudIdentity ? newest.cloudIdentity.nativeId : newest.runtimeUuid.toLowerCase(),
      ...(newest.cloudIdentity ? { cloudIdentity: newest.cloudIdentity } : {}),
      nodeIds: nodes.map((node) => node.id).sort(),
      cwd: newest.cwd,
      title: newest.catalogTitle || newest.title,
      role: newest.catalogRole || "unclassified", project: newest.catalogProject || null,
      catalogStatus: newest.cloudIdentity && newest.status !== "closed" ? "registered" : newest.catalogStatus || newest.status,
      status: newest.cloudIdentity && newest.status !== "closed" ? null : newest.status,
      attention: nodes.map((node) => node.attention).find((item) => item && LIVE_ATTENTION.includes(item.state)) || newest.attention || null,
      lifecycle: newest.lifecycle || null,
      class: newest.class, origin: newest.origin, surface: newest.surface || {},
      domains: [...new Set(nodes.flatMap((node) => node.domains || []))].sort(),
      lastSeenAt: newest.cloudIdentity ? null : newest.lastSeenAt || newest.updatedAt,
      archived: nodes.some((node) => node.surface?.archived === true),
      resumable: newest.resumable,
      resumabilityReasons: newest.resumabilityReasons || [],
    });
  }
  return sessions;
}

/**
 * Scope for one gateway principal (one UI Space). `null` means the local operator view.
 * { refPrefixes: string[], targets: [{ id, harness, roots: string[], domains?: string[] }], handleKey: string }
 */
export function makeScope(scope) {
  if (scope === null || scope === undefined) {
    return { scoped: false, refVisible: () => true, target: () => null, handle: (id) => id };
  }
  if (typeof scope !== "object") throw new Error("scope must be an object");
  const prefixes = Array.isArray(scope.refPrefixes) ? scope.refPrefixes.filter((item) => typeof item === "string" && item) : [];
  const targets = Array.isArray(scope.targets) ? scope.targets : [];
  if (typeof scope.handleKey !== "string" || scope.handleKey.length < 16) throw new Error("scope.handleKey must be at least 16 characters");
  const clean = (path) => typeof path === "string" && path.startsWith("/") ? posix.resolve(path) : null;
  const within = (cwd, root) => {
    const [left, right] = [clean(cwd), clean(root)];
    return left !== null && right !== null && (left === right || left.startsWith(right === "/" ? "/" : `${right}/`));
  };
  return {
    scoped: true,
    refVisible: (ref) => prefixes.some((prefix) => ref.startsWith(prefix)),
    target: (session) => {
      if (!session || session.cloudIdentity) return undefined;
      const match = targets.find((target) => target && target.harness === session.harness &&
        (target.roots || []).some((root) => within(session.cwd, root)) &&
        (!Array.isArray(target.domains) || target.domains.some((domain) => session.domains.includes(domain))));
      return match ? match.id : undefined;
    },
    handle: (id) => `h-${createHmac("sha256", scope.handleKey).update(id).digest("hex").slice(0, 24)}`,
  };
}

function visible(view, session) {
  return session !== undefined && view.target(session) !== undefined;
}

function sessionView(view, session, sessionId) {
  if (!session || !visible(view, session)) {
    return { handle: view.handle(sessionId), harness: session?.harness || sessionId.split(":")[0], redacted: true };
  }
  const target = view.target(session);
  return {
    sessionId: session.sessionId, harness: session.harness, nativeId: session.nativeId, host: hostLabel(),
    title: session.title, cwd: session.cwd, status: session.status, attention: session.attention?.state || null,
    lastSeenAt: session.lastSeenAt, domains: session.domains,
    // Detailed transcript facts remain local; scoped gateway queries keep their existing DTO.
    ...(!view.scoped ? { lifecycle: session.lifecycle, archived: session.archived,
      resumable: session.resumable, resumabilityReasons: session.resumabilityReasons,
      role: session.role, project: session.project, catalogStatus: session.catalogStatus,
      class: session.class, origin: session.origin, surface: session.surface, nodeIds: session.nodeIds,
      ...(session.cloudIdentity ? { cloudIdentity: session.cloudIdentity } : {}) } : {}), ...(target ? { target } : {}),
  };
}

function linkView(link) {
  return {
    id: link.id, session: link.session, ref: link.ref, role: link.role, since: link.since, until: link.until,
    source: link.source, lastActivityAt: link.lastActivityAt, host: link.host || hostLabel(),
    ...(link.title ? { title: link.title } : {}),
  };
}

function context(graph, scope) {
  const view = makeScope(scope);
  const sessions = sessionIndex(graph);
  const links = graph.links.filter((link) => !link.session.startsWith("pending:") &&
    (!view.scoped || !isCloudSessionId(link.session)) && view.refVisible(link.ref));
  // A ref is shown only if the principal sees at least one session linked to it.
  const shownRefs = new Set(links.filter((link) => visible(view, sessions.get(link.session))).map((link) => link.ref));
  return { view, sessions, links: links.filter((link) => shownRefs.has(link.ref)), shownRefs };
}

function notFound() {
  return new Error("not found");
}

// ---------------------------------------------------------------------------
// Queries Q1-Q6

export function ledgerSessions(graph, input = {}, scope = null) {
  const ctx = context(graph, scope);
  if (input.launchId !== undefined) return { sessions: [] };
  const refs = [input.ref, ...(input.descendantRefs || [])].filter((ref) => typeof ref === "string" && ctx.shownRefs.has(ref));
  const roles = Array.isArray(input.roles) ? new Set(input.roles) : null;
  const grouped = new Map();
  for (const link of ctx.links) {
    if (!refs.includes(link.ref) || (roles && !roles.has(link.role)) || (!input.history && link.until !== null)) continue;
    if (!grouped.has(link.session)) grouped.set(link.session, []);
    grouped.get(link.session).push(link);
  }
  const sessions = [...grouped].sort(([a], [b]) => a.localeCompare(b)).map(([id, links]) => {
    const session = ctx.sessions.get(id);
    const item = sessionView(ctx.view, session, id);
    return item.redacted ? item : { ...item, links: links.map(linkView) };
  });
  return { refs, sessions };
}

// ---------------------------------------------------------------------------
// Work items: the ledgers own every field, the graph only adds who works on what.

const CLOSED_ITEM_STATUSES = new Set(["done", "cancelled", "deleted"]);
const DEFAULT_ITEM_SORT = ["due:asc", "priority:asc", "size:asc"];
const ITEM_SORT_KEY = /^([A-Za-z0-9._-]{1,128})(?::(asc|desc))?$/;
const ITEM_FILTER_OPERATORS = new Set(["eq", "ne", "in", "lt", "lte", "gt", "gte", "contains", "exists"]);
const ITEM_COLLATOR = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

function itemValue(item, field) {
  if (field === "sessions") return item.sessions.length;
  if (field === "groups") return item.groups.join(",") || undefined;
  const value = item.fields?.[field] ?? item[field];
  return value === "" || value === null || typeof value === "object" ? undefined : value;
}

function compareItemValues(a, b) {
  if (Array.isArray(a)) a = a.map(String).join("\u0000");
  if (Array.isArray(b)) b = b.map(String).join("\u0000");
  if (typeof a === "string" && typeof b === "string") return ITEM_COLLATOR.compare(a, b);
  if (typeof a === typeof b) return Number(a) - Number(b);
  // Ranked values sort before anything an adapter could not rank.
  if (typeof a === "number") return -1;
  if (typeof b === "number") return 1;
  return ITEM_COLLATOR.compare(String(a), String(b));
}

function parseItemSort(sort = DEFAULT_ITEM_SORT, arbitraryFields = false) {
  const keys = typeof sort === "string" ? sort.split(",") : sort;
  if (!Array.isArray(keys) || !keys.length || keys.length > 8) throw new Error("sort must list 1 to 8 fields");
  return keys.map((key) => {
    const match = typeof key === "string" && (arbitraryFields ? /^(.*?)(?::(asc|desc))?$/.exec(key.trim()) : ITEM_SORT_KEY.exec(key.trim()));
    if (arbitraryFields && match) ledgerViewValue({}, match[1]);
    if (!match) throw new Error("sort entries must be field or field:asc|desc");
    return { field: match[1], direction: match[2] || "asc" };
  });
}

function compareItems(keys, valueOf = itemValue) {
  return (a, b) => {
    for (const { field, direction } of keys) {
      const [x, y] = [a, b].map((item) => item.sortKeys?.[field] ?? valueOf(item, field));
      // Missing values stay last in both directions, otherwise desc would lead with blanks.
      if (x === undefined || y === undefined) {
        if (x !== y) return x === undefined ? 1 : -1;
        continue;
      }
      const order = compareItemValues(x, y);
      if (order) return direction === "desc" ? -order : order;
    }
    const order = ITEM_COLLATOR.compare(a.ref, b.ref);
    if (order || a.ref === b.ref) return order;
    return a.ref < b.ref ? -1 : 1;
  };
}

function checkItemFilter(filter) {
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) throw new Error("filter must be an object");
  for (const condition of Object.values(filter)) {
    if (!condition || typeof condition !== "object" || Array.isArray(condition)) continue;
    for (const operator of Object.keys(condition)) {
      if (!ITEM_FILTER_OPERATORS.has(operator)) throw new Error(`unknown filter operator '${operator}'`);
    }
  }
  return filter;
}

function matchesItemFilter(item, field, condition, valueOf = itemValue) {
  const value = valueOf(item, field);
  const values = Array.isArray(value) ? value : [value];
  const same = (expected) => values.some(entry => entry !== undefined && String(entry) === String(expected));
  if (Array.isArray(condition)) return condition.some(same);
  if (condition === null || typeof condition !== "object") return same(condition);
  const range = (operand, compare) => values.some(entry => entry !== undefined && compare(compareItemValues(entry, operand)));
  return Object.entries(condition).every(([operator, operand]) => ({
    eq: () => same(operand),
    ne: () => !same(operand),
    in: () => Array.isArray(operand) && operand.some(same),
    lt: () => range(operand, order => order < 0),
    lte: () => range(operand, order => order <= 0),
    gt: () => range(operand, order => order > 0),
    gte: () => range(operand, order => order >= 0),
    contains: () => values.some(entry => entry !== undefined && String(entry).toLowerCase().includes(String(operand).toLowerCase())),
    exists: () => (value !== undefined) === Boolean(operand),
  })[operator]());
}

function itemSessionView(link, sessions, remoteSessions) {
  const session = sessions.get(link.session);
  const nativeId = session?.nativeId || link.session.split(":").at(-1);
  const remote = session?.cloudIdentity?.nativeId || (session?.harness === "claude" ? remoteSessions[nativeId] : null);
  return {
    session: link.session, role: link.role, harness: session?.harness || link.session.split(":")[0], nativeId,
    title: session?.title ?? null, status: session?.status ?? null,
    ...(remote ? { url: `https://claude.ai/code/${remote.replace(/^cse_/, "session_")}` } : {}),
  };
}

/** `read` is called once the input is known to be valid and returns {items, errors, remoteSessions}. */
export function workItems(graph, input = {}, scope = null, read) {
  if (scope) throw new Error("work items are available to local callers only");
  const sort = parseItemSort(input.sort);
  const filter = checkItemFilter(input.filter ?? {});
  if (input.limit !== undefined && !(Number.isInteger(input.limit) && input.limit > 0)) throw new Error("limit must be a positive integer");
  const { items, errors = [], remoteSessions = {} } = read();
  const ctx = context(graph);
  const live = ctx.links.filter((link) => link.until === null);
  const roleOrder = [...LINK_ROLES];
  const groupsOf = new Map();
  const linksOf = new Map();
  for (const link of live) {
    if (link.ref.startsWith("group:")) groupsOf.set(link.session, [...(groupsOf.get(link.session) || []), link.ref]);
    linksOf.set(link.ref, [...(linksOf.get(link.ref) || []), link]);
  }
  const joined = items.map(({ sessions: _declared, ...item }) => {
    const links = (linksOf.get(item.ref) || []).sort((a, b) =>
      roleOrder.indexOf(a.role) - roleOrder.indexOf(b.role) || a.session.localeCompare(b.session));
    const groups = [...new Set(links.flatMap((link) => groupsOf.get(link.session) || []))].sort();
    return { ...item, sessions: links.map((link) => itemSessionView(link, ctx.sessions, remoteSessions)), groups };
  });
  const matched = joined
    .filter((item) => "status" in filter || input.includeClosed || !CLOSED_ITEM_STATUSES.has(item.status))
    .filter((item) => Object.entries(filter).every(([field, condition]) => matchesItemFilter(item, field, condition)))
    .sort(compareItems(sort));
  const shown = input.limit ? matched.slice(0, input.limit) : matched;
  return {
    total: matched.length, count: shown.length, sort: sort.map(({ field, direction }) => `${field}:${direction}`),
    items: shown.map(({ sortKeys: _ranks, ...item }) => item), errors,
  };
}

function validateViewInput(input, profile) {
  validateLedgerViewProfile(profile);
  const sort = parseItemSort(input.sort ?? LEDGER_VIEW_SORT, true);
  const filter = checkItemFilter(input.filter ?? {});
  for (const field of [...sort.map(key => key.field), ...Object.keys(filter)]) ledgerViewValue({}, field);
  if (input.limit !== undefined && !(Number.isInteger(input.limit) && input.limit > 0)) throw new Error("limit must be a positive integer");
  if (input.fallback !== undefined && !["director", "project"].includes(input.fallback)) throw new Error("Invalid app thread fallback.");
  return { sort, filter };
}

/** The view reuses the same joins, filter operators and comparator as query items. */
export function ledgerView(graph, input = {}, scope = null, read, profile = {}) {
  if (scope) throw new Error("ledger views are available to local callers only");
  validateViewInput(input, profile);
  const source = read();
  const includeClosed = input.includeClosed || Object.hasOwn(input.filter ?? {}, "status") || Object.hasOwn(input.filter ?? {}, "state");
  const joined = workItems(graph, { includeClosed }, null, () => source);
  return ledgerViewRows({ ...joined, sourceItems: source.items, groupMetadata: source.groups,
    graphRevision: graph.lastSeq ?? null, groupsRevision: source.groupsRevision ?? null }, input, profile);
}

/** Accepts already joined records for deterministic historical fixture replay. */
export function ledgerViewRows(joined, input = {}, profile = {}) {
  const { sort, filter } = validateViewInput(input, profile);
  const rows = buildLedgerViewRows(joined.items, profile, { groups: joined.groupMetadata ?? [],
    sourceItems: joined.sourceItems ?? joined.items, fallback: input.fallback ?? "director" });
  const excluded = new Set(input.includeClosed || Object.hasOwn(filter, "state") || Object.hasOwn(filter, "status") ? [] : profile.excludeStates ?? []);
  const matched = rows.filter(row => !excluded.has(row.state))
    .filter(row => Object.entries(filter).every(([field, condition]) => matchesItemFilter(row, field, condition, ledgerViewValue)))
    .sort(compareItems(sort, ledgerViewValue));
  const shown = input.limit === undefined ? matched : matched.slice(0, input.limit);
  const summary = { sourceItems: rows.length, excludedItems: rows.length - matched.length,
    waitingItems: matched.filter(row => row.waitingOnOwner === true).length,
    otherItems: matched.filter(row => row.waitingOnOwner !== true).length,
    withThread: matched.filter(row => ["item", "session"].includes(row.thread.resolution)).length,
    withoutThread: matched.filter(row => !["item", "session"].includes(row.thread.resolution)).length };
  for (const reason of ["unassigned", "native-only", "session-closed", "app-thread-unmapped"]) {
    summary[reason] = matched.filter(row => row.thread.missingReason === reason).length;
  }
  const result = { schema: LEDGER_VIEW_SCHEMA, profile_revision: ledgerViewProfileRevision(profile),
    graph_revision: joined.graphRevision ?? null, groups_revision: joined.groupsRevision ?? null,
    sort: sort.map(key => `${key.field}:${key.direction}`), total: matched.length, count: shown.length,
    summary, items: shown.map(({ sortKeys, ...row }) => row), errors: joined.errors ?? [] };
  return { ...result, result_revision: "sha256:" + createHash("sha256").update(JSON.stringify(result)).digest("hex") };
}

export function sessionLedgers(graph, input = {}, scope = null) {
  const ctx = context(graph, scope);
  if (input.launchId !== undefined) return { links: [] };
  const id = parseGraphSessionId(input.session);
  const session = ctx.sessions.get(id);
  if (scope && !visible(ctx.view, session)) throw notFound();
  const links = ctx.links.filter((link) => link.session === id && (input.history || link.until === null));
  return { session: session ? sessionView(ctx.view, session, id) : { sessionId: id }, links: links.map(linkView) };
}

function decay(time, nowMs, halfLifeDays) {
  const age = Math.max(0, nowMs - Date.parse(time));
  return 0.5 ** (age / (halfLifeDays * 86_400_000));
}

function lineageEdges(graph, history, includeCloud) {
  const sessionOfNode = new Map(graph.nodes.map((node) => [node.id, sessionIdOf(node)]));
  return graph.edges.flatMap((edge) => {
    if (!history && edge.endedAt) return [];
    const from = sessionOfNode.get(edge.from), to = sessionOfNode.get(edge.to);
    if (!includeCloud && (isCloudSessionId(from) || isCloudSessionId(to))) return [];
    return from && to && from !== to ? [{ id: edge.id, from, to, type: edge.type, endedAt: edge.endedAt || null }] : [];
  });
}

function scoreFrom(ctx, graph, id, options) {
  const { nowMs, history, kinds, weights, halfLifeDays } = options;
  const useLedger = !kinds || kinds.has("ledger");
  const strongest = (session) => {
    const byRef = new Map();
    for (const link of ctx.links) {
      if (link.session !== session || (!history && link.until !== null)) continue;
      const weight = weights[link.role] ?? 0;
      const activity = link.lastActivityAt || link.since;
      const current = byRef.get(link.ref);
      byRef.set(link.ref, current
        ? { weight: Math.max(current.weight, weight), activity: maxTime(current.activity, activity) }
        : { weight, activity });
    }
    return byRef;
  };
  const mine = strongest(id);
  const results = new Map();
  const entry = (other) => {
    if (!results.has(other)) results.set(other, { score: 0, refs: [], edges: [] });
    return results.get(other);
  };
  if (useLedger) {
    const others = new Set(ctx.links.filter((link) => mine.has(link.ref) && link.session !== id).map((link) => link.session));
    for (const other of others) {
      const theirs = strongest(other);
      for (const [ref, a] of mine) {
        const b = theirs.get(ref);
        if (!b) continue;
        const factor = decay(minTime(a.activity, b.activity), nowMs, halfLifeDays);
        const contribution = a.weight * b.weight * factor;
        const item = entry(other);
        item.score += contribution;
        item.refs.push({ ref, weight: a.weight, otherWeight: b.weight, decay: round(factor), contribution: round(contribution) });
      }
    }
  }
  for (const edge of lineageEdges(graph, history, !ctx.view.scoped)) {
    if (kinds && !kinds.has(edge.type)) continue;
    const other = edge.from === id ? edge.to : edge.to === id ? edge.from : null;
    if (!other) continue;
    const item = entry(other);
    item.score += 0.5;
    item.edges.push({ id: edge.id, type: edge.type, direction: edge.from === id ? "out" : "in" });
  }
  return results;
}

export function neighbours(graph, input = {}, scope = null, config = {}) {
  const ctx = context(graph, scope);
  const id = parseGraphSessionId(input.session);
  if (scope && !visible(ctx.view, ctx.sessions.get(id))) throw notFound();
  const depth = input.depth === undefined ? 1 : Number(input.depth);
  if (depth !== 1 && depth !== 2) throw new Error("depth must be 1 or 2");
  const options = {
    nowMs: Date.now(), history: input.history === true,
    kinds: Array.isArray(input.edgeKinds) ? new Set(input.edgeKinds) : null,
    weights: { ...ROLE_WEIGHTS, ...(config.weights || {}) }, halfLifeDays: config.halfLifeDays || HALF_LIFE_DAYS,
  };
  const first = scoreFrom(ctx, graph, id, options);
  const found = new Map([...first].map(([other, item]) => [other, { ...item, depth: 1 }]));
  if (depth === 2) {
    for (const [middle, viaScore] of first) {
      if (!visible(ctx.view, ctx.sessions.get(middle)) && scope) continue;
      for (const [other, item] of scoreFrom(ctx, graph, middle, options)) {
        if (other === id || first.has(other)) continue;
        const score = viaScore.score * item.score;
        if (score > (found.get(other)?.score ?? 0)) found.set(other, { score, refs: item.refs, edges: item.edges, depth: 2, via: middle });
      }
    }
  }
  const result = [...found].map(([other, item]) => {
    const session = sessionView(ctx.view, ctx.sessions.get(other), other);
    if (session.redacted) return session;
    const base = { ...session, depth: item.depth, score: round(item.score) };
    return { ...base, breakdown: { refs: item.refs, edges: item.edges }, ...(item.via ? { via: item.via } : {}) };
  });
  result.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || String(a.sessionId || a.handle).localeCompare(String(b.sessionId || b.handle)));
  return { session: id, depth, neighbours: result };
}

export function subgraph(graph, input = {}, scope = null) {
  const ctx = context(graph, scope);
  const depth = input.depth === undefined ? 1 : Number(input.depth);
  if (![0, 1, 2].includes(depth)) throw new Error("depth must be 0, 1 or 2");
  const refs = (input.refs || []).filter((ref) => ctx.shownRefs.has(ref));
  const seeds = new Set(ctx.links.filter((link) => refs.includes(link.ref) && link.until === null).map((link) => link.session));
  for (const value of input.sessions || []) {
    const id = parseGraphSessionId(value);
    if (!scope || visible(ctx.view, ctx.sessions.get(id))) seeds.add(id);
  }
  const included = new Set(seeds);
  const redacted = new Map();
  let frontier = [...seeds];
  for (let hop = 0; hop < depth; hop++) {
    const next = [];
    for (const id of frontier) {
      if (scope && !visible(ctx.view, ctx.sessions.get(id))) continue;
      for (const item of neighbours(graph, { session: id, depth: 1 }, scope).neighbours) {
        if (item.redacted) {
          redacted.set(item.handle, item);
          continue;
        }
        const other = item.sessionId;
        if (!other || included.has(other)) continue;
        included.add(other);
        next.push(other);
      }
    }
    frontier = next;
  }
  const shownSessions = [...included].filter((id) => !scope || visible(ctx.view, ctx.sessions.get(id))).sort();
  const links = ctx.links.filter((link) => link.until === null && shownSessions.includes(link.session));
  const ledgers = [...new Set([...refs, ...links.map((link) => link.ref)])].sort();
  const edges = lineageEdges(graph, false, !ctx.view.scoped).filter((edge) => shownSessions.includes(edge.from) && shownSessions.includes(edge.to));
  return {
    sessions: [...shownSessions.map((id) => sessionView(ctx.view, ctx.sessions.get(id), id)), ...[...redacted.values()].sort((a, b) => a.handle.localeCompare(b.handle))],
    ledgers: ledgers.map((ref) => ({ ref, ...(links.find((link) => link.ref === ref && link.title)?.title ? { title: links.find((link) => link.ref === ref && link.title).title } : {}) })),
    links: links.map(linkView),
    edges: edges.map((edge) => ({ id: edge.id, from: edge.from, to: edge.to, type: edge.type })),
  };
}

const WRITER_REASON = { occupied: "occupied", unknown: "writer-unknown" };

export function writerState(harness, status) {
  if (!status) return { state: "unknown" };
  const writers = Array.isArray(status.writers) ? status.writers : [];
  const process = writers[0]?.kind;
  if (harness === "claude") {
    const state = status.state === "owned" ? "occupied" : status.state === "free" ? "free" : "unknown";
    return { state, ...(process ? { process } : {}) };
  }
  return { state: writers.length ? "occupied" : "free", ...(process ? { process } : {}) };
}

export function resumeInfo(graph, input = {}, scope = null, probeWriter = () => null) {
  const ctx = context(graph, scope);
  const id = parseGraphSessionId(input.session);
  const session = ctx.sessions.get(id);
  if (!session || (scope && !visible(ctx.view, session))) throw notFound();
  if (session.cloudIdentity) return {
    sessionId: id, harness: session.harness, nativeId: session.nativeId, host: hostLabel(), workspace: null,
    resumable: false, reason: "cloud-session", reasons: ["cloud-session"], writer: { state: "unknown" },
    commands: [], deepLinks: [], hints: [], successor: null,
  };
  const writer = writerState(session.harness, probeWriter(session));
  const renewal = (graph.renewals || []).filter((item) => item.from === id).at(-1);
  const successor = renewal ? sessionView(ctx.view, ctx.sessions.get(renewal.to), renewal.to) : null;
  const reasons = [...session.resumabilityReasons];
  if (session.archived) reasons.push("archived");
  if (WRITER_REASON[writer.state]) reasons.push(WRITER_REASON[writer.state]);
  if (/desktop/.test(writer.process || "")) reasons.push("desktop-owned");
  if (successor) reasons.push("superseded");
  const unique = [...new Set(reasons)];
  const uuid = session.nativeId;
  const commands = session.harness === "claude"
    ? [{ label: "Claude Code CLI", command: `claude --resume ${uuid}`, argv: ["claude", "--resume", uuid], cwd: session.cwd }]
    : [{ label: "Codex CLI", command: `codex resume ${uuid} --cd ${session.cwd}`, argv: ["codex", "resume", uuid, "--cd", session.cwd], cwd: session.cwd }];
  return {
    sessionId: id, harness: session.harness, nativeId: uuid, host: hostLabel(), workspace: session.cwd,
    resumable: unique.length === 0, ...(unique.length ? { reason: unique[0] } : {}), reasons: unique,
    writer, commands, deepLinks: [],
    hints: session.harness === "codex" && session.archived ? [`codex unarchive ${uuid}`] : [],
    successor: successor ? (successor.redacted ? successor : { sessionId: successor.sessionId }) : null,
  };
}

export function searchSessions(graph, input = {}, scope = null) {
  const ctx = context(graph, scope);
  const limit = Math.min(Math.max(Number(input.limit) || 50, 1), 200);
  const after = input.cursor ? decodeCursor(input.cursor, "search").after : null;
  const text = typeof input.text === "string" ? input.text.toLowerCase() : null;
  const matches = [...ctx.sessions.values()]
    .filter((session) => !scope || visible(ctx.view, session))
    .filter((session) => !input.harness || session.harness === input.harness)
    .filter((session) => !input.state || session.status === input.state || session.attention?.state === input.state)
    .filter((session) => !text || `${session.title}\n${session.cwd}`.toLowerCase().includes(text))
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId))
    .filter((session) => !after || session.sessionId > after);
  const page = matches.slice(0, limit);
  return {
    sessions: page.map((session) => ({ ...sessionView(ctx.view, session, session.sessionId),
      ...(!ctx.view.scoped ? { links: ctx.links.filter(link => link.session === session.sessionId && link.until === null).map(linkView) } : {}) })),
    ...(!ctx.view.scoped ? { linkCoverage: graph.migrated === true && graph.unnumbered !== true } : {}),
    cursor: matches.length > limit ? encodeCursor({ kind: "search", after: page.at(-1).sessionId }) : null,
  };
}

// ---------------------------------------------------------------------------
// Q7 change feed

export function encodeCursor(value) {
  return Buffer.from(JSON.stringify({ v: 1, ...value }), "utf8").toString("base64url");
}

export function decodeCursor(cursor, kind) {
  let value;
  try {
    value = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid cursor");
  }
  if (!value || value.v !== 1 || value.kind !== kind) throw new Error("invalid cursor");
  return value;
}

/**
 * Replays the retained stream from the snapshot so state transitions are known, and emits
 * feed events for graph events with seq > the cursor. A page never splits one graph event.
 */
export function changes(snapshotGraph, events, input = {}, scope = null) {
  const host = hostLabel();
  const watermark = snapshotGraph?.lastSeq || 0;
  const limit = Math.min(Math.max(Number(input.limit) || 100, 1), 1000);
  const lastSeq = events.reduce((max, item) => Math.max(max, item.seq || 0), watermark);
  if (input.initial !== undefined) {
    if (input.initial !== "head" || input.sinceCursor !== undefined) throw new Error("initial must be head without sinceCursor");
    return { reset: false, events: [], cursor: encodeCursor({ kind: "changes", host, seq: lastSeq }) };
  }
  let since = watermark;
  if (input.sinceCursor) {
    const cursor = decodeCursor(input.sinceCursor, "changes");
    if (cursor.host !== host) throw new Error("cursor belongs to another host");
    if (!Number.isSafeInteger(cursor.seq) || cursor.seq < 0) throw new Error("invalid cursor");
    if (cursor.seq < watermark || cursor.seq > lastSeq) return { reset: true, events: [], cursor: encodeCursor({ kind: "changes", host, seq: lastSeq }) };
    since = cursor.seq;
  }
  const view = makeScope(scope);
  const refsFilter = Array.isArray(input.refs) ? new Set(input.refs) : null;
  const state = {
    nodes: new Map((snapshotGraph?.nodes || []).map((node) => [node.id, node])),
    links: new Map((snapshotGraph?.links || []).map((link) => [link.id, link])),
    edges: new Map((snapshotGraph?.edges || []).map((edge) => [edge.id, edge])),
    renewals: [...(snapshotGraph?.renewals || [])], migrated: snapshotGraph?.migrated === true,
  };
  const seen = new Set([...state.nodes.values()].map(sessionIdOf).filter(Boolean));
  const sessionsNow = () => sessionIndex({ nodes: [...state.nodes.values()] });
  const output = [];
  let scanned = since;
  for (const item of events) {
    if (!item.seq || item.seq <= since) {
      if (item.type === "node.upserted" && sessionIdOf(item.node)) seen.add(sessionIdOf(item.node));
      applyReplay(state, item);
      continue;
    }
    if (output.length >= limit) break;
    const emitted = feedFor(state, seen, item);
    applyReplay(state, item, emitted);
    scanned = item.seq;
    if (!emitted.length) continue;
    const sessions = sessionsNow();
    const counts = new Map();
    for (const feed of emitted) counts.set(feed.type, (counts.get(feed.type) || 0) + 1);
    for (const feed of emitted) {
      if (!admitted(feed, view, sessions, state, refsFilter, scope)) continue;
      const subject = counts.get(feed.type) > 1 ? `:${feed.subject}` : "";
      const { subject: _subject, lastKnown: _lastKnown, ...payload } = feed;
      output.push({ eventId: `${item.id}${item.type === "node.purged" ? `:${item.seq}` : ""}:${feed.type}${subject}`, seq: item.seq, at: item.at, host, ...payload });
    }
  }
  return { reset: false, events: output, cursor: encodeCursor({ kind: "changes", host, seq: scanned }) };
}

function applyReplay(state, item, emitted) {
  if (item.type === "node.upserted") {
    state.nodes.set(item.node.id, item.node);
    return;
  }
  if (item.type === "node.purged") {
    state.nodes.delete(item.id);
    for (const [id, edge] of state.edges) if (edge.from === item.id || edge.to === item.id) state.edges.delete(id);
    return;
  }
  if (item.type === "edge.added") {
    state.edges.set(item.edge.id, item.edge);
    return;
  }
  if (PLEXUS_EVENTS.has(item.type) && !emitted) applyPlexusEvent(state, item);
}

function feedFor(state, seen, item) {
  const out = [];
  if (item.type === "node.upserted") {
    const id = sessionIdOf(item.node);
    const previous = state.nodes.get(item.node.id);
    const previousId = sessionIdOf(previous);
    if (previousId && previousId !== id) {
      const aliasesRemain = [...state.nodes.values()].some(node => node.id !== item.node.id && sessionIdOf(node) === previousId);
      const prior = sessionIndex({ nodes: [...state.nodes.values()] }).get(previousId);
      out.push({ type: aliasesRemain ? "session.updated" : "session.removed", session: previousId, subject: previousId,
        lastKnown: { cwd: prior.cwd, domains: prior.domains, harness: prior.harness } });
    }
    if (!id) return out;
    if (!seen.has(id)) {
      seen.add(id);
      out.push({ type: "session.created", session: id, subject: id });
    }
    if (seen.has(id) && (!previous || JSON.stringify(previous) !== JSON.stringify(item.node)) && !out.some(entry => entry.type === "session.created")) {
      const prior = sessionIndex({ nodes: [...state.nodes.values()] }).get(id);
      out.push({ type: "session.updated", session: id, subject: id,
        lastKnown: prior ? { cwd: prior.cwd, domains: prior.domains, harness: prior.harness } : null });
    }
    if (previous) {
      if (previous.status !== item.node.status || previous.attention?.state !== item.node.attention?.state) {
        out.push({ type: "session.state_changed", session: id, status: item.node.status, attention: item.node.attention?.state || null, subject: id });
      }
      const ended = (node) => node.status === "closed" || node.surface?.archived === true;
      if (!ended(previous) && ended(item.node)) out.push({ type: "session.ended", session: id, subject: id });
      if (previous.resumable !== item.node.resumable ||
        JSON.stringify(previous.resumabilityReasons || []) !== JSON.stringify(item.node.resumabilityReasons || [])) {
        out.push({ type: "resume.changed", session: id, resumable: item.node.resumable ?? null, subject: id });
      }
    }
    return out;
  }
  if (item.type === "node.purged") {
    const previous = state.nodes.get(item.id);
    const id = sessionIdOf(previous);
    if (!id) return out;
    const remaining = [...state.nodes.values()].some(node => node.id !== item.id && sessionIdOf(node) === id);
    const prior = sessionIndex({ nodes: [...state.nodes.values()] }).get(id);
    out.push({ type: remaining ? "session.updated" : "session.removed", session: id, subject: id,
      lastKnown: { cwd: prior.cwd, domains: prior.domains, harness: prior.harness } });
    return out;
  }
  if (item.type === "edge.added") {
    const from = sessionIdOf(state.nodes.get(item.edge.from)), to = sessionIdOf(state.nodes.get(item.edge.to));
    if (from && to) out.push({ type: "edge.added", edgeId: item.edge.id, kind: item.edge.type, from, to, subject: item.edge.id });
    return out;
  }
  if (!PLEXUS_EVENTS.has(item.type)) return out;
  for (const effect of applyPlexusEvent(state, item)) {
    if (effect.kind === "link.added" || effect.kind === "link.ended") {
      if (effect.link.session.startsWith("pending:")) continue;
      out.push({ type: effect.kind === "link.added" ? "edge.added" : "edge.ended", edgeId: effect.link.id, kind: effect.link.role, from: effect.link.session, to: effect.link.ref, ref: effect.link.ref, subject: effect.link.id });
    } else if (effect.kind === "session.updated") {
      out.push({ type: "session.updated", session: effect.session, subject: effect.session, lastKnown: effect.lastKnown });
    } else if (effect.kind === "edge.ended" || effect.kind === "edge.added") {
      const from = sessionIdOf(state.nodes.get(effect.edge.from)), to = sessionIdOf(state.nodes.get(effect.edge.to));
      if (from && to) out.push({ type: effect.kind, edgeId: effect.edge.id, kind: effect.edge.type, from, to, subject: effect.edge.id });
    } else if (effect.kind === "session.renewed") {
      out.push({ type: "session.renewed", from: effect.from, to: effect.to, subject: effect.to });
    }
  }
  return out;
}

function admitted(feed, view, sessions, state, refsFilter, scope) {
  if (feed.ref !== undefined) {
    if (!view.refVisible(feed.ref)) return false;
    if (refsFilter && !refsFilter.has(feed.ref)) return false;
  }
  const subjects = feed.ref !== undefined ? [feed.from] : [feed.session, feed.from, feed.to].filter(Boolean);
  if (scope && subjects.some(isCloudSessionId)) return false;
  if (scope && subjects.some((id) => !visible(view, sessions.get(id)) && !(["session.removed", "session.updated"].includes(feed.type) && id === feed.session && feed.lastKnown && visible(view, feed.lastKnown)))) return false;
  if (refsFilter && feed.ref === undefined) {
    const linked = [...state.links.values()].some((link) => link.until === null && refsFilter.has(link.ref) && subjects.includes(link.session));
    if (!linked) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------

function union(left, right) {
  return [...new Set([...(left || []), ...(right || [])])];
}

function maxTime(left, right) {
  if (!left) return right || null;
  if (!right) return left;
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function minTime(left, right) {
  if (!left) return right || null;
  if (!right) return left;
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

function round(value) {
  return Math.round(value * 1e6) / 1e6;
}

/** Plan a ledger-owned link reconciliation; the graph lock owns application. */
export function ledgerSyncEvents(graph, items, at = new Date().toISOString()) {
  if (!Array.isArray(items) || items.length > 200) throw new Error('ledger sync requires at most 200 items');
  const sessions = [...sessionIndex(graph).keys()];
  const events = [], unresolved = [], refs = new Set();
  for (const item of items) {
    if (!item || typeof item.ref !== 'string' || !/^[a-z][a-z0-9-]{0,63}:[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(item.ref) || refs.has(item.ref)) throw new Error('invalid or duplicate ledger ref');
    refs.add(item.ref);
    if (typeof item.title !== 'string' || item.title.length > 512 || /[\r\n]/.test(item.title) || !['open', 'active', 'waiting', 'blocked', 'done', 'cancelled', 'deleted'].includes(item.status)) throw new Error('invalid ledger item');
    const terminal = ['done', 'cancelled', 'deleted'].includes(item.status);
    const desired = new Map();
    if (!terminal) {
      // Omission is not evidence of removal; only a present sessions array asserts links.
      if (item.sessions === undefined) continue;
      if (!Array.isArray(item.sessions) || item.sessions.length > 200) throw new Error('invalid ledger sessions');
      for (const row of item.sessions) {
        if (!row || typeof row.session !== 'string') throw new Error('invalid ledger session');
        const role = row.role === undefined ? 'works-on' : row.role;
        if (!LINK_ROLES.has(role)) throw new Error('invalid ledger session role');
        const match = /^(?:(codex|claude):)?([0-9a-f-]{8,36})$/i.exec(row.session);
        if (!match) throw new Error('invalid ledger session prefix');
        const prefix = match[2].toLowerCase();
        const matches = sessions.filter(id => (!match[1] || id.startsWith(match[1].toLowerCase() + ':')) && id.split(':')[1].startsWith(prefix));
        if (matches.length !== 1) { unresolved.push({ ref: item.ref, session: row.session, reason: matches.length ? 'ambiguous' : 'not-found' }); continue; }
        desired.set(matches[0] + '/' + role, { session: matches[0], role });
      }
    }
    const open = (graph.links || []).filter(link => link.ref === item.ref && link.until === null);
    for (const link of open) {
      if (link.source !== 'ledger-write') continue;
      if (!desired.has(link.session + '/' + link.role)) events.push({ type: 'link.closed', linkId: link.id, closedBy: 'ledger-write' });
      else if (!link.lastActivityAt || Date.parse(at) - Date.parse(link.lastActivityAt) >= TOUCH_COALESCE_MS) events.push({ type: 'link.touched', linkId: link.id, evidence: item.updatedAt ? [item.ref + '@' + item.updatedAt] : [] });
    }
    for (const value of desired.values()) {
      // The existing unique link may belong to an operator or bridge; do not adopt it.
      if (open.some(link => link.session === value.session && link.role === value.role)) continue;
      events.push({ type: 'link.opened', link: newLink({ ...value, ref: item.ref, source: 'ledger-write', title: item.title, at }) });
    }
  }
  // An unresolved identity cannot justify closing any link or advancing this page.
  return { events: unresolved.length ? [] : events, unresolved };
}
