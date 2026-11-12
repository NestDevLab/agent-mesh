/** Versioned ledger presentation. Source fields and group authority remain external. */
import { createHash } from "node:crypto";

export const LEDGER_VIEW_SCHEMA = "plexus.ledger-view/v1";
export const LEDGER_VIEW_PROFILE_SCHEMA = "plexus.ledger-view-config/v1";
export const LEDGER_VIEW_SORT = ["waitingOnOwner:desc", "due:asc", "priority:asc", "size:asc"];
const own = (value, key) => value !== null && typeof value === "object" && Object.hasOwn(value, key);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const scalar = value => value === null || ["string", "boolean", "number"].includes(typeof value);
const nullable = value => value === undefined || value === "" ? null : value;
const text = value => typeof value === "string" && value.length ? value : null;
const DEFAULT_FIELDS = {
  id: ["fields.id"], title: ["title", "fields.title"], state: ["state", "status"],
  due: ["fields.due", "due"], priority: ["priority", "fields.priority"],
  size: ["size", "fields.size"], domain: ["domain", "fields.domain"],
  project: ["project", "fields.project", "domain"], thread: ["url"]
};

export function ledgerViewValue(value, path) {
  if (typeof path !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(path)) throw new Error("Invalid view field path.");
  const parts = path.split(".");
  if (parts.some(part => !part || ["__proto__", "prototype", "constructor"].includes(part))) throw new Error("Unsafe view field path.");
  function walk(current, index) {
    if (index === parts.length) return current;
    if (Array.isArray(current)) return current.flatMap(entry => {
      const found = walk(entry, index);
      return found === undefined ? [] : [found];
    });
    return own(current, parts[index]) ? walk(current[parts[index]], index + 1) : undefined;
  }
  const direct = walk(value, 0);
  const found = direct === undefined && own(value?.fields, path) ? value.fields[path] : direct;
  if (Array.isArray(found)) {
    const entries = found.flat(Infinity).filter(entry => scalar(entry) && entry !== null && entry !== "");
    return entries.length ? entries : undefined;
  }
  return found === "" || found === null || typeof found === "object" ? undefined : found;
}

function first(item, paths) {
  for (const path of paths) {
    const value = ledgerViewValue(item, path);
    if (value !== undefined) return value;
  }
  return null;
}

function threadPair(value) {
  if (!object(value) || typeof value.chan !== "string" || typeof value.cmsg !== "string" ||
      !/^[A-Za-z0-9_-]{1,256}$/.test(value.chan) || !/^[A-Za-z0-9_-]{1,256}$/.test(value.cmsg)) throw new Error("Invalid configured app thread.");
  return { chan: value.chan, cmsg: value.cmsg };
}

function urlThread(value) {
  if (typeof value !== "string") return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.origin !== "https://claude.ai") return null;
  const match = /^\/code\/project\/([A-Za-z0-9_-]{1,256})$/.exec(url.pathname);
  const cmsg = url.searchParams.get("thread");
  return match && cmsg && /^[A-Za-z0-9_-]{1,256}$/.test(cmsg) ? { chan: match[1], cmsg } : null;
}

function appUrl(pair) {
  return `https://claude.ai/code/project/${encodeURIComponent(pair.chan)}${pair.cmsg ? `?thread=${encodeURIComponent(pair.cmsg)}` : ""}`;
}

