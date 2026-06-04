#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const homeDir = process.env.HOME || ".";
const configCandidates = [
  process.env.MESH_PARTICIPANTS_JSON,
  resolve(repoRoot, "participants.local.json"),
  resolve(homeDir, ".config", "agent-mesh", "participants.json"),
  resolve(homeDir, ".config", "mesh-discord-routing", "participants.json"),
  "/etc/agent-mesh/participants.json",
  "/etc/mesh-discord-routing/participants.json",
].filter(Boolean);

const registryPath = configCandidates.find((candidate) => existsSync(candidate));
if (!registryPath) {
  console.error(
    "mesh-hydrate: missing participant config. Set MESH_PARTICIPANTS_JSON or create participants.local.json in the repo root.",
  );
  process.exit(4);
}

const registry = JSON.parse(readFileSync(registryPath, "utf8"));

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return "";
  return process.argv[index + 1] || "";
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function normalizeLabel(value) {
  return String(value || "").trim().toLowerCase();
}

const to = readArg("--to")
  .split(",")
  .map(normalizeLabel)
  .filter(Boolean);
const from = normalizeLabel(readArg("--from"));
const meshId = readArg("--id").trim();
const seen = readArg("--seen").trim();
const hop = readArg("--hop").trim();
const final = readArg("--final").trim() || "1";
const compact = hasFlag("--compact") || readArg("--format") === "ccm";
const body = readArg("--body").trim();

if (!body) {
  console.error("mesh-hydrate: missing --body");
  process.exit(2);
}

const participants = registry.participants || {};
const aliasToLabel = new Map();
for (const [label, entry] of Object.entries(participants)) {
  aliasToLabel.set(normalizeLabel(label), label);
  for (const alias of entry.aliases || []) aliasToLabel.set(normalizeLabel(alias), label);
}

const mentions = [];
const recipientLabels = [];
const unknown = [];
for (const rawLabel of to) {
  const label = aliasToLabel.get(rawLabel);
  const participant = label ? participants[label] : undefined;
  if (!participant?.discordUserId) {
    unknown.push(rawLabel);
    continue;
  }
  recipientLabels.push(label);
  mentions.push(`<@${participant.discordUserId}>`);
}

if (unknown.length > 0) {
  console.error(`mesh-hydrate: unknown recipient label(s): ${unknown.join(", ")}`);
  process.exit(3);
}

const prefix = [...new Set(mentions)].join(" ");
const trigger = [...new Set(recipientLabels)].join(",");

if (compact) {
  if (!meshId || !from || !trigger) {
    console.error("mesh-hydrate: --compact requires --id, --from, and at least one --to recipient");
    process.exit(2);
  }
  if (!["0", "1", "false", "true"].includes(final.toLowerCase())) {
    console.error("mesh-hydrate: --final must be one of 0, 1, false, or true");
    process.exit(2);
  }
  const headerParts = ["ccm:v1", `id=${meshId}`, `from=${from}`, `turn=${trigger}`, `final=${final}`];
  if (seen) headerParts.push(`seen=${seen}`);
  if (hop) headerParts.push(`hop=${hop}`);
  console.log(`${prefix}\n${headerParts.join(" ")}\n\n${body}`);
} else {
  console.log(prefix ? `cc-mesh: ${trigger}\n${prefix} ${body}` : body);
}
