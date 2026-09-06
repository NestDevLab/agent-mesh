#!/usr/bin/env node
/**
 * Durable local session graph for the tmux bridge.
 *
 * The event stream is canonical. graph.json is an atomically replaced projection
 * that can always be rebuilt from events.jsonl.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

const GRAPH_SCHEMA = "agent-mesh.session-graph.v1";
const EVENT_SCHEMA = "agent-mesh.session-graph-event.v1";
const NODE_STATUSES = new Set(["active", "waiting", "blocked", "quiet", "closed"]);
const NODE_CLASSES = new Set(["orchestrator", "worker", "observer", "ephemeral", "unclassified"]);
const EDGE_TYPES = new Set(["spawned-by", "delegates-to", "linked", "watches"]);
// References deliberately identify no provider-specific schema. Consumers may
// join them with their own stores; the graph only preserves explicit links.
const OPAQUE_REF = /^[a-z][a-z0-9-]{0,63}:[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const MAX_SUMMARY_LENGTH = 240;
const GRAPH_DIR = resolve(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "agent-mesh", "graph");

const { values, positionals } = parseArgs({
  options: {
    state: { type: "string" },
    agent: { type: "string" },
    "tmux-target": { type: "string" },
    cwd: { type: "string" },
    "role-profile": { type: "string" },
    title: { type: "string" },
    class: { type: "string" },
    domains: { type: "string" },
    domain: { type: "string" },
    role: { type: "string" },
    "take-over": { type: "string" },
    "quiet-after": { type: "string" },
    summary: { type: "string" },
    status: { type: "string" },
    "runtime-uuid": { type: "string" },
    ref: { type: "string" },
    refs: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    type: { type: "string" },
    id: { type: "string" },
    json: { type: "boolean", default: false },
    tree: { type: "boolean", default: false },
    compact: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: true,
  strict: true,
});

if (values.help || positionals.length === 0) {
  printHelp();
  process.exit(values.help ? 0 : 2);
}
const command = positionals[0];
const subcommand = positionals[1];
if (command === "ref") {
  if (positionals.length !== 2) fail("ref requires exactly one operation: add or remove");
} else if (positionals.length !== 1) {
  fail("only one command may be supplied");
}
const stateDir = resolve(values.state || GRAPH_DIR);

try {
  switch (command) {
    case "add":
      printResult(addNode(stateDir, values), values);
      break;
    case "adopt":
      printResult(adoptNode(stateDir, values), values);
      break;
    case "discover":
      printResult(discoverNodes(stateDir, values), values);
      break;
    case "sweep":
      printResult(sweepNodes(stateDir, values), values);
      break;
    case "claim":
      printResult(claimDomain(stateDir, values), values);
      break;
    case "link":
      printResult(addEdge(stateDir, values), values);
      break;
    case "ref":
      printResult(updateRef(stateDir, subcommand, values), values);
      break;
    case "summary":
      printResult(updateSummary(stateDir, values), values);
      break;
    case "close":
      printResult(closeNode(stateDir, values), values);
      break;
    case "purge":
      printResult(purgeNode(stateDir, values), values);
      break;
    case "show":
      showGraph(stateDir, values);
      break;
    default:
      fail(`unknown command '${command}'`);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

function addNode(statePath, options) {
  const tmuxTarget = requiredSingleLine(options["tmux-target"], "--tmux-target");
  return mutate(statePath, (graph) => {
    const existing = graph.nodes.find((node) => node.tmuxTarget === tmuxTarget);
    if (existing) {
      const changes = nodeChanges(existing, options);
      if (Object.keys(changes).length === 0) return { graph, result: { node: existing, changed: false } };
      const node = { ...existing, ...changes, updatedAt: now() };
      return {
        graph,
        event: event("node.upserted", { node }),
        result: { node, changed: true },
      };
    }

    const agent = requiredSingleLine(options.agent, "--agent");
    const status = options.status || "active";
    assertStatus(status);
    const timestamp = now();
    const node = {
      id: `node-${randomUUID()}`,
      agent,
      tmuxTarget,
      cwd: optionalSingleLine(options.cwd, "--cwd") || "",
      roleProfile: optionalSingleLine(options["role-profile"], "--role-profile") || "",
      title: optionalSingleLine(options.title, "--title") || "",
      summary: optionalSummary(options.summary) || "",
      status,
      class: nodeClass(options.class),
      domains: domainsFor(optionalSingleLine(options.cwd, "--cwd") || "", options),
      domainsExplicit: options.domains !== undefined,
      primaryDomains: [],
      domainPredecessors: {},
      lastSeenAt: timestamp,
      runtimeUuid: optionalRuntimeUuid(options["runtime-uuid"]) || null,
      refs: refsChanges([], options),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    return {
      graph,
      event: event("node.upserted", { node }),
      result: { node, changed: true },
    };
  });
}

function adoptNode(statePath, options) {
  const agent = requiredAdoptAgent(options.agent);
  const runtimeUuid = requiredRuntimeUuid(options["runtime-uuid"]);
  if (options.class === undefined) throw new Error("manual adopt requires --class; automatic discovery uses unclassified");
  const facts = inspectTranscript(agent, runtimeUuid);
  return mutate(statePath, (graph) => {
    const existing = graph.nodes.find((node) => String(node.runtimeUuid || "").toLowerCase() === runtimeUuid);
    if (existing) {
      const changes = {};
      for (const [field, value] of [["agent", agent], ["cwd", facts.cwd], ["title", facts.title], ["runtimeUuid", runtimeUuid], ["class", nodeClass(options.class)], ["lastSeenAt", facts.updatedAt]]) {
        if (existing[field] !== value) changes[field] = value;
      }
      if (options.domains !== undefined || !existing.domainsExplicit) {
        const domains = domainsFor(facts.cwd, options);
        if (JSON.stringify(domains) !== JSON.stringify(existing.domains || [])) changes.domains = domains;
        if (options.domains !== undefined && !existing.domainsExplicit) changes.domainsExplicit = true;
      }
      if (Object.keys(changes).length === 0) return { graph, result: { node: existing, changed: false } };
      const node = { ...existing, ...changes, updatedAt: now() };
      return { graph, event: event("node.upserted", { node }), result: { node, changed: true } };
    }
    const timestamp = now();
    const node = {
      id: `node-${randomUUID()}`,
      agent,
      tmuxTarget: "",
      cwd: facts.cwd,
      roleProfile: "",
      // This is raw transcript evidence, never a graph-generated summary.
      title: facts.title,
      summary: "",
      status: "active",
      class: nodeClass(options.class),
      domains: domainsFor(facts.cwd, options),
      domainsExplicit: options.domains !== undefined,
      primaryDomains: [],
      domainPredecessors: {},
      lastSeenAt: facts.updatedAt,
      runtimeUuid,
      refs: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    return { graph, event: event("node.upserted", { node }), result: { node, changed: true } };
  });
}

function watcherPath() {
  const localWatcher = join(dirname(new URL(import.meta.url).pathname), "agent-watch.py");
  const watcher = existsSync(localWatcher)
    ? localWatcher
    : process.env.AGENT_MESH_ROOT
      ? join(process.env.AGENT_MESH_ROOT, "packages", "tmux-bridge", "bin", "agent-watch.py")
      : localWatcher;
  if (!existsSync(watcher)) throw new Error("transcript inspection requires agent-watch.py beside mesh-graph or under AGENT_MESH_ROOT");
  return watcher;
}

function runWatcher(args) {
  // A discover sweep returns every persisted transcript at once, way past the 1 MB spawnSync default.
  return spawnSync(process.env.PYTHON || "python3", args, { encoding: "utf8", env: process.env, maxBuffer: 256 * 1024 * 1024 });
}

function inspectTranscript(agent, runtimeUuid) {
  const result = runWatcher([watcherPath(), runtimeUuid, "--agent", agent, "--inspect", "--format", "jsonl"]);
  if (result.error) throw new Error(`could not inspect transcript: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`transcript inspection failed: ${(result.stderr || result.stdout || "unknown error").trim()}`);
  let facts;
  try {
    facts = JSON.parse(result.stdout);
  } catch {
    throw new Error("transcript inspection returned invalid JSON");
  }
  if (!facts || facts.agent !== agent || String(facts.runtime_uuid || "").toLowerCase() !== runtimeUuid) {
    throw new Error("transcript inspection returned mismatched session facts");
  }
  for (const field of ["cwd", "title"]) if (typeof facts[field] !== "string") throw new Error(`transcript inspection returned invalid ${field}`);
  return { ...facts, updatedAt: new Date(Number(facts.updated_at) / 1_000_000).toISOString() };
}

function inspectTranscripts(agent) {
  const result = runWatcher([watcherPath(), "--agent", agent, "--discover", "--format", "jsonl"]);
  if (result.error) throw new Error(`could not discover transcripts: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`transcript discovery failed: ${(result.stderr || result.stdout || "unknown error").trim()}`);
  let facts;
  try { facts = JSON.parse(result.stdout); } catch { throw new Error("transcript discovery returned invalid JSON"); }
  if (!Array.isArray(facts)) throw new Error("transcript discovery returned invalid facts");
  return facts.map((item) => ({ ...item, runtimeUuid: requiredRuntimeUuid(item.runtime_uuid), cwd: String(item.cwd || ""), title: String(item.title || ""), updatedAt: new Date(Number(item.updated_at) / 1_000_000).toISOString() }));
}

function discoverNodes(statePath, options) {
  const agent = requiredAdoptAgent(options.agent);
  const quietAfter = optionalPositiveInteger(options["quiet-after"], "--quiet-after") || Number(process.env.MESH_GRAPH_QUIET_AFTER_SECONDS || 3600);
  const facts = inspectTranscripts(agent);
  return mutate(statePath, (graph) => {
    const events = [], nodes = [];
    for (const fact of facts) {
      const existing = graph.nodes.find((node) => String(node.runtimeUuid || "").toLowerCase() === fact.runtimeUuid);
      const observedStatus = Date.now() - Date.parse(fact.updatedAt) >= quietAfter * 1000 ? "quiet" : "active";
      const node = existing ? { ...existing } : { id: `node-${randomUUID()}`, tmuxTarget: "", roleProfile: "", summary: "", refs: [], primaryDomains: [], domainPredecessors: {}, domainsExplicit: false, createdAt: now() };
      Object.assign(node, { agent, cwd: fact.cwd, title: fact.title, runtimeUuid: fact.runtimeUuid, lastSeenAt: fact.updatedAt, class: existing?.class || "unclassified" });
      if (!node.domainsExplicit) node.domains = domainsFor(fact.cwd, {});
      if (!existing || ["active", "quiet"].includes(existing.status)) node.status = observedStatus;
      if (!existing || JSON.stringify(node) !== JSON.stringify(existing)) {
        node.updatedAt = now();
        events.push(event("node.upserted", { node }));
      }
      nodes.push(node);
    }
    return { graph, events, result: { nodes, changed: events.length > 0 } };
  });
}

function sweepNodes(statePath, options) {
  const agents = options.agent === undefined ? ["codex", "claude"] : [requiredAdoptAgent(options.agent)];
  const quietAfter = optionalPositiveInteger(options["quiet-after"], "--quiet-after") || Number(process.env.MESH_GRAPH_QUIET_AFTER_SECONDS || 3600);
  const transcriptFacts = agents.flatMap((agent) => inspectTranscripts(agent).map((fact) => ({ ...fact, agent })));
  const tmuxSessions = inspectTmuxSessions();
  const observedAt = now();

  return mutate(statePath, (graph) => {
    const desired = graph.nodes.map((node) => ({ ...node }));
    const original = new Map(graph.nodes.map((node) => [node.id, node]));

    for (const fact of transcriptFacts) {
      let node = desired.find((item) => String(item.runtimeUuid || "").toLowerCase() === fact.runtimeUuid);
      const observedStatus = Date.now() - Date.parse(fact.updatedAt) >= quietAfter * 1000 ? "quiet" : "active";
      if (!node) {
        node = {
          id: `node-${randomUUID()}`, tmuxTarget: "", roleProfile: "", summary: "", refs: [],
          primaryDomains: [], domainPredecessors: {}, domainsExplicit: false, createdAt: observedAt,
        };
        desired.push(node);
      }
      Object.assign(node, {
        agent: fact.agent, cwd: fact.cwd, title: fact.title, runtimeUuid: fact.runtimeUuid,
        lastSeenAt: fact.updatedAt, class: node.class || "unclassified",
      });
      if (!node.domainsExplicit) node.domains = domainsFor(fact.cwd, {});
      if (!original.has(node.id) || (!node.tmuxTarget && ["active", "quiet"].includes(node.status))) node.status = observedStatus;
    }

    const liveTargets = new Set();
    for (const session of tmuxSessions) {
      liveTargets.add(session.tmuxTarget);
      let node = desired.find((item) => item.tmuxTarget === session.tmuxTarget);
      if (!node && session.runtimeUuid) node = desired.find((item) => String(item.runtimeUuid || "").toLowerCase() === session.runtimeUuid);
      if (!node) {
        node = {
          id: `node-${randomUUID()}`, roleProfile: "", title: "", summary: "", status: "active",
          class: "unclassified", domainsExplicit: false, primaryDomains: [], domainPredecessors: {},
          refs: [], createdAt: observedAt, runtimeUuid: null,
        };
        desired.push(node);
      }
      Object.assign(node, {
        agent: session.agent, tmuxTarget: session.tmuxTarget, cwd: session.cwd,
        lastSeenAt: observedAt, tmuxObservation: { state: "live", observedAt },
      });
      if (session.runtimeUuid) node.runtimeUuid = session.runtimeUuid;
      if (!node.domainsExplicit) node.domains = domainsFor(session.cwd, {});
      if (!original.has(node.id) || node.status === "quiet" || node.status === "closed") node.status = "active";
    }

    const worktreeStates = new Map();
    for (const node of desired) {
      if (!node.tmuxTarget || liveTargets.has(node.tmuxTarget)) continue;
      if (!worktreeStates.has(node.cwd)) worktreeStates.set(node.cwd, inspectWorktree(node.cwd));
      node.tmuxObservation = { state: "missing", observedAt, worktreeState: worktreeStates.get(node.cwd) };
      if (node.status !== "closed") node.status = "quiet";
    }

    const events = [];
    for (const node of desired) {
      const before = original.get(node.id);
      if (!before || JSON.stringify(node) !== JSON.stringify(before)) {
        node.updatedAt = observedAt;
        events.push(event("node.upserted", { node }));
      }
    }
    return {
      graph,
      events,
      result: {
        nodes: desired,
        liveTargets: tmuxSessions.map((session) => session.tmuxTarget),
        missingTargets: desired.filter((node) => node.tmuxTarget && !liveTargets.has(node.tmuxTarget)).map((node) => node.tmuxTarget),
        changed: events.length > 0,
      },
    };
  });
}

function inspectTmuxSessions() {
  const tmux = process.env.MESH_TMUX_BIN || "tmux";
  const socket = process.env.MESH_TMUX_SOCKET || "mesh";
  const separator = "::MESH::";
  const format = ["#{session_name}", "#{pane_pid}", "#{pane_current_command}", "#{pane_current_path}"].join(separator);
  const result = spawnSync(tmux, ["-L", socket, "list-panes", "-a", "-F", format], {
    encoding: "utf8", env: process.env, maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw new Error(`could not inspect tmux sessions: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`tmux inspection failed: ${(result.stderr || result.stdout || "unknown error").trim()}`);
  const sessions = new Map();
  for (const line of result.stdout.split("\n")) {
    if (!line) continue;
    const [tmuxTarget, pidText, command, cwd = ""] = line.split(separator);
    if (!tmuxTarget || sessions.has(tmuxTarget)) continue;
    const agent = agentFromCommand(command);
    if (!agent) continue;
    const pid = Number(pidText);
    sessions.set(tmuxTarget, {
      tmuxTarget, agent, cwd,
      runtimeUuid: Number.isInteger(pid) && pid > 0 ? runtimeUuidFromProcess(pid, agent) : null,
    });
  }
  return [...sessions.values()].sort((left, right) => left.tmuxTarget.localeCompare(right.tmuxTarget));
}

function agentFromCommand(command) {
  const basename = String(command || "").split("/").pop().toLowerCase();
  if (basename.includes("codex")) return "codex";
  if (basename.includes("claude")) return "claude";
  return null;
}

function runtimeUuidFromProcess(pid, agent) {
  const evidence = [];
  try { evidence.push(readFileSync(`/proc/${pid}/cmdline`, "utf8")); } catch {}
  try {
    for (const fd of readdirSync(`/proc/${pid}/fd`)) {
      try {
        const target = readlinkSync(`/proc/${pid}/fd/${fd}`);
        if (target.endsWith(".jsonl") && target.includes(agent === "codex" ? "/.codex/sessions/" : "/.claude/")) evidence.push(target);
      } catch {}
    }
  } catch {}
  const matches = new Set(evidence.flatMap((value) => String(value).toLowerCase().match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g) || []));
  return matches.size === 1 ? [...matches][0] : null;
}

function inspectWorktree(cwd) {
  if (!cwd || !existsSync(cwd)) return "unknown";
  const inside = spawnSync("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8", timeout: 10_000 });
  if (inside.status !== 0 || inside.stdout.trim() !== "true") return "unknown";
  const status = spawnSync("git", ["-C", cwd, "status", "--porcelain=v1", "--untracked-files=normal"], {
    encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024 * 1024,
  });
  if (status.status !== 0 || status.error) return "unknown";
  return status.stdout.length > 0 ? "dirty" : "clean";
}

function claimDomain(statePath, options) {
  const id = requiredSingleLine(options.id, "--id"), domain = requiredDomain(options.domain, "--domain");
  if (requiredSingleLine(options.role, "--role") !== "orchestrator") throw new Error("claim --role must be orchestrator");
  const takeover = options["take-over"] === undefined ? "" : requiredSingleLine(options["take-over"], "--take-over");
  return mutate(statePath, (graph) => {
    const node = graph.nodes.find((item) => item.id === id);
    if (!node) throw new Error(`node not found: ${id}`);
    const incumbent = graph.nodes.find((item) => item.id !== id && item.status !== "closed" && (item.primaryDomains || []).includes(domain));
    if (incumbent && takeover !== incumbent.id) throw new Error(`domain '${domain}' already has live primary ${incumbent.id}; rerun with --take-over ${incumbent.id} after human approval`);
    if (takeover && !incumbent) throw new Error(`--take-over ${takeover} is not the live primary for '${domain}'`);
    const events = [];
    if (incumbent) events.push(event("node.upserted", { node: { ...incumbent, primaryDomains: incumbent.primaryDomains.filter((item) => item !== domain), updatedAt: now() } }));
    const claimed = { ...node, class: "orchestrator", domains: [...new Set([...(node.domains || []), domain])], primaryDomains: [...new Set([...(node.primaryDomains || []), domain])], domainPredecessors: { ...(node.domainPredecessors || {}), ...(incumbent ? { [domain]: incumbent.id } : {}) }, updatedAt: now() };
    if (!incumbent && JSON.stringify(claimed) === JSON.stringify(node)) return { graph, result: inheritanceResult(claimed, null) };
    events.push(event("node.upserted", { node: claimed }));
    return { graph, events, result: inheritanceResult(claimed, incumbent || null) };
  });
}

function inheritanceResult(node, predecessor) {
  const source = predecessor || node;
  return { node, predecessor: predecessor ? { id: predecessor.id, agent: predecessor.agent, runtimeUuid: predecessor.runtimeUuid } : null, refs: source.refs || [], liveChildren: [] };
}

function nodeChanges(node, options) {
  const changes = {};
  const fields = [
    ["agent", "agent"],
    ["cwd", "cwd"],
    ["role-profile", "roleProfile"],
    ["title", "title"],
    ["summary", "summary"],
    ["runtime-uuid", "runtimeUuid"],
    ["class", "class"],
  ];
  for (const [option, field] of fields) {
    if (options[option] === undefined) continue;
    const value = field === "summary" ? requiredSummary(options[option]) : field === "class" ? nodeClass(options[option]) : field === "runtimeUuid" ? requiredRuntimeUuid(options[option]) : requiredSingleLine(options[option], `--${option}`);
    if (node[field] !== value) changes[field] = value;
  }
  if (options.domains !== undefined || (options.cwd !== undefined && !node.domainsExplicit)) {
    const domains = domainsFor(options.cwd !== undefined ? requiredSingleLine(options.cwd, "--cwd") : node.cwd, options);
    if (JSON.stringify(domains) !== JSON.stringify(node.domains || [])) changes.domains = domains;
    if (options.domains !== undefined) changes.domainsExplicit = true;
  }
  if (options.status !== undefined) {
    assertStatus(options.status);
    if (node.status !== options.status) changes.status = options.status;
  }
  const refs = refsChanges(node.refs, options);
  if (node.refs === undefined || JSON.stringify(refs) !== JSON.stringify(normalizeRefs(node.refs))) changes.refs = refs;
  return changes;
}

function refsChanges(current, options) {
  const refs = normalizeRefs(current);
  if (options.refs !== undefined) return parseRefs(options.refs);
  return refs;
}

function parseRefs(value) {
  if (value.includes("\n") || value.includes("\r")) throw new Error("--refs must be a single line");
  const refs = value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
  for (const ref of refs) {
    if (!OPAQUE_REF.test(ref)) throw new Error(`--refs contains invalid opaque ref '${ref}'`);
  }
  return [...new Set(refs)];
}

function updateRef(statePath, operation, options) {
  if (operation !== "add" && operation !== "remove") throw new Error("ref operation must be add or remove");
  const opaqueRef = requiredOpaqueRef(options.ref);
  return mutate(statePath, (graph) => {
    const existing = selectNode(graph, options);
    const refs = normalizeRefs(existing.refs);
    const present = refs.includes(opaqueRef);
    if ((operation === "add" && present) || (operation === "remove" && !present)) {
      return { graph, result: { node: existing, changed: false } };
    }
    const node = {
      ...existing,
      refs: operation === "add" ? [...refs, opaqueRef] : refs.filter((item) => item !== opaqueRef),
      updatedAt: now(),
    };
    return { graph, event: event("node.upserted", { node }), result: { node, changed: true } };
  });
}

function selectNode(graph, options) {
  const byId = options.id !== undefined;
  const byRuntimeUuid = options["runtime-uuid"] !== undefined;
  if (byId === byRuntimeUuid) throw new Error("select exactly one node with --id or --runtime-uuid");
  if (byId) {
    const id = requiredSingleLine(options.id, "--id");
    const node = graph.nodes.find((item) => item.id === id);
    if (!node) throw new Error(`node not found: ${id}`);
    return node;
  }
  const runtimeUuid = requiredRuntimeUuid(options["runtime-uuid"]);
  const matches = graph.nodes.filter((item) => String(item.runtimeUuid || "").toLowerCase() === runtimeUuid);
  if (matches.length === 0) throw new Error(`node not found for runtime UUID: ${runtimeUuid}`);
  if (matches.length > 1) throw new Error(`runtime UUID matches multiple nodes: ${runtimeUuid}; select one with --id`);
  return matches[0];
}

function addEdge(statePath, options) {
  const from = requiredSingleLine(options.from, "--from");
  const to = requiredSingleLine(options.to, "--to");
  const type = requiredSingleLine(options.type, "--type");
  if (from === to) throw new Error("--from and --to must name different nodes");
  if (!EDGE_TYPES.has(type)) throw new Error(`--type must be one of: ${[...EDGE_TYPES].join(", ")}`);

  return mutate(statePath, (graph) => {
    if (!graph.nodes.some((node) => node.id === from)) throw new Error(`source node not found: ${from}`);
    if (!graph.nodes.some((node) => node.id === to)) throw new Error(`target node not found: ${to}`);
    const existing = graph.edges.find((edge) => edge.from === from && edge.to === to && edge.type === type);
    if (existing) return { graph, result: { edge: existing, changed: false } };
    const edge = { id: `edge-${randomUUID()}`, from, to, type, createdAt: now() };
    return { graph, event: event("edge.added", { edge }), result: { edge, changed: true } };
  });
}

function updateSummary(statePath, options) {
  const id = requiredSingleLine(options.id, "--id");
  const summary = requiredSummary(options.summary);
  return mutate(statePath, (graph) => {
    const existing = graph.nodes.find((node) => node.id === id);
    if (!existing) throw new Error(`node not found: ${id}`);
    const node = { ...existing, summary, updatedAt: now() };
    if (options.status !== undefined) {
      assertStatus(options.status);
      node.status = options.status;
    }
    if (node.summary === existing.summary && node.status === existing.status) {
      return { graph, result: { node: existing, changed: false } };
    }
    return { graph, event: event("node.upserted", { node }), result: { node, changed: true } };
  });
}

function purgeNode(statePath, options) {
  const id = requiredSingleLine(options.id, "--id");
  return mutate(statePath, (graph) => {
    if (!graph.nodes.some((node) => node.id === id)) throw new Error(`node not found: ${id}`);
    return { graph, event: event("node.purged", { id }), result: { node: { id }, changed: true } };
  });
}

function closeNode(statePath, options) {
  const id = requiredSingleLine(options.id, "--id");
  return mutate(statePath, (graph) => {
    const existing = graph.nodes.find((node) => node.id === id);
    if (!existing) throw new Error(`node not found: ${id}`);
    if (existing.status === "closed") return { graph, result: { node: existing, changed: false } };
    const node = { ...existing, status: "closed", updatedAt: now() };
    return { graph, event: event("node.upserted", { node }), result: { node, changed: true } };
  });
}

function showGraph(statePath, options) {
  const graph = loadGraph(statePath);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(graph)}\n`);
    return;
  }
  if (options.tree) {
    process.stdout.write(`${renderTree(graph)}\n`);
    return;
  }
  process.stdout.write(`${renderCompact(graph)}\n`);
}

function printResult(result, options) {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  const item = result.node || result.edge;
  const identity = result.node ? result.node.id : item.id;
  process.stdout.write(`${identity}${result.changed ? "" : " (unchanged)"}\n`);
}

function mutate(statePath, operation) {
  ensureStateDir(statePath);
  return withLock(statePath, () => {
    const graph = loadGraph(statePath);
    const result = operation(graph);
    const events = result.events || (result.event ? [result.event] : []);
    if (events.length === 0) return result.result;
    for (const item of events) appendEvent(statePath, item);
    const derived = deriveGraph(readEvents(statePath));
    writeProjection(statePath, derived);
    return result.result;
  });
}

function loadGraph(statePath) {
  if (!existsSync(join(statePath, "events.jsonl"))) return emptyGraph();
  return deriveGraph(readEvents(statePath));
}

function readEvents(statePath) {
  const path = join(statePath, "events.jsonl");
  if (!existsSync(path)) return [];
  const body = readFileSync(path, "utf8").trim();
  if (!body) return [];
  return body.split("\n").map((line, index) => {
    try {
      const parsed = JSON.parse(line);
      if (parsed.schema !== EVENT_SCHEMA || typeof parsed.type !== "string") {
        throw new Error("invalid event schema");
      }
      return parsed;
    } catch (error) {
      throw new Error(`invalid event at ${path}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

function deriveGraph(events) {
  const nodes = new Map();
  const edges = new Map();
  for (const item of events) {
    if (item.type === "node.upserted") {
      validateNode(item.node);
      nodes.set(item.node.id, normalizeNode(item.node));
      continue;
    }
    if (item.type === "edge.added") {
      validateEdge(item.edge);
      edges.set(item.edge.id, item.edge);
      continue;
    }
    if (item.type === "node.purged") {
      if (typeof item.id !== "string") throw new Error("node.purged event has invalid id");
      nodes.delete(item.id);
      for (const [edgeId, edge] of edges) if (edge.from === item.id || edge.to === item.id) edges.delete(edgeId);
      continue;
    }
    throw new Error(`unsupported event type '${item.type}'`);
  }
  return {
    schema: GRAPH_SCHEMA,
    generatedAt: now(),
    nodes: [...nodes.values()].sort((left, right) => left.id.localeCompare(right.id)),
    edges: [...edges.values()].sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function emptyGraph() {
  return { schema: GRAPH_SCHEMA, generatedAt: now(), nodes: [], edges: [] };
}

function normalizeNode(node) {
  const { meta: _legacyMeta, ...normalized } = node;
  return { ...normalized, refs: normalizeRefs(node.refs), class: NODE_CLASSES.has(node.class) ? node.class : "unclassified", domains: normalizeDomains(node.domains), domainsExplicit: node.domainsExplicit === true, primaryDomains: normalizeDomains(node.primaryDomains), domainPredecessors: normalizePredecessors(node.domainPredecessors), lastSeenAt: typeof node.lastSeenAt === "string" ? node.lastSeenAt : node.updatedAt };
}

function normalizeDomains(value) {
  return Array.isArray(value) ? [...new Set(value.filter((item) => typeof item === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(item)))] : [];
}

function normalizePredecessors(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([domain, id]) => /^[a-z][a-z0-9-]{0,63}$/.test(domain) && typeof id === "string"));
}

function normalizeRefs(refs) {
  return Array.isArray(refs) ? [...new Set(refs)] : [];
}

function event(type, payload) {
  return {
    schema: EVENT_SCHEMA,
    id: `event-${randomUUID()}`,
    at: now(),
    type,
    ...payload,
  };
}

function appendEvent(statePath, item) {
  const fd = openSync(join(statePath, "events.jsonl"), "a", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(item)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeProjection(statePath, graph) {
  const path = join(statePath, "graph.json");
  writeAtomic(path, `${JSON.stringify(graph, null, 2)}\n`);
}

function writeAtomic(path, contents) {
  assertProjectionDirectory(path);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, contents, { mode: 0o600 });
  renameSync(temporary, path);
}

function assertProjectionDirectory(path) {
  const directory = dirname(resolve(path));
  if (!existsSync(directory)) throw new Error(`projection directory does not exist: ${directory}`);
}

function ensureStateDir(statePath) {
  mkdirSync(statePath, { recursive: true, mode: 0o700 });
}

function withLock(statePath, callback) {
  const lock = join(statePath, "graph.lock");
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const stale = Date.now() - statSync(lock).mtimeMs > 60_000;
      if (stale) {
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`graph is busy: ${lock}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    return callback();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function renderCompact(graph) {
  if (graph.nodes.length === 0) return "(empty)";
  return graph.nodes.map((node) => {
    const detail = node.summary || "-";
    return `${node.id} [${node.status}] ${node.agent}@${node.tmuxTarget || `runtime:${node.runtimeUuid || "unknown"}`}: ${detail}`;
  }).join("\n");
}

function renderTree(graph) {
  if (graph.nodes.length === 0) return "(empty)";
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const hierarchical = graph.edges.filter((edge) => edge.type === "spawned-by" || edge.type === "delegates-to");
  const children = new Map();
  const childIds = new Set();
  for (const edge of hierarchical) {
    if (!children.has(edge.from)) children.set(edge.from, []);
    children.get(edge.from).push(edge);
    childIds.add(edge.to);
  }
  for (const entries of children.values()) entries.sort((left, right) => left.to.localeCompare(right.to));
  const roots = graph.nodes.filter((node) => !childIds.has(node.id));
  const lines = [];
  const visit = (node, indent, ancestry, label = "") => {
    lines.push(`${indent}${label}${node.id} [${node.status}] ${node.agent}@${node.tmuxTarget || `runtime:${node.runtimeUuid || "unknown"}`}${node.summary ? ` — ${node.summary}` : ""}`);
    if (ancestry.has(node.id)) {
      lines.push(`${indent}  (cycle)`);
      return;
    }
    const next = new Set(ancestry).add(node.id);
    for (const edge of children.get(node.id) || []) {
      const child = byId.get(edge.to);
      if (child) visit(child, `${indent}  `, next, `${edge.type}: `);
    }
  };
  for (const root of roots) visit(root, "", new Set());
  for (const node of graph.nodes) if (!roots.includes(node) && !lines.some((line) => line.includes(node.id))) visit(node, "", new Set());
  const lateral = graph.edges.filter((edge) => edge.type === "linked" || edge.type === "watches");
  if (lateral.length > 0) {
    lines.push("links:");
    for (const edge of lateral) lines.push(`  ${edge.type}: ${edge.from} -> ${edge.to}`);
  }
  return lines.join("\n");
}

function validateNode(node) {
  if (!node || typeof node !== "object") throw new Error("node event is missing a node");
  for (const key of ["id", "agent", "tmuxTarget", "cwd", "roleProfile", "title", "summary", "status", "createdAt", "updatedAt"]) {
    if (typeof node[key] !== "string") throw new Error(`node '${node.id || "?"}' has invalid ${key}`);
  }
  if (!(node.runtimeUuid === null || typeof node.runtimeUuid === "string")) throw new Error(`node '${node.id}' has invalid runtimeUuid`);
  if (node.refs !== undefined) {
    if (!Array.isArray(node.refs)) throw new Error(`node '${node.id}' has invalid refs`);
    for (const ref of node.refs) if (typeof ref !== "string" || !OPAQUE_REF.test(ref)) throw new Error(`node '${node.id}' has invalid opaque ref`);
  }
  if (node.class !== undefined && !NODE_CLASSES.has(node.class)) throw new Error(`node '${node.id}' has invalid class`);
  if (node.domains !== undefined && (!Array.isArray(node.domains) || node.domains.some((domain) => typeof domain !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(domain)))) throw new Error(`node '${node.id}' has invalid domains`);
  if (node.primaryDomains !== undefined && (!Array.isArray(node.primaryDomains) || node.primaryDomains.some((domain) => typeof domain !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(domain)))) throw new Error(`node '${node.id}' has invalid primaryDomains`);
  if (node.tmuxObservation !== undefined) {
    const observation = node.tmuxObservation;
    if (!observation || typeof observation !== "object" || !["live", "missing"].includes(observation.state) || typeof observation.observedAt !== "string") throw new Error(`node '${node.id}' has invalid tmuxObservation`);
    if (observation.worktreeState !== undefined && !["dirty", "clean", "unknown"].includes(observation.worktreeState)) throw new Error(`node '${node.id}' has invalid worktreeState`);
  }
  assertStatus(node.status);
}

function validateEdge(edge) {
  if (!edge || typeof edge !== "object") throw new Error("edge event is missing an edge");
  for (const key of ["id", "from", "to", "type", "createdAt"]) {
    if (typeof edge[key] !== "string") throw new Error("edge has invalid fields");
  }
  if (!EDGE_TYPES.has(edge.type)) throw new Error(`edge '${edge.id}' has invalid type`);
}

function required(value, flag) {
  if (value === undefined || value === "") throw new Error(`${flag} is required`);
  return value;
}

function requiredSingleLine(value, flag) {
  value = required(value, flag);
  if (value.includes("\n") || value.includes("\r")) throw new Error(`${flag} must be a single line`);
  return value;
}

function optionalSingleLine(value, flag) {
  if (value === undefined) return undefined;
  return requiredSingleLine(value, flag);
}

function requiredSummary(value) {
  value = requiredSingleLine(value, "--summary");
  if (value.length > MAX_SUMMARY_LENGTH) throw new Error(`--summary must be at most ${MAX_SUMMARY_LENGTH} characters`);
  return value;
}

function optionalSummary(value) {
  if (value === undefined) return undefined;
  return requiredSummary(value);
}

function requiredAdoptAgent(value) {
  value = requiredSingleLine(value, "--agent");
  if (value !== "codex" && value !== "claude") throw new Error("adopt --agent must be codex or claude");
  return value;
}

function requiredRuntimeUuid(value) {
  value = requiredSingleLine(value, "--runtime-uuid").toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new Error("--runtime-uuid must be a complete UUID");
  }
  return value;
}

function optionalRuntimeUuid(value) {
  return value === undefined ? undefined : requiredRuntimeUuid(value);
}

function requiredOpaqueRef(value) {
  value = requiredSingleLine(value, "--ref");
  if (!OPAQUE_REF.test(value)) throw new Error(`--ref contains invalid opaque ref '${value}'`);
  return value;
}

function nodeClass(value) {
  if (value === undefined) return "unclassified";
  value = requiredSingleLine(value, "--class");
  if (!NODE_CLASSES.has(value)) throw new Error(`--class must be one of: ${[...NODE_CLASSES].join(", ")}`);
  return value;
}

function requiredDomain(value, flag) {
  value = requiredSingleLine(value, flag);
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(value)) throw new Error(`${flag} must be a lowercase domain identifier`);
  return value;
}

function domainsFor(cwd, options) {
  if (options.domains !== undefined) return String(options.domains).split(/[\s,]+/).filter(Boolean).map((value) => requiredDomain(value, "--domains"));
  const configured = domainRoots();
  const normalizedCwd = resolve(cwd || ".");
  return configured.filter((item) => normalizedCwd === item.root || normalizedCwd.startsWith(`${item.root}/`)).sort((left, right) => right.root.length - left.root.length).map((item) => item.domain).slice(0, 1);
}

function domainRoots() {
  const path = process.env.MESH_DOMAIN_ROOTS_FILE;
  if (!path) return [];
  let parsed;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch (error) { throw new Error(`could not read MESH_DOMAIN_ROOTS_FILE: ${error instanceof Error ? error.message : String(error)}`); }
  const roots = Array.isArray(parsed) ? parsed : parsed?.roots ?? parsed?.domains;
  if (!Array.isArray(roots)) throw new Error("MESH_DOMAIN_ROOTS_FILE must be a JSON array or { roots: [...] } / { domains: [...] }");
  return roots.map((item) => ({ domain: requiredDomain(item?.domain, "domain root domain"), root: resolve(requiredSingleLine(item?.root, "domain root root")) }));
}

function optionalPositiveInteger(value, flag) {
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${flag} must be a positive integer`);
  return Number(value);
}

function assertStatus(status) {
  if (!NODE_STATUSES.has(status)) throw new Error(`--status must be one of: ${[...NODE_STATUSES].join(", ")}`);
}

function now() {
  return new Date().toISOString();
}

function fail(message) {
  process.stderr.write(`mesh-graph: ${message}\n`);
  process.exit(2);
}

function printHelp() {
  process.stdout.write(`Usage:\n  mesh-graph add --agent <agent> --tmux-target <target> [--class <class>] [--domains domain,...] [--cwd <cwd>] ...\n  mesh-graph adopt --agent codex|claude --runtime-uuid <uuid> --class orchestrator|worker|observer|ephemeral [--domains domain,...] [--state <dir>] [--json]\n  mesh-graph discover --agent codex|claude [--quiet-after seconds] [--state <dir>] [--json]\n  mesh-graph sweep [--agent codex|claude] [--quiet-after seconds] [--state <dir>] [--json]\n  mesh-graph claim --id <node-id> --role orchestrator --domain <domain> [--take-over <incumbent-id>] [--state <dir>] [--json]\n  mesh-graph ref add|remove (--id <node-id> | --runtime-uuid <uuid>) --ref <opaque-ref> [--state <dir>] [--json]\n  mesh-graph link|summary|close|purge|show ...\n\nClasses are explicit; discovery defaults to unclassified. Domain roots come only from MESH_DOMAIN_ROOTS_FILE private JSON configuration: a JSON array, { roots: [...] }, or { domains: [...] }. Sweep reconciles persisted sessions with live tmux targets. A missing target becomes quiet with dirty, clean, or unknown worktree evidence; sweep never closes a node. Claims fail on a live primary unless the human explicitly names --take-over. Refs are opaque, may be shared by multiple nodes, and are never resolved or arbitrated.\n`);
}