export function validateLedgerViewProfile(value = {}) {
  if (!object(value) || (value.schema !== undefined && value.schema !== LEDGER_VIEW_PROFILE_SCHEMA)) throw new Error("Invalid ledger view profile schema.");
  const allowed = new Set(["schema", "fields", "waiting", "projectAliases", "projects", "groups", "itemThreads", "sessionThreads", "ranks", "excludeStates", "defaultProject", "projectSourceOrder", "markdown"]);
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error("Unknown ledger view profile option.");
  for (const name of ["fields", "projectAliases", "projects", "groups", "itemThreads", "sessionThreads", "ranks", "markdown"]) {
    if (value[name] !== undefined && !object(value[name])) throw new Error(`Invalid profile ${name}.`);
  }
  for (const [key, paths] of Object.entries(value.fields ?? {})) {
    if (!Object.hasOwn(DEFAULT_FIELDS, key) || !Array.isArray(paths) || !paths.length || paths.some(path => typeof path !== "string")) throw new Error("Invalid source field mapping.");
    for (const path of paths) ledgerViewValue({}, path);
  }
  if (value.waiting !== undefined) {
    if (!object(value.waiting) || !Array.isArray(value.waiting.values) || value.waiting.values.some(entry => !scalar(entry))) throw new Error("Invalid waiting rule.");
    const fields = Array.isArray(value.waiting.field) ? value.waiting.field : [value.waiting.field];
    if (!fields.length) throw new Error("Invalid waiting field mapping.");
    for (const field of fields) ledgerViewValue({}, field);
  }
  for (const map of [value.itemThreads, value.sessionThreads]) {
    for (const pair of Object.values(map ?? {})) threadPair(pair);
  }
  for (const project of Object.values(value.projects ?? {})) {
    if (!object(project) || typeof project.name !== "string" || typeof project.chan !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(project.chan)) throw new Error("Invalid configured project.");
    if (project.director !== undefined) threadPair({ chan: project.chan, ...project.director });
  }
  for (const [field, ranks] of Object.entries(value.ranks ?? {})) {
    ledgerViewValue({}, field);
    if (!object(ranks) || Object.values(ranks).some(rank => typeof rank !== "number" || !Number.isFinite(rank))) throw new Error("Invalid configured sort ranks.");
  }
  if (value.excludeStates !== undefined && (!Array.isArray(value.excludeStates) || value.excludeStates.some(state => typeof state !== "string"))) throw new Error("Invalid excluded states.");
  if (value.defaultProject !== undefined && typeof value.defaultProject !== "string") throw new Error("Invalid default project.");
  if (value.projectSourceOrder !== undefined && (!Array.isArray(value.projectSourceOrder) || value.projectSourceOrder.length !== 3 || new Set(value.projectSourceOrder).size !== 3 || value.projectSourceOrder.some(source => !["field", "group", "thread"].includes(source)))) throw new Error("Invalid project precedence.");
  return value;
}

export function ledgerViewProfileRevision(profile = {}) {
  validateLedgerViewProfile(profile);
  const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  return "sha256:" + createHash("sha256").update(JSON.stringify(canonical(profile))).digest("hex");
}

function sessionRows(item) {
  return (item.sessions ?? []).map(session => ({
    id: text(session.session ?? session.sessionId), harness: text(session.harness),
    nativeId: text(session.nativeId), title: text(session.title), status: text(session.status),
    role: text(session.role), url: text(session.url)
  })).sort((a, b) => Number(b.role === "owns") - Number(a.role === "owns") ||
    Number(b.status === "active") - Number(a.status === "active") || String(a.id).localeCompare(String(b.id)));
}

function linkedGroups(item, metadata, profile) {
  const associations = metadata.filter(group => group.ledger_links?.some(link => link.ref === item.ref));
  const refs = new Set([...(item.groups ?? []), ...associations.map(group => group.source_ref || `group:${group.group_id}`)]);
  return [...refs].sort().map(ref => {
    const source = associations.find(group => (group.source_ref || `group:${group.group_id}`) === ref);
    const link = source?.ledger_links.find(link => link.ref === item.ref);
    return { ref, id: source?.group_id ?? null, name: source?.name ?? profile.groups?.[ref]?.name ?? null,
      role: source?.role_key ?? null, lead: link?.lead ?? null };
  });
}

function resolveThread(item, sessions, profile, fields) {
  if (profile.itemThreads?.[item.ref]) return { ...threadPair(profile.itemThreads[item.ref]), resolution: "item" };
  for (const session of sessions) {
    const pair = profile.sessionThreads?.[session.id] ?? profile.sessionThreads?.[session.nativeId];
    if (pair) return { ...threadPair(pair), resolution: "session" };
  }
  const stored = urlThread(first(item, fields.thread));
  return stored ? { ...stored, resolution: "item" } : null;
}

function missingReason(sessions) {
  if (!sessions.length) return "unassigned";
  if (sessions.every(session => session.harness === "codex")) return "native-only";
  if (sessions.every(session => session.status === "closed")) return "session-closed";
  return "app-thread-unmapped";
}

