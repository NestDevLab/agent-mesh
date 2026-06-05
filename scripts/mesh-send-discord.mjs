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

function die(message, code = 1, extra = {}) {
  console.error(JSON.stringify({ ok: false, error: message, ...extra }));
  process.exit(code);
}

function loadRegistry(explicitPath) {
  const candidates = explicitPath ? [explicitPath, ...configCandidates] : configCandidates;
  const registryPath = candidates.find((candidate) => existsSync(candidate));
  if (!registryPath) {
    die("missing participant config", 4, {
      checked: candidates.map(String),
      hint: "Set MESH_PARTICIPANTS_JSON or create participants.local.json in the repo root.",
    });
  }
  return { registryPath, registry: JSON.parse(readFileSync(registryPath, "utf8")) };
}

function resolveRecipients(registry, to) {
  const participants = registry.participants || {};
  const aliasToLabel = new Map();
  for (const [label, entry] of Object.entries(participants)) {
    aliasToLabel.set(normalizeLabel(label), label);
    for (const alias of entry.aliases || []) aliasToLabel.set(normalizeLabel(alias), label);
  }

  const recipients = [];
  const unknown = [];
  const seenLabels = new Set();
  for (const rawLabel of to) {
    const label = aliasToLabel.get(normalizeLabel(rawLabel));
    const participant = label ? participants[label] : undefined;
    if (!participant?.discordUserId) {
      unknown.push(rawLabel);
      continue;
    }
    if (seenLabels.has(label)) continue;
    seenLabels.add(label);
    recipients.push({ label, discordUserId: String(participant.discordUserId) });
  }
  return { recipients, unknown };
}

function composeMessage({ recipients, from, meshId, body, format, final, seen, hop }) {
  const mentions = recipients.map((recipient) => `<@${recipient.discordUserId}>`).join(" ");
  const turn = recipients.map((recipient) => recipient.label).join(",");
  if (format === "ccm") {
    const parts = ["ccm:v1", `id=${meshId}`, `from=${from}`, `turn=${turn}`, `final=${final ? "1" : "0"}`];
    if (seen) parts.push(`seen=${seen}`);
    if (hop) parts.push(`hop=${hop}`);
    return `${mentions}\n${parts.join(" ")}\n\n${body}`;
  }

  const lines = [
    `cc-mesh: ${turn}`,
    `cc-mesh-from: ${from}`,
    `cc-mesh-id: ${meshId}`,
    `cc-mesh-final: ${final ? "true" : "false"}`,
  ];
  if (seen) lines.push(`cc-mesh-seen: ${seen}`);
  if (hop) lines.push(`hop-limit: ${hop}`);
  return `${lines.join("\n")}\n\n${mentions} ${body}`;
}

function redactedPreview(message, recipients) {
  let redacted = message;
  for (const recipient of recipients) {
    redacted = redacted.replaceAll(`<@${recipient.discordUserId}>`, `<@REDACTED:${recipient.label}>`);
  }
  return redacted;
}

function parseTarget(target) {
  const raw = String(target || "").trim();
  const match = raw.match(/^discord:(\d+)(?::(\d+))?$/);
  if (!match) return null;
  return { channelId: match[1], threadId: match[2] || "" };
}

async function sendDiscord({ token, channelId, threadId, message }) {
  // Discord threads are channels. The repo-level target keeps the common
  // discord:<parent-channel>[:thread] shape for consistency, but the REST send
  // must post to the thread channel itself when a thread id is present.
  const deliveryChannelId = threadId || channelId;
  const url = new URL(`https://discord.com/api/v10/channels/${deliveryChannelId}/messages`);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content: message, allowed_mentions: { parse: ["users"] } }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    die("discord send failed", 5, { status: response.status, discord_error: data });
  }
  return data;
}

const to = readArg("--to")
  .split(",")
  .map((part) => part.trim())
  .filter(Boolean);
const from = normalizeLabel(readArg("--from"));
const meshId = readArg("--id").trim();
const body = readArg("--body").trim();
const target = readArg("--target").trim();
const format = readArg("--format").trim() || (hasFlag("--compact") ? "ccm" : "ccm");
const finalRaw = readArg("--final").trim().toLowerCase();
const final = finalRaw ? ["1", "true", "yes"].includes(finalRaw) : true;
const seen = readArg("--seen").trim();
const hop = readArg("--hop").trim();
const dryRun = hasFlag("--dry-run") || !hasFlag("--send");
const participantsPath = readArg("--participants").trim();

if (hasFlag("-h") || hasFlag("--help")) {
  console.log(`Usage: mesh-send-discord.mjs --to <labels> --from <label> --id <mesh-id> --body <text> --target discord:<channel>[:thread] [--format ccm|cc-mesh] [--send|--dry-run]\n\nReal sends require DISCORD_BOT_TOKEN. Default is --dry-run.`);
  process.exit(0);
}
if (!to.length) die("missing --to", 2);
if (!from) die("missing --from", 2);
if (!meshId) die("missing --id", 2);
if (!body) die("missing --body", 2);
if (!target) die("missing --target", 2);
if (!["ccm", "cc-mesh"].includes(format)) die("--format must be ccm or cc-mesh", 2);

const parsedTarget = parseTarget(target);
if (!parsedTarget) die("--target must be discord:<channel-id>[:thread-id]", 2);

const { registryPath, registry } = loadRegistry(participantsPath);
const { recipients, unknown } = resolveRecipients(registry, to);
if (unknown.length) die("unknown recipient label(s) or missing discordUserId", 3, { unknown });

const message = composeMessage({ recipients, from, meshId, body, format, final, seen, hop });
const audit = {
  ok: true,
  dry_run: dryRun,
  target,
  format,
  mesh_id: meshId,
  from,
  recipients: recipients.map((recipient) => recipient.label),
  registry_path: registryPath,
};

if (dryRun) {
  console.log(JSON.stringify({ ...audit, preview: redactedPreview(message, recipients) }, null, 2));
  process.exit(0);
}

const token = process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN || "";
if (!token) die("real send requires DISCORD_BOT_TOKEN", 4);
const sent = await sendDiscord({ token, channelId: parsedTarget.channelId, threadId: parsedTarget.threadId, message });
console.log(JSON.stringify({ ...audit, message_id: sent.id }, null, 2));
