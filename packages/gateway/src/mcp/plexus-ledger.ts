import { validItemRef } from "./item-ref.js";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { MeshMcpOptions, MeshMcpPrincipal } from "./mesh-mcp.js";

const SESSION = /^(?:(?:codex|claude):[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|claude-cloud:[a-z][a-z0-9-]{0,63}:(?:session|cse)_[A-Za-z0-9]{1,128})$/i;
const exec = promisify(execFile);
type Row = Record<string, any>;
const unicodeScalar = (value: string) => !Array.from(value).some(c => {
  const code = c.codePointAt(0)!;
  return code >= 0xd800 && code <= 0xdfff;
});
const line = (limit = 4096) => z.string().refine(value => unicodeScalar(value) &&
  Array.from(value).length <= limit && !/[\r\n]/.test(value));
const timestamp = z.iso.datetime({ offset: true });
const canonicalItem = z.object({
  ref: z.string().refine(validItemRef), title: line(512),
  status: z.enum(["open", "active", "waiting", "blocked", "done", "cancelled", "deleted"]),
  updatedAt: timestamp,
  state: line().optional(), assignee: line().optional(), domain: line().optional(),
  nextAction: line().optional(), resumeCondition: line().optional(), url: line().optional(),
  priority: line().optional(), size: line().optional(), project: line().optional(),
  waiting_joseph: z.boolean().optional(),
  waitingOn: z.object({ who: z.enum(["human", "agent", "external"]), ask: line().optional(),
    urgency: z.enum(["low", "normal", "high"]).optional(), due: timestamp.optional() }).optional(),
  sessions: z.array(z.object({ session: z.string().regex(/^(?:(?:codex|claude):)?[0-9a-fA-F-]{8,36}$/),
    role: z.enum(["owns", "works-on", "reviews", "coordinates", "discusses", "observes", "mentioned"]).optional(),
    at: timestamp.optional() })).max(200).optional(),
  fields: z.record(z.string().refine(unicodeScalar), z.union([
    z.string().refine(unicodeScalar), z.number().finite(), z.boolean(), z.null()
  ])),
  sortKeys: z.record(z.string().regex(/^[A-Za-z0-9._-]{1,128}$/), z.number().finite())
    .refine(value => Object.keys(value).length <= 128).optional(),
  sourceRevision: z.string().regex(/^sha256:[a-f0-9]{64}$/)
});
export interface LedgerReadGrant {
  workspace_id: string;
  ledger_refs: readonly string[];
  session_ids: readonly string[];
  group_refs?: readonly string[];
}
/** Declared Plexus service scope is independent of its current enable flag.
 * Empty/revoked grants still reserve the profile: disabling reads must never
 * select an implicit Google or memory service profile instead. */
export function isPlexusServicePrincipal(principal: Pick<MeshMcpPrincipal,
  "kind" | "allowedTools" | "ledgerReadGrants" | "plexusLedgerReadDelegate">): boolean {
  return principal.kind === "service" && (principal.plexusLedgerReadDelegate === true ||
    principal.ledgerReadGrants !== undefined || principal.allowedTools.some(tool =>
      tool === "mesh_plexus_work_items" || tool === "mesh_plexus_ledger_sessions"));
}
export interface PlexusLedgerConfig { bridgeRoot: string; ownerPrincipalId?: string; timeoutMs?: number; maxResultBytes?: number; viewConfig?: string }
export interface PlexusLedgerReader {
  read(operation: "items" | "ledger-sessions", input: Row, grant: LedgerReadGrant): Promise<Row>;
  render?(view: Row): Promise<string>;
}
interface Core {
  workItems(graph: Row, input: Row, scope: null, read: () => Row): Row;
  ledgerSessions(graph: Row, input: Row, scope: null): Row;
  linkSubject(node: Row): string;
  ledgerView(graph: Row, input: Row, scope: null, read: () => Row, profile: Row): Row;
  renderLedgerView(view: Row, profile: Row): string;
  validateLedgerViewProfile(profile: unknown): Row;
}
export function validLedgerReadGrants(value: unknown, workspaces: readonly string[]): value is LedgerReadGrant[] {
  if (!Array.isArray(value) || value.length > 100) return false;
  const seen = new Set<string>();
  const refs = (x: unknown, session = false): x is string[] => Array.isArray(x) && x.length <= 10_000 &&
    x.every(v => typeof v === "string" && (session ? v.length <= 320 && SESSION.test(v) : validItemRef(v))) &&
    new Set(x).size === x.length;
  return value.every(v => {
    if (!v || typeof v !== "object" || Array.isArray(v) ||
        Object.keys(v).some(k => !["workspace_id", "ledger_refs", "session_ids", "group_refs"].includes(k)) ||
        typeof v.workspace_id !== "string" || !workspaces.includes(v.workspace_id) || seen.has(v.workspace_id) ||
        !refs(v.ledger_refs) || !refs(v.session_ids, true) ||
        (v.group_refs !== undefined && (!refs(v.group_refs) || v.group_refs.some((ref: string) => !ref.startsWith("group:"))))) return false;
    seen.add(v.workspace_id);
    return true;
  });
}
export class ShellPlexusLedgerReader implements PlexusLedgerReader {
  private readonly config: PlexusLedgerConfig;
  private readonly run: (file: string, args: string[], input?: string) => Promise<string>;
  constructor(config: PlexusLedgerConfig,
    run: (file: string, args: string[], input?: string) => Promise<string> = async (file, args, input) => {
      const pending = exec(file, args, { timeout: config.timeoutMs ?? 30_000, maxBuffer: config.maxResultBytes ?? 128 * 1024 * 1024,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
      pending.child.stdin?.end(input);
      return (await pending).stdout;
    }) {
    this.config = config;
    this.run = run;
    if (!isAbsolute(config.bridgeRoot) || (config.viewConfig !== undefined && !isAbsolute(config.viewConfig)) || (config.ownerPrincipalId !== undefined &&
        (typeof config.ownerPrincipalId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(config.ownerPrincipalId))) ||
        !Number.isSafeInteger(config.timeoutMs ?? 30_000) ||
        (config.timeoutMs ?? 30_000) < 1 || (config.timeoutMs ?? 30_000) > 120_000 ||
        !Number.isSafeInteger(config.maxResultBytes ?? 128 * 1024 * 1024) ||
        (config.maxResultBytes ?? 128 * 1024 * 1024) < 1024 ||
        (config.maxResultBytes ?? 128 * 1024 * 1024) > 256 * 1024 * 1024) throw new Error("Invalid Plexus reader configuration.");
  }
  async read(operation: "items" | "ledger-sessions", input: Row, grant: LedgerReadGrant): Promise<Row> {
    const core = await import(pathToFileURL(join(this.config.bridgeRoot, "plexus.mjs")).href) as Core;
    const profile = input.view === "plexus.ledger-view/v1" ? await this.profile(core) : undefined;
    const graph = JSON.parse(await this.run(process.execPath, [join(this.config.bridgeRoot, "mesh-graph.mjs"), "show", "--json"]));
    if (!Array.isArray(graph.nodes) || !Array.isArray(graph.links)) throw new Error("Invalid Plexus graph.");
    const refs = new Set(grant.ledger_refs), sessions = new Set(grant.session_ids), groups = new Set(grant.group_refs ?? []);
    const nodes = graph.nodes.filter((node: Row) => sessions.has(core.linkSubject(node)));
    const admittedSessions = new Set(nodes.map((node: Row) => core.linkSubject(node)));
    const scoped = { ...graph, nodes, edges: [], roleClaims: [], links: graph.links.filter((link: Row) =>
      admittedSessions.has(link.session) && (refs.has(link.ref) || groups.has(link.ref))) };
    if (operation === "ledger-sessions") {
      if (!refs.has(input.ref)) throw new Error("Ledger reference is not granted.");
      const result = core.ledgerSessions(scoped, { ref: input.ref, roles: ["owns", "works-on"] }, null);
      return { refs: result.refs, graph_revision: graph.lastSeq ?? null, sessions: result.sessions.map((s: Row) => ({
        session: s.sessionId, harness: s.harness, nativeId: s.nativeId, title: s.title ?? null,
        status: s.status ?? null, links: (s.links ?? []).map((l: Row) => ({ ref: l.ref, role: l.role }))
      })) };
    }
    const listing = JSON.parse(await this.run("python3", ["-c", EXACT_QUERY, this.config.bridgeRoot,
      String(this.config.maxResultBytes ?? 128 * 1024 * 1024)], JSON.stringify({ refs: grant.ledger_refs })));
    if (!Array.isArray(listing.items) || !Array.isArray(listing.errors) || listing.errors.length) throw new Error("Ledger source unavailable.");
    // Restrict the data supplied to the local-only core before it evaluates any user predicate.
    const seen = new Set<string>();
    const checkedItems = listing.items.map((raw: unknown) => canonicalItem.parse(raw));
    for (const item of checkedItems) {
      if (!refs.has(item.ref) || seen.has(item.ref)) throw new Error("Invalid exact ledger query.");
      seen.add(item.ref);
    }
    if (!Array.isArray(listing.missing) || listing.missing.some((ref: unknown) => typeof ref !== "string" || !refs.has(ref) || seen.has(ref)) ||
        new Set(listing.missing).size !== listing.missing.length || seen.size + listing.missing.length !== refs.size) throw new Error("Incomplete exact ledger query.");
    const items = checkedItems.map((item: Row) => ({ ...item, url: typeof item.url === "string" && /^(https?:\/\/|codex:\/\/threads\/)/.test(item.url) ? item.url : null }));
    if (input.view === "plexus.ledger-view/v1") {
      const metadata = grant.group_refs?.length ? JSON.parse(await this.run("python3", ["-c", GROUP_QUERY, this.config.bridgeRoot],
        JSON.stringify({ groups: [...grant.group_refs], refs: [...grant.ledger_refs] }))) : { groups: [] };
      if (!Array.isArray(metadata.groups)) throw new Error("Invalid group metadata.");
      return core.ledgerView(scoped, { filter: input.filter, sort: input.sort, includeClosed: input.include_closed, fallback: input.fallback },
        null, () => ({ items, errors: [], groups: metadata.groups }), profile!);
    }
    const result = core.workItems(scoped, { filter: input.filter, sort: input.sort, includeClosed: input.include_closed }, null,
      () => ({ items, errors: [] }));
    return { ...result, graph_revision: graph.lastSeq ?? null };
  }
  private async profile(core: Core): Promise<Row> {
    if (this.config.viewConfig === undefined) return {};
    const data = await readFile(this.config.viewConfig);
    if (data.length > 8 * 1024 * 1024) throw new Error("Ledger view profile exceeds size limit.");
    return core.validateLedgerViewProfile(JSON.parse(data.toString("utf8")));
  }
  async render(view: Row): Promise<string> {
    const core = await import(pathToFileURL(join(this.config.bridgeRoot, "plexus.mjs")).href) as Core;
    return core.renderLedgerView(view, await this.profile(core));
  }
}
const GROUP_QUERY = `
import json, sys, runpy
from pathlib import Path
sys.path.insert(0, sys.argv[1])
module = runpy.run_path(str(Path(sys.argv[1]) / 'mesh-groups.py'))
request = json.load(sys.stdin)
result = module['read_group_metadata'](request['groups'], ledger_refs=request['refs'])
print(json.dumps(result, ensure_ascii=True))
`;
const EXACT_QUERY = `
import json, sys, runpy
from pathlib import Path
module = runpy.run_path(str(Path(sys.argv[1]) / 'mesh-ledger.py'))
request = json.load(sys.stdin)
result = module['query_items'](request['refs'], max_result_bytes=int(sys.argv[2]))
print(json.dumps(result, ensure_ascii=True))
`;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function registerPlexusLedgerTools(server: McpServer, options: MeshMcpOptions): void {
  const mayRead = () => (options.principal.kind === "user" && options.principal.plexusLedgerOwner === true) ||
    (options.principal.kind === "service" && options.principal.plexusLedgerReadDelegate === true &&
      validLedgerReadGrants(options.principal.ledgerReadGrants, options.principal.allowedWorkspaceIds) &&
      options.principal.ledgerReadGrants.length > 0);
  if (!mayRead()) return;
  const workspace = z.string().min(1).max(128).optional();
  const invoke = async (tool: "mesh_plexus_work_items" | "mesh_plexus_ledger_sessions", input: Row) => {
    try {
      if (!mayRead() || !options.principal.allowedTools.includes(tool) || !options.plexusLedgerReader ||
          !options.rateLimiter.consume(options.principal.id, tool)) throw new Error("Plexus read is not authorized.");
      if (input.view !== undefined && !(options.principal.kind === "user" && options.principal.plexusLedgerOwner === true)) throw new Error("Ledger views require the owner principal.");
      if (input.view === undefined && (input.format !== undefined || input.fallback !== undefined)) throw new Error("View options require an explicit schema version.");
      const grants = options.principal.ledgerReadGrants;
      if (!validLedgerReadGrants(grants, options.principal.allowedWorkspaceIds)) throw new Error("Plexus read grant is required.");
      const id = input.workspace_id ?? (grants.length === 1 ? grants[0]!.workspace_id : undefined);
      const grant = grants.find(g => g.workspace_id === id);
      if (!grant || (tool === "mesh_plexus_ledger_sessions" && !grant.ledger_refs.includes(input.ref))) throw new Error("Plexus read is not authorized.");
      const operation = tool === "mesh_plexus_work_items" ? "items" : "ledger-sessions";
      const data = await options.plexusLedgerReader.read(operation, input, grant);
      if (operation === "items") {
        const policy = hash({ principal: options.principal.id, grant });
        const query = hash({ filter: input.filter ?? {}, sort: input.sort ?? null, include_closed: input.include_closed ?? false,
          ...(input.view === undefined ? {} : { view: input.view, fallback: input.fallback ?? "director", format: input.format ?? "json" }) });
        const revision = hash(data);
        let offset = 0;
        if (input.cursor) {
          const token = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"));
          if (token.policy !== policy || token.query !== query || token.revision !== revision ||
              !Number.isSafeInteger(token.offset) || token.offset < 0) throw new Error("Cursor is stale or incompatible.");
          offset = token.offset;
        }
        const limit = input.limit ?? 100;
        const page = data.items.slice(offset, offset + limit);
        const next = offset + page.length < data.items.length ? Buffer.from(JSON.stringify({ policy, query, revision, offset: offset + page.length })).toString("base64url") : null;
        const result = { ...data, count: page.length, items: page, next_cursor: next, grant_revision: policy, result_revision: revision,
          ...(input.view === undefined ? {} : { offset }) };
        if (input.format === "md") {
          if (!options.plexusLedgerReader.render) throw new Error("Ledger view renderer unavailable.");
          return { structuredContent: result, content: [{ type: "text" as const, text: await options.plexusLedgerReader.render(result) }] };
        }
        return response(result);
      }
      return response(data);
    } catch { return { isError: true as const, content: [{ type: "text" as const, text: "Plexus read denied, unavailable, or cursor stale." }] }; }
  };
  if (options.principal.allowedTools.includes("mesh_plexus_work_items")) server.registerTool("mesh_plexus_work_items", {
    title: "Read Plexus work items", description: "Join current ledger fields and independently visible session links. Core owns all filtering and sorting. Pages recheck exact grants; stale cursors fail closed.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: z.object({ workspace_id: workspace, filter: z.record(z.string().max(2048), z.unknown()).optional(),
      sort: z.array(z.string().min(1).max(2054)).min(1).max(8).optional(), include_closed: z.boolean().optional(),
      limit: z.number().int().min(1).max(200).optional(), cursor: z.string().max(2048).optional(),
      view: z.literal("plexus.ledger-view/v1").optional(), format: z.enum(["json", "md"]).optional(),
      fallback: z.enum(["director", "project"]).optional() }).strict()
  }, input => invoke("mesh_plexus_work_items", input));
  if (options.principal.allowedTools.includes("mesh_plexus_ledger_sessions")) server.registerTool("mesh_plexus_ledger_sessions", {
    title: "Read ledger session links", description: "Read independently authorized owns/works-on session identities for one exact ledger reference. Links grant no visibility or lease.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: z.object({ workspace_id: workspace, ref: z.string().refine(validItemRef) }).strict()
  }, input => invoke("mesh_plexus_ledger_sessions", input));
}
function response(value: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(value) }] }; }