export function buildLedgerViewRows(items, profile = {}, { groups = [], fallback = "director", sourceItems = items } = {}) {
  validateLedgerViewProfile(profile);
  if (!["director", "project"].includes(fallback)) throw new Error("Invalid app thread fallback.");
  if (!Array.isArray(groups)) throw new Error("Invalid group metadata.");
  const fields = { ...DEFAULT_FIELDS, ...profile.fields };
  const sources = new Map(sourceItems.map(item => [item.ref, item]));
  return items.map(item => {
    if (typeof item.ref !== "string" || !object(item.fields) || Object.values(item.fields).some(value =>
      !scalar(value) || (typeof value === "number" && !Number.isFinite(value)))) throw new Error("Invalid ledger view source fields.");
    if (item.sourceRevision !== undefined && item.sourceRevision !== null && !/^sha256:[a-f0-9]{64}$/.test(item.sourceRevision)) throw new Error("Invalid source revision.");
    const sessions = sessionRows(item);
    const linked = linkedGroups(item, groups, profile);
    const leads = linked.filter(group => group.lead === true);
    if (leads.length > 1) throw new Error("Multiple lead groups for one ledger reference.");
    const originalThread = resolveThread(item, sessions, profile, fields);
    const fromField = first(item, fields.project);
    const fromGroup = linked.map(group => profile.groups?.[group.ref]?.project).find(Boolean);
    const fromThread = originalThread ? Object.entries(profile.projects ?? {}).find(([, project]) => project.chan === originalThread.chan)?.[0] : null;
    const candidates = { field: profile.projectAliases?.[fromField] ?? fromField, group: fromGroup, thread: fromThread };
    const project = (profile.projectSourceOrder ?? ["field", "group", "thread"]).map(source => candidates[source]).find(value => typeof value === "string" && value) ?? profile.defaultProject ?? null;
    const configuredProject = profile.projects?.[project];
    let resolved = originalThread;
    let fallbackReason = null;
    if (!resolved && configuredProject) {
      if (fallback === "project") resolved = { chan: configuredProject.chan, cmsg: null, resolution: "project" };
      else if (configuredProject.director) resolved = { ...threadPair({ chan: configuredProject.chan, ...configuredProject.director }), resolution: "director" };
      else fallbackReason = "director-unmapped";
    } else if (!resolved) fallbackReason = "project-unmapped";
    const waiting = profile.waiting ? first(item, Array.isArray(profile.waiting.field) ? profile.waiting.field : [profile.waiting.field]) : null;
    const row = {
      ref: item.ref, id: text(first(item, fields.id)), title: text(first(item, fields.title)),
      state: text(first(item, fields.state)), status: text(item.status), due: text(first(item, fields.due)),
      priority: nullable(first(item, fields.priority)), size: nullable(first(item, fields.size)),
      domain: text(first(item, fields.domain)), project, projectName: configuredProject?.name ?? project,
      waitingOnOwner: profile.waiting ? (waiting === null ? null : profile.waiting.values.includes(waiting)) : item.waitingOn?.who === "human" ? true : item.waitingOn === undefined ? null : false,
      assignee: text(item.assignee), sessions, owners: sessions.filter(session => session.role === "owns").map(session => session.id),
      groups: linked, leadGroupRef: leads[0]?.ref ?? null,
      thread: { chan: resolved?.chan ?? null, cmsg: resolved?.cmsg ?? null, url: resolved ? appUrl(resolved) : null,
        resolution: resolved?.resolution ?? "missing", missingReason: originalThread ? null : missingReason(sessions), fallbackReason },
      fields: item.fields ?? {}, sourceRevision: text(item.sourceRevision), updatedAt: text(item.updatedAt),
      sortKeys: { ...sources.get(item.ref)?.sortKeys }
    };
    if (!scalar(row.priority) || !scalar(row.size)) throw new Error("Mapped view fields must be scalars.");
    for (const [field, ranks] of Object.entries(profile.ranks ?? {})) {
      const value = ledgerViewValue(row, field);
      if (Object.hasOwn(ranks, String(value))) row.sortKeys[field] = ranks[String(value)];
      else delete row.sortKeys[field];
    }
    return row;
  });
}

