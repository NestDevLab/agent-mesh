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
  readFileSync,
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
const NODE_STATUSES = new Set(["active", "waiting", "blocked", "closed"]);
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
    summary: { type: "string" },
    status: { type: "string" },
    "runtime-uuid": { type: "string" },
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
if (positionals.length !== 1) fail("only one command may be supplied");

const command = positionals[0];
const stateDir = resolve(values.state || GRAPH_DIR);

try {
  switch (command) {
    case "add":
      printResult(addNode(stateDir, values), values);
      break;
    case "adopt":
      printResult(adoptNode(stateDir, values), values);
      break;
    case "link":
      printResult(addEdge(stateDir, values), values);
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
      runtimeUuid: optionalSingleLine(options["runtime-uuid"], "--runtime-uuid") || null,
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
  const facts = inspectTranscript(agent, runtimeUuid);
  return mutate(statePath, (graph) => {
    const existing = graph.nodes.find((node) => String(node.runtimeUuid || "").toLowerCase() === runtimeUuid);
    if (existing) {
      const changes = {};
      for (const [field, value] of [["agent", agent], ["cwd", facts.cwd], ["title", facts.title], ["runtimeUuid", runtimeUuid]]) {
        if (existing[field] !== value) changes[field] = value;
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
      runtimeUuid,
      refs: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    return { graph, event: event("node.upserted", { node }), result: { node, changed: true } };
  });
}

function inspectTranscript(agent, runtimeUuid) {
  const localWatcher = join(dirname(new URL(import.meta.url).pathname), "agent-watch.py");
  const watcher = existsSync(localWatcher)
    ? localWatcher
    : process.env.AGENT_MESH_ROOT
      ? join(process.env.AGENT_MESH_ROOT, "packages", "tmux-bridge", "bin", "agent-watch.py")
      : localWatcher;
  if (!existsSync(watcher)) throw new Error("transcript inspection requires agent-watch.py beside mesh-graph or under AGENT_MESH_ROOT");
  const result = spawnSync(process.env.PYTHON || "python3", [
    watcher, runtimeUuid, "--agent", agent, "--inspect", "--format", "jsonl",
  ], { encoding: "utf8", env: process.env });
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
  return facts;
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
  ];
  for (const [option, field] of fields) {
    if (options[option] === undefined) continue;
    const value = field === "summary" ? requiredSummary(options[option]) : requiredSingleLine(options[option], `--${option}`);
    if (node[field] !== value) changes[field] = value;
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
    if (!result.event) return result.result;
    appendEvent(statePath, result.event);
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
  return { ...normalized, refs: normalizeRefs(node.refs) };
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
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new Error("--runtime-uuid must be a complete UUID");
  }
  return value;
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
  process.stdout.write(`Usage:\n  mesh-graph add --agent <agent> --tmux-target <target> [--cwd <cwd>] [--role-profile <role>] [--title <title>] [--summary <summary>] [--status active|waiting|blocked|closed] [--runtime-uuid <uuid>] [--refs source:id,...] [--state <dir>] [--json]\n  mesh-graph adopt --agent codex|claude --runtime-uuid <uuid> [--state <dir>] [--json]\n  mesh-graph link --from <node-id> --to <node-id> --type spawned-by|delegates-to|linked|watches [--state <dir>] [--json]\n  mesh-graph summary --id <node-id> --summary <summary> [--status active|waiting|blocked|closed] [--state <dir>] [--json]\n  mesh-graph close --id <node-id> [--state <dir>] [--json]\n  mesh-graph purge --id <node-id> [--state <dir>] [--json]\n  mesh-graph show [--tree|--json|--compact] [--state <dir>]\n\nNodes are generated once per tmux target. Adopted Desktop sessions are keyed by runtime UUID, read only their transcript, and keep an empty summary until a human sets one. Refs are explicit opaque source-qualified strings; the graph never resolves or infers them.\n`);
}
