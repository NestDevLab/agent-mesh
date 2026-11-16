import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";

export const MODULE_PROTOCOL = "agent-mesh.plexus-module.v1";
const NAME = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_BYTES = 1024 * 1024;

// This is an operator allowlist, not a sandbox for untrusted programs.
export async function readModuleRegistry(path) {
  let text;
  try { text = await readFile(path, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("module registry is too large");
  const config = JSON.parse(text);
  if (!config || config.schemaVersion !== 1 || !Array.isArray(config.modules)) throw new Error("invalid module registry");
  const names = new Set();
  return config.modules.map((entry) => {
    if (!entry || typeof entry.name !== "string" || !NAME.test(entry.name) || names.has(entry.name)) throw new Error("invalid or duplicate module name");
    if (!Array.isArray(entry.command) || !entry.command.length || entry.command.some(v => typeof v !== "string" || !v || v.includes("\0"))) throw new Error("invalid module command");
    const timeoutMs = entry.timeoutMs ?? 10000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error("invalid module timeout");
    names.add(entry.name);
    return { name: entry.name, command: [...entry.command], timeoutMs };
  });
}

export async function describeModule(entry) {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(entry.command[0], [...entry.command.slice(1), "describe"], { stdio: ["pipe", "pipe", "ignore"], shell: false });
    let output = [], bytes = 0, finished = false;
    const finish = (error, value) => { if (finished) return; finished = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(new Error("module timed out")); }, entry.timeoutMs);
    child.on("error", () => finish(new Error("module failed")));
    child.stdout.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) { child.kill("SIGKILL"); finish(new Error("module response too large")); }
      else output.push(chunk);
    });
    child.stdin.on("error", () => {});
    child.on("close", code => {
      if (code !== 0) return finish(new Error("module failed"));
      try { finish(null, JSON.parse(Buffer.concat(output).toString("utf8"))); }
      catch { finish(new Error("invalid module response")); }
    });
    child.stdin.end("{}\n");
  });
  if (!result || result.schema !== MODULE_PROTOCOL || result.name !== entry.name || result.namespace !== entry.name || !Array.isArray(result.operations) || !result.operations.includes("describe") || result.operations.some(op => typeof op !== "string")) throw new Error("invalid module description");
  return result;
}
