#!/usr/bin/env node
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const dir = mkdtempSync(join(tmpdir(), "mesh-send-discord-"));
try {
  const participants = join(dir, "participants.json");
  writeFileSync(
    participants,
    JSON.stringify({
      participants: {
        alpha: { discordUserId: "1111", aliases: ["a"] },
        beta: { discordUserId: "2222" },
      },
    }),
  );
  const output = execFileSync(
    process.execPath,
    [
      "scripts/mesh-send-discord.mjs",
      "--participants",
      participants,
      "--to",
      "a,beta",
      "--from",
      "agent-beta-runtime",
      "--id",
      "smoke-run",
      "--target",
      "discord:1234:2345",
      "--body",
      "smoke body",
      "--dry-run",
    ],
    { encoding: "utf8" },
  );
  const result = JSON.parse(output);
  if (!result.ok) throw new Error(`expected ok result: ${output}`);
  if (result.recipients.join(",") !== "alpha,beta") throw new Error(`wrong recipients: ${output}`);
  if (!result.preview.includes("<@REDACTED:alpha>") || !result.preview.includes("<@REDACTED:beta>")) {
    throw new Error(`preview did not redact mentions: ${output}`);
  }
  if (result.preview.includes("1111") || result.preview.includes("2222")) {
    throw new Error(`preview leaked raw discord ids: ${output}`);
  }
  if (!result.preview.includes("ccm:v1 id=smoke-run from=agent-beta-runtime turn=alpha,beta final=1")) {
    throw new Error(`compact header missing: ${output}`);
  }
  console.log("mesh-send-discord smoke ok");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
