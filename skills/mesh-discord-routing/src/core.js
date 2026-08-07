import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultSkillDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function normalizeLabel(value) {
  return String(value || "").trim().toLowerCase();
}

export function parseCcMeshRecipients(text = "") {
  const match = String(text || "").match(/(?:^|\n)\s*cc-mesh:\s*([^\n]+)/i);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function hasDiscordMention(text = "") {
  return /<@!?\d{15,25}>/.test(String(text || ""));
}

export function participantConfigCandidates(options = {}) {
  return [
    options.configPath,
    process.env.MESH_PARTICIPANTS_JSON,
    resolve(options.skillDir || defaultSkillDir, "participants.local.json"),
    resolve(process.env.HOME || ".", ".config", "mesh-discord-routing", "participants.json"),
    "/etc/mesh-discord-routing/participants.json"
  ].filter(Boolean);
}

export function loadParticipantRegistry(options = {}) {
  const path = participantConfigCandidates(options).find((candidate) => existsSync(candidate));
  if (!path) return { path: "", participants: {} };
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  return { path, participants: parsed.participants || {} };
}

export function buildAliasMap(participants = {}) {
  const map = new Map();
  for (const [label, entry] of Object.entries(participants)) {
    map.set(normalizeLabel(label), label);
    for (const alias of entry?.aliases || []) map.set(normalizeLabel(alias), label);
  }
  return map;
}

export function resolveRecipients(labels = [], participants = {}) {
  const aliasMap = buildAliasMap(participants);
  const resolved = [];
  const unknown = [];
  for (const raw of labels) {
    const label = aliasMap.get(normalizeLabel(raw));
    const participant = label ? participants[label] : null;
    if (!participant?.discordUserId) {
      unknown.push(raw);
      continue;
    }
    resolved.push({ label, discordUserId: String(participant.discordUserId) });
  }
  return { resolved, unknown };
}

export function hydrateBody(labels = [], body = "", participants = {}) {
  const { resolved, unknown } = resolveRecipients(labels, participants);
  if (unknown.length > 0) {
    const err = new Error(`unknown recipient label(s): ${unknown.join(", ")}`);
    err.code = "UNKNOWN_RECIPIENTS";
    err.unknown = unknown;
    throw err;
  }
  const uniqueLabels = [...new Set(resolved.map((entry) => entry.label))];
  const mentions = [...new Set(resolved.map((entry) => `<@${entry.discordUserId}>`))];
  return mentions.length > 0
    ? `cc-mesh: ${uniqueLabels.join(",")}\n${mentions.join(" ")} ${String(body || "").trim()}`
    : String(body || "").trim();
}

export function hydrateCcMeshMessage(text = "", participants = {}) {
  const labels = parseCcMeshRecipients(text);
  if (labels.length === 0) return String(text || "");
  const body = String(text || "").replace(/(?:^|\n)\s*cc-mesh:\s*[^\n]+\n?/i, "").trim();
  return hydrateBody(labels, body, participants);
}

export function matchesLocalParticipant(text = "", localLabels = [], participants = {}) {
  const aliasMap = buildAliasMap(participants);
  const recipients = new Set(parseCcMeshRecipients(text).map((recipient) => {
    const normalized = normalizeLabel(recipient);
    return normalizeLabel(aliasMap.get(normalized) || normalized);
  }));
  if (recipients.size === 0) return false;
  for (const local of localLabels) {
    const normalized = normalizeLabel(local);
    const canonical = aliasMap.get(normalized) || normalized;
    if (recipients.has(normalized) || recipients.has(normalizeLabel(canonical))) return true;
  }
  return false;
}
