#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { parseMeshV1Envelope, planMeshV1Dispatch } from "../packages/core/src/policy.js";
import { containsPrivatePlexusPolicy, isGeneratedPythonBytecode, isPlexusMechanismFile } from "./plexus-privacy.mjs";
import { plexusDiagram } from "./plexus-diagram.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let trackedFiles = null;
try { trackedFiles = new Set(execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0")); } catch { /* Without Git, scan every file. */ }
const checks = [];
const agentTmuxBundleFiles = [
  "bin/agent-mesh",
  "bin/mesh-comms.py",
  "bin/mesh-groups.py",
  "bin/mesh_group_import.py",
  "bin/mesh_group_store.py",
  "bin/comms-client.mjs",
  "bin/_mesh-graph.sh",
  "bin/_mesh-result.sh",
  "bin/_mesh-tmux.sh",
  "bin/agent-read.sh",
  "bin/agent-follow.py",
  "bin/agent-watch.py",
  "bin/agent-waker.py",
  "bin/agent-send.sh",
  "bin/agent-spawn.sh",
  "bin/agent-session.sh",
  "bin/agent-native-call.mjs",
  "bin/cloud-account-binding.mjs",
  "bin/codex-app-server.mjs",
  "bin/codex-goal.mjs",
  "bin/agent-goal.mjs",
  "bin/claude-goal.mjs",
  "bin/agent-goal-watch.mjs",
  "bin/agent-session-inbox.py",
  "bin/agent-inbox-native.py",
  "bin/codex-resume-options.py",
  "bin/claude-session-ownership.mjs",
  "bin/codex-owned-pane.mjs",
  "bin/agent-wait.sh",
  "bin/mesh-list-agents.sh",
  "bin/mesh-capacity-dispatch.mjs",
  "bin/mesh-graph.mjs",
  "bin/plexus.mjs",
  "bin/channel-state.mjs",
  "bin/claude-delivery-observation.mjs",
  "bin/handover-state-proof.mjs",
  "bin/handover-notice.mjs",
  "bin/handover-dry-run.mjs",
  "bin/successor-launch-controller.mjs",
  "bin/bound-role-preflight.mjs",
  "bin/sealed-restart.py",
  "bin/sealed-restart-validate.py",
  "bin/sealed-restart-validate.mjs",
  "bin/handover-codex-observation.mjs",
  "bin/codex-compaction-evidence.mjs",
  "bin/codex-wake-evidence.mjs",
  "bin/restart-state.mjs",
  "bin/role-launch-profile.mjs",
  "bin/role-mcp-probe.mjs",
  "bin/restart-yaml.py",
  "bin/ledger-view.mjs",
  "bin/session-catalog.mjs",
  "bin/session-links.mjs",
  "bin/session-link-sources.py",
  "bin/session-metadata.mjs",
  "bin/session-controller.py",
  "bin/mesh-ledger.py",
  "bin/ledger_item_lock.py",
  "bin/mesh-group-send.py",
  "bin/mesh_group_dispatch.py",
  "bin/agent-decision.py",
  "bin/agent-decisions.py",
  "bin/agent-lifecycle-beat.py",
  "bin/agent-plexus-observer.py",
  "bin/agent-lifecycle.py",
  "bin/mesh-models.sh",
  "bin/mesh-send.sh",
  "bin/session-writer-status.mjs",
  "agents/claude.conf",
  "agents/codex.conf"
];
const snowflakeIdPattern = /\b(?!([0-9])\1{16,19}\b)\d{17,20}\b/;
function check(name, fn) { try { fn(); checks.push({ name, ok: true }); } catch (error) { checks.push({ name, ok: false, error: error.message }); } }
function assert(condition, message) { if (!condition) throw new Error(message); }
check("Plexus architecture diagram sync", () => { assert(readFileSync(path.join(root, "docs/design/plexus-architecture.mmd"), "utf8") === plexusDiagram, "Plexus architecture diagram differs from its source"); });
check("parse Mesh v1 headers", () => { const envelope = parseMeshV1Envelope("cc-mesh: alpha\ncc-mesh-from: beta\ncc-mesh-id: ready-1\ncc-mesh-turn: alpha\ncc-mesh-final: false\nhop-limit: 2\n\nhello"); assert(envelope.valid, `expected valid envelope: ${envelope.errors.join(",")}`); assert(envelope.final === false, "expected partial final flag"); assert(envelope.hopLimit === 2, "expected hop limit parse"); });
check("parse compact ccm:v1 headers", () => { const envelope = parseMeshV1Envelope("<@123>\nccm:v1 id=ready-compact from=beta turn=alpha final=1 seen=beta hop=2\n\nhello"); assert(envelope.valid, `expected valid compact envelope: ${envelope.errors.join(",")}`); assert(envelope.format === "ccm:v1", "expected compact format marker"); assert(envelope.final === true, "expected compact final flag"); assert(envelope.to[0] === "alpha", "expected compact turn to become recipient"); assert(envelope.body === "hello", "expected compact body parse"); });
check("partial buffers only", () => { const plan = planMeshV1Dispatch({ localParticipant: "alpha" }, { messageId: "ready-m1", text: "cc-mesh: alpha\ncc-mesh-from: beta\ncc-mesh-id: ready-2\ncc-mesh-turn: alpha\ncc-mesh-final: false\n\npart" }); assert(plan.nextAction === "buffer_only", `expected buffer_only got ${plan.nextAction}`); assert(!plan.dispatchText, "partial must not dispatch text"); });
check("final dispatches once", () => { const partial = planMeshV1Dispatch({ localParticipant: "alpha" }, { messageId: "ready-m2", text: "cc-mesh: alpha\ncc-mesh-from: beta\ncc-mesh-id: ready-3\ncc-mesh-turn: alpha\ncc-mesh-final: false\n\nfirst" }); const final = planMeshV1Dispatch({ localParticipant: "alpha" }, { messageId: "ready-m3", state: partial.stateTransition, text: "cc-mesh: alpha\ncc-mesh-from: beta\ncc-mesh-id: ready-3\ncc-mesh-turn: alpha\ncc-mesh-final: true\n\nsecond" }); assert(final.nextAction === "dispatch_once", `expected dispatch_once got ${final.nextAction}`); assert(final.dispatchText === "first\nsecond", "expected assembled context"); });
check("duplicate final suppressed", () => { const final = planMeshV1Dispatch({ localParticipant: "alpha" }, { messageId: "ready-m4", text: "cc-mesh: alpha\ncc-mesh-from: beta\ncc-mesh-id: ready-4\ncc-mesh-turn: alpha\ncc-mesh-final: true\n\nfinal" }); const duplicate = planMeshV1Dispatch({ localParticipant: "alpha" }, { messageId: "ready-m5", state: final.stateTransition, text: "cc-mesh: alpha\ncc-mesh-from: beta\ncc-mesh-id: ready-4\ncc-mesh-turn: alpha\ncc-mesh-final: true\n\nagain" }); assert(duplicate.nextAction === "none", `expected duplicate suppression got ${duplicate.nextAction}`); });
check("turn gate fails closed", () => { const plan = planMeshV1Dispatch({ localParticipant: "alpha" }, { text: "cc-mesh: alpha\ncc-mesh-from: beta\ncc-mesh-id: ready-5\ncc-mesh-turn: gamma\ncc-mesh-final: true\n\nhello" }); assert(plan.reason === "mesh_v1_not_local_turn", `expected turn gate got ${plan.reason}`); });
check("seen loop guard fails closed", () => { const plan = planMeshV1Dispatch({ localParticipant: "alpha" }, { text: "cc-mesh: alpha\ncc-mesh-from: beta\ncc-mesh-id: ready-6\ncc-mesh-turn: alpha\ncc-mesh-final: true\ncc-mesh-seen: beta,alpha\n\nhello" }); assert(plan.reason === "mesh_v1_loop_guard_seen", `expected loop guard got ${plan.reason}`); });
check("privacy snowflake rule ignores repeated placeholders", () => { assert(!snowflakeIdPattern.test("111111111111111111"), "repeated-digit placeholder must not be flagged"); assert(!snowflakeIdPattern.test("222222222222222222"), "repeated-digit placeholder must not be flagged"); assert(snowflakeIdPattern.test("123456789" + "012345678"), "mixed-digit snowflake-shaped ID must be flagged"); });
check("public-tree privacy sanity", () => { const deny = [snowflakeIdPattern, new RegExp("/home/operator/env/workspace/iter" + "modus/"), /(api[_-]?key|secret|password|token)\s*[:=]\s*["'][^"']{6,}["']/i]; const privateIdentifiers = ["ti" + "rrenia", "od" + "ino", "iter" + "modus"]; const skipDirs = new Set([".git", "node_modules", "dist"]); const skipPaths = new Set([".syncwheel/ledger"]); const hits = []; function walk(dir) { if (skipPaths.has(path.relative(root, dir))) return; for (const entry of readdirSync(dir)) { if (skipDirs.has(entry)) continue; const full = path.join(dir, entry); const stat = statSync(full); if (stat.isDirectory()) walk(full); else if (stat.isFile() && !isGeneratedPythonBytecode(path.relative(root, full), trackedFiles)) { const text = readFileSync(full, "utf8"); for (const pattern of deny) if (pattern.test(text)) hits.push(path.relative(root, full)); if (privateIdentifiers.some((identifier) => text.toLowerCase().includes(identifier))) hits.push(path.relative(root, full)); } } } walk(root); assert(hits.length === 0, `privacy scan hits: ${[...new Set(hits)].join(", ")}`); });
check("Plexus mechanism privacy", () => { const hits = []; const skip = new Set([".git", "node_modules", "dist", "var"]); function walk(dir) { for (const entry of readdirSync(dir)) { if (skip.has(entry)) continue; const full = path.join(dir, entry), stat = statSync(full); if (stat.isDirectory()) walk(full); else if (stat.isFile()) { const relative = path.relative(root, full); if (isPlexusMechanismFile(relative) && containsPrivatePlexusPolicy(readFileSync(full, "utf8"))) hits.push(relative); } } } walk(root); assert(hits.length === 0, `Plexus privacy scan hits: ${hits.join(", ")}`); });
check("agent-tmux skill bundle sync", () => { const drifted = agentTmuxBundleFiles.filter((relativePath) => { try { return !readFileSync(path.join(root, "packages/tmux-bridge", relativePath)).equals(readFileSync(path.join(root, "skills/agent-tmux", relativePath))); } catch { return true; } }); assert(drifted.length === 0, `agent-tmux skill bundle drift: ${drifted.join(", ")}`); });
for (const result of checks) console.log(`${result.ok ? "PASS" : "FAIL"} ${result.name}${result.ok ? "" : `: ${result.error}`}`);
if (checks.some((result) => !result.ok)) process.exit(1);