const escapeMarkdown = value => String(value ?? "").replace(/([\\`*_[\]<>])/g, "\\$1").replace(/[\r\n]+/g, " ");
const template = (pattern, values) => pattern.replace(/\{([A-Za-z0-9._-]+)\}/g, (_, key) => values[key] ?? "");
function sessionLabel(session, config) {
  const name = config.harnessNames?.[session.harness] ?? session.harness ?? "?";
  let title = session.title ?? "";
  if (title.length > (config.sessionTitleLimit ?? 40) || /^[\[@<]/.test(title)) title = "";
  return `${name} ${(session.nativeId ?? session.id ?? "?").slice(0, config.sessionIdLength ?? 8)}${title ? ` «${title}»` : ""}`;
}

export function renderLedgerView(view, profile = {}) {
  validateLedgerViewProfile(profile);
  if (view.schema !== LEDGER_VIEW_SCHEMA || view.profile_revision !== ledgerViewProfileRevision(profile)) throw new Error("Ledger view/profile revision mismatch.");
  const config = profile.markdown ?? {};
  const labels = { none: "—", undated: "No due date", thread: "thread", missing: "No thread", director: "Director", ...config.labels };
  const summary = Object.fromEntries(Object.entries(view.summary ?? {}).map(([key, value]) => [key, String(value)]));
  const lines = [...(config.headerLines ?? [`# ${config.title ?? "Ledger view"}`, ""])].map(line => template(line, summary));
  const pattern = config.rowTemplate ?? "{number}. **{id}** {title} · {due} · {priority} · {state} · {owners} · {groups} · {thread}";
  let priorSection;
  const useSections = config.sections && view.sort[0]?.startsWith("waitingOnOwner:");
  for (let index = 0; index < view.items.length; index++) {
    const row = view.items[index];
    const waiting = row.waitingOnOwner === true;
    if (useSections && priorSection !== waiting) {
      if (priorSection !== undefined) lines.push("");
      const heading = waiting ? config.sections.waiting : config.sections.other;
      lines.push(template(heading, summary), "");priorSection = waiting;
    }
    let id = row.id ?? row.ref;
    if (config.idPrefix && id.startsWith(config.idPrefix)) id = id.slice(config.idPrefix.length);
    const words = (row.title ?? "").split(/\s+/);
    const title = config.titleWords && words.length > config.titleWords ? words.slice(0, config.titleWords).join(" ") + (config.titleEllipsis ?? " …") : row.title;
    const mapped = (field, value) => config.valueLabels?.[field]?.[value] ?? value ?? "";
    let due = row.due ?? labels.undated;
    if (row.due && config.dateFormat === "day-month" && /^\d{4}-\d{2}-\d{2}/.test(row.due)) due = row.due.slice(8, 10) + "/" + row.due.slice(5, 7);
    const owners = row.sessions.slice(0, config.maxSessions ?? 2).map(session => sessionLabel(session, config)).join(", ") || row.assignee || labels.none;
    const groups = row.groups.map(group => {
      let name = group.name ?? group.ref;
      for (const [from, to] of Object.entries(config.groupReplacements ?? {})) name = name.replaceAll(from, to);
      return name;
    }).join(", ") || labels.none;
    const values = { number: String((view.offset ?? 0) + index + 1), id, title, due,
      priority: mapped("priority", row.priority), state: mapped("state", row.state), size: mapped("size", row.size),
      owners, groups, project: row.projectName ?? labels.none, reason: config.missingReasons?.[row.thread.missingReason] ?? row.thread.missingReason ?? "", ...labels };
    for (const key of Object.keys(values)) values[key] = escapeMarkdown(values[key]);
    values.url = row.thread.url ?? "";
    if (["item", "session"].includes(row.thread.resolution)) values.thread = template(config.itemThreadTemplate ?? "[{thread}]({url})", values);
    else if (row.thread.url) values.thread = template(config.fallbackTemplate ?? "{missing} ({reason}) → [{director} {project}]({url})", values);
    else values.thread = template(config.missingTemplate ?? "{missing} ({reason})", values);
    lines.push(template(pattern, values));
  }
  lines.push(...(config.footerLines ?? []).map(line => template(line, summary)));
  return lines.join("\n").replace(/\n*$/, "\n");
}
