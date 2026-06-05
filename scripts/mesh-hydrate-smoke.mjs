#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const script = resolve(scriptDir, "mesh-hydrate.mjs");

function run(args, registry) {
  const dir = mkdtempSync(resolve(tmpdir(), "agent-mesh-hydrate-"));
  const registryPath = resolve(dir, "participants.json");
  writeFileSync(registryPath, JSON.stringify(registry), "utf8");
  return execFileSync("node", [script, ...args], {
    env: { ...process.env, MESH_PARTICIPANTS_JSON: registryPath },
    encoding: "utf8",
  });
}

const registry = {
  participants: {
    "agent-beta": { discordUserId: "12345", aliases: ["runtime", "agent-beta-runtime"] },
    nestdev: { discordUserId: "67890", aliases: ["domain-alpha"] },
    "agent-gamma": { discordUserId: "99999", aliases: [] },
  },
};

assert.equal(
  run(["--to", "runtime,domain-alpha", "--body", "Diagnosi pronta."], registry),
  "cc-mesh: agent-beta,nestdev\n<@12345> <@67890> Diagnosi pronta.\n",
);

assert.equal(
  run(["--to", "", "--body", "Solo nota interna."], { participants: {} }),
  "Solo nota interna.\n",
);

assert.equal(
  run(
    [
      "--compact",
      "--to",
      "agent-gamma",
      "--from",
      "nestdev",
      "--id",
      "live-peer-test",
      "--seen",
      "runtime,agent-beta-openclaw,nestdev",
      "--hop",
      "2",
      "--body",
      "Forward one micro-turn.",
    ],
    registry,
  ),
  "<@99999>\nccm:v1 id=live-peer-test from=nestdev turn=agent-gamma final=1 seen=runtime,agent-beta-openclaw,nestdev hop=2\n\nForward one micro-turn.\n",
);

assert.equal(
  run(
    [
      "--compact",
      "--to",
      "agent-gamma",
      "--from",
      "nestdev",
      "--id",
      "partial-peer-test",
      "--final",
      "0",
      "--body",
      "Partial context only; do not dispatch yet.",
    ],
    registry,
  ),
  "<@99999>\nccm:v1 id=partial-peer-test from=nestdev turn=agent-gamma final=0\n\nPartial context only; do not dispatch yet.\n",
);

console.log("PASS mesh-hydrate smoke");
