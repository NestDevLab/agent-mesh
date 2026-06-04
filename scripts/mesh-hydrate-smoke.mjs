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
    karan: { discordUserId: "12345", aliases: ["hermes", "karan-hermes"] },
    nestdev: { discordUserId: "67890", aliases: ["tirrenia"] },
    odino: { discordUserId: "99999", aliases: [] },
  },
};

assert.equal(
  run(["--to", "hermes,tirrenia", "--body", "Diagnosi pronta."], registry),
  "cc-mesh: karan,nestdev\n<@12345> <@67890> Diagnosi pronta.\n",
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
      "odino",
      "--from",
      "nestdev",
      "--id",
      "live-peer-test",
      "--seen",
      "hermes,karan-openclaw,nestdev",
      "--hop",
      "2",
      "--body",
      "Forward one micro-turn.",
    ],
    registry,
  ),
  "<@99999>\nccm:v1 id=live-peer-test from=nestdev turn=odino final=1 seen=hermes,karan-openclaw,nestdev hop=2\n\nForward one micro-turn.\n",
);

console.log("PASS mesh-hydrate smoke");
