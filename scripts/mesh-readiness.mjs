#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseMeshV1Envelope, planMeshV1Dispatch } from "../packages/core/src/policy.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checks = [];
const agentTmuxBundleFiles = [
  "bin/_mesh-tmux.sh",
  "bin/agent-read.sh",
  "bin/agent-send.sh",
  "bin/agent-session.sh",
  "bin/agent-wait.sh",
  "bin/mesh-list-agents.sh",
  "bin/mesh-models.sh",
  "bin/mesh-send.sh",
  "bin/session-writer-status.mjs",
  "agents/claude.conf",
  "agents/codex.conf"
];
const snowflakeIdPattern = /\b(?!([0-9])\1{16,19}\b)\d{17,20}\b/;
function check(name, fn) { try { fn(); checks.push({ name, ok: true }); } catch (error) { checks.push({ name, ok: false, error: error.message }); } }
function assert(condition, message) { if (!condition) throw new Error(message); }
check("parse Mesh v1 headers", () => { const envelope = parseMeshV1Envelope("cc-mesh: alpha\ncc-mesh-from: beta\ncc-mesh-id: ready-1\ncc-mesh-turn: alpha\ncc-mesh-final: false\nhop-limit: 2\n\nhello"); assert(envelope.valid, `expected valid envelope: ${envelope.errors.join(",")}`); assert(envelope.final === false, "expected partial final flag"); assert(envelope.hopLimit === 2, "expected hop limit parse"); });
check("parse compact ccm:v1 headers", () => { const envelope = parseMeshV1Envelope("<@123>\nccm:v1 id=ready-compact from=beta turn=alpha final=1 seen=beta hop=2\n\nhello"); assert(envelope.valid, `expected valid compact envelope: ${envelope.errors.join(",")}`); assert(envelope.format === "ccm:v1", "expected compact format marker"); assert(envelope.final === true, "expected compact final flag"); assert(envelope.to[0] === "alpha", "expected compact turn to become recipient"); assert(envelope.body === "hello", "expected compact body parse"); });
check("partial buffers only", () => { const plan = planMeshV1Dispatch({ localParticipant: "alpha" }, { messageId: "ready-m1", text: "cc-mesh: alpha\ncc-mesh-from: beta\ncc-mesh-id: ready-2\ncc-mesh-turn: alpha\ncc-mesh-final: false\n\npart" }); assert(plan.nextAction === "buffer_only", `expected buffer_only got ${plan.nextAction}`); assert(!plan.dispatchText, "partial must not dispatch text"); });
check("final dispatches once", () => { const partial = planMeshV1Dispatch({ localParticipant: "alpha" }, { messageId: "ready-m2", text: "cc-mesh: alpha\ncc-mesh-from: beta\ncc-mesh-id: ready-3\ncc-mesh-turn: alpha\ncc-mesh-final: false\n\nfirst" }); const final = planMeshV1Dispatch({ localParticipant: "alpha" }, { messageId: "ready-m3", state: partial.stateTransition, text: "cc-mesh: alpha\ncc-mesh-from: beta\ncc-mesh-id: ready-3\ncc-mesh-turn: alpha\ncc-mesh-final: true\n\nsecond" }); assert(final.nextAction === "dispatch_once", `expected dispatch_once got ${final.nextAction}`); assert(final.dispatchText === "first\nsecond", "expected assembled context"); });
check("duplicate final suppressed", () => { const final = planMeshV1Dispatch({ localParticipant: "alpha" }, { messageId: "ready-m4", text: "cc-mesh: alpha\ncc-mesh-from: beta\ncc-mesh-id: ready-4\ncc-mesh-turn: alpha\ncc-mesh-final: true\n\nfinal" }); const duplicate = planMeshV1Dispatch({ localParticipant: "alpha" }, { messageId: "ready-m5", state: final.stateTransition, text: "cc-mesh: alpha\ncc-mesh-from: beta\ncc-mesh-id: ready-4\ncc-mesh-turn: alpha\ncc-mesh-final: true\n\nagain" }); assert(duplicate.nextAction === "none", `expected duplicate suppression got ${duplicate.nextAction}`); });
check("turn gate fails closed", () => { const plan = planMeshV1Dispatch({ localParticipant: "alpha" }, { text: "cc-mesh: alpha\ncc-mesh-from: beta\ncc-mesh-id: ready-5\ncc-mesh-turn: gamma\ncc-mesh-final: true\n\nhello" }); assert(plan.reason === "mesh_v1_not_local_turn", `expected turn gate got ${plan.reason}`); });
check("seen loop guard fails closed", () => { const plan = planMeshV1Dispatch({ localParticipant: "alpha" }, { text: "cc-mesh: alpha\ncc-mesh-from: beta\ncc-mesh-id: ready-6\ncc-mesh-turn: alpha\ncc-mesh-final: true\ncc-mesh-seen: beta,alpha\n\nhello" }); assert(plan.reason === "mesh_v1_loop_guard_seen", `expected loop guard got ${plan.reason}`); });
check("privacy snowflake rule ignores repeated placeholders", () => { assert(!snowflakeIdPattern.test("111111111111111111"), "repeated-digit placeholder must not be flagged"); assert(!snowflakeIdPattern.test("222222222222222222"), "repeated-digit placeholder must not be flagged"); assert(snowflakeIdPattern.test("123456789" + "012345678"), "mixed-digit snowflake-shaped ID must be flagged"); });
check("public-tree privacy sanity", () => { const deny = [snowflakeIdPattern, /\/home\/administrator\/env\/workspace\/example-business\//, /(api[_-]?key|secret|password|token)\s*[:=]\s*["'][^"']{6,}["']/i]; const skipDirs = new Set([".git", "node_modules", "dist"]); const skipPaths = new Set([".syncwheel/ledger"]); const hits = []; function walk(dir) { if (skipPaths.has(path.relative(root, dir))) return; for (const entry of readdirSync(dir)) { if (skipDirs.has(entry)) continue; const full = path.join(dir, entry); const stat = statSync(full); if (stat.isDirectory()) walk(full); else if (stat.isFile()) { const text = readFileSync(full, "utf8"); for (const pattern of deny) if (pattern.test(text)) hits.push(path.relative(root, full)); } } } walk(root); assert(hits.length === 0, `privacy scan hits: ${[...new Set(hits)].join(", ")}`); });
check("agent-tmux skill bundle sync", () => { const drifted = agentTmuxBundleFiles.filter((relativePath) => { try { return !readFileSync(path.join(root, "packages/tmux-bridge", relativePath)).equals(readFileSync(path.join(root, "skills/agent-tmux", relativePath))); } catch { return true; } }); assert(drifted.length === 0, `agent-tmux skill bundle drift: ${drifted.join(", ")}`); });
for (const result of checks) console.log(`${result.ok ? "PASS" : "FAIL"} ${result.name}${result.ok ? "" : `: ${result.error}`}`);
if (checks.some((result) => !result.ok)) process.exit(1);
