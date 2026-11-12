#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { commit, init, reincarnate, verify } from "./grant-authority.js";

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    dir: { type: "string" }, config: { type: "string" }, reason: { type: "string" }, actor: { type: "string" }
  } });
  const command = positionals[0];
  if (positionals.length !== 1 || !["init", "commit", "status", "reincarnate"].includes(command ?? "")) throw new Error("invalid_arguments");
  let config: unknown;
  if (values.config) config = JSON.parse(await readFile(values.config, "utf8"));
  const stateDir = (config as { stateDir?: unknown } | undefined)?.stateDir;
  const dir = values.dir ?? (typeof stateDir === "string" && stateDir.length ? join(stateDir, "authority") : undefined);
  if (!dir) throw new Error("directory_required");
  if ((command === "commit" || command === "status") && !values.config) throw new Error("config_required");
  if ((command === "commit" || command === "reincarnate") && !values.reason?.trim()) throw new Error("reason_required");
  const result = command === "init" ? await init(dir)
    : command === "reincarnate" ? await reincarnate(dir, { reason: values.reason! })
    : command === "commit" ? await commit(dir, values.config!, { actor: values.actor ?? "operator", reason: values.reason! })
    : await verify(dir, config);
  console.log(JSON.stringify(result));
  if ("ok" in result && !result.ok) process.exitCode = 1;
} catch {
  console.log(JSON.stringify({ ok: false, reason: "authority_command_failed" }));
  process.exitCode = 1;
}
