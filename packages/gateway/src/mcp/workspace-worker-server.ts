import { createServer } from "node:http";
import { appendFile, readFile, chmod } from "node:fs/promises";
import { openSync, closeSync, constants, statSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ShellAgentSessionProvider, type AgentSessionProvider } from "../adapters/agent-session-provider.js";
import type { MeshTaskRecord } from "./mesh-task-store.js";
import { validateWorkerRoute, type WorkspaceWorkerRoute } from "./workspace-worker.js";
import { canonicalDirectory, sandboxArguments, assertSandboxMounts, contains, type WorkspaceSandboxConfig } from "./workspace-sandbox.js";

export interface IsolatedWorkerConfig extends WorkspaceWorkerRoute, WorkspaceSandboxConfig {
  provider: "claude" | "codex";
  /** Dedicated private control directory, outside repository, home and source tree. */
  control: string;
}
interface Receipt { taskId: string; workerId: string; accessMode: string; sessionId?: string; text?: string; error?: string }
interface Entry { taskId: string; input: string; sessionId: string; status: "started" | "finished"; receipt?: Receipt }

/** Kept alive inside one OS mount namespace; all bridge commands and tmux descendants inherit it. */
export async function startIsolatedWorker(config: IsolatedWorkerConfig, provider: AgentSessionProvider) {
  validateWorkerRoute(config);
  const journal = resolve(config.control, "worker-events.ndjson");
  const entries = new Map<string, Entry>();
  try {
    for (const line of (await readFile(journal, "utf8")).split("\n").filter(Boolean)) {
      const entry = JSON.parse(line) as Entry;
      entries.set(entry.taskId, entry);
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let tail = Promise.resolve();
  const save = async (entry: Entry) => {
    await appendFile(journal, `${JSON.stringify({ ...entry, principalId: config.principalId, workspaceId: config.workspaceId, accessMode: config.accessMode, at: new Date().toISOString() })}\n`, { mode: 0o600, flush: true });
    entries.set(entry.taskId, entry);
  };
  const execute = async (task: MeshTaskRecord): Promise<Receipt> => {
    const base = { taskId: task.task_id, workerId: config.id, accessMode: config.accessMode };
    if (task.schema !== "agent-mesh.mcp-task.v1" || task.principal_id !== config.principalId || task.target_agent_id !== config.agentId ||
        task.workspace_id !== config.workspaceId || task.access_mode !== config.accessMode || task.worker_id !== config.id ||
        typeof task.message !== "string" || task.message.length > 100_000 || typeof task.task_id !== "string" ||
        typeof task.session_id !== "string" || !/^[0-9a-f-]{36}$/.test(task.session_id)) return { ...base, error: "workspace_write_denied: worker policy mismatch." };
    const input = createHash("sha256").update(JSON.stringify([task.task_id, task.principal_id, task.target_agent_id, task.workspace_id, task.worker_id, task.access_mode, task.session_id, task.session_mode, task.message_id, task.context_id, task.message, task.idempotency_key])).digest("hex");
    const prior = entries.get(task.task_id);
    if (prior !== undefined) {
      if (prior.input !== input) return { ...base, error: "Worker task idempotency conflict." };
      return prior.receipt ?? { ...base, sessionId: prior.sessionId, error: "delivery_uncertain: interrupted task is not replayed." };
    }
    if (task.session_mode !== "fresh" && ![...entries.values()].some((e) => e.sessionId === task.session_id)) return { ...base, error: "Session is not owned by this isolated worker." };
    if (task.session_mode === "fresh" && [...entries.values()].some((e) => e.sessionId === task.session_id)) return { ...base, error: "Fresh session already exists." };
    await save({ taskId: task.task_id, input, sessionId: task.session_id, status: "started" });
    let receipt: Receipt;
    try {
      const result = await provider.send({ sessionId: task.session_id, workspaceId: task.workspace_id,
        message: task.message, messageId: task.message_id, contextId: task.context_id, taskId: task.task_id,
        correlationId: task.task_id, idempotencyKey: task.idempotency_key,
        ...(task.session_mode === "fresh" ? { sessionMode: "fresh" as const } : {}) });
      receipt = { ...base, sessionId: result.session_id ?? task.session_id,
        ...(!result.ok || result.result_error_code !== undefined
          ? { error: result.error_code ?? result.result_error_code ?? "transport_failure" }
          : result.reply === undefined ? { error: "result_no_output" } : { text: result.reply }) };
    } catch { receipt = { ...base, sessionId: task.session_id, error: "worker_execution_failed: see private worker diagnostics." }; }
    await save({ taskId: task.task_id, input, sessionId: receipt.sessionId!, status: "finished", receipt });
    return receipt;
  };
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/execute") { res.writeHead(404).end(); return; }
    try {
      let size = 0; const chunks: Buffer[] = [];
      for await (const chunk of req) { size += chunk.length; if (size > 1_048_576) throw new Error("Request too large."); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { task: MeshTaskRecord };
      const run = tail.then(() => execute(body.task));
      tail = run.then(() => undefined, () => undefined);
      const receipt = await run;
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(receipt));
    } catch { res.writeHead(400).end(JSON.stringify({ error: "Invalid worker request." })); }
  });
  // Never unlink a pre-existing socket: it might belong to a live worker.
  await new Promise<void>((ok, fail) => { server.once("error", fail); server.listen(config.socketPath, ok); });
  await chmod(config.socketPath, 0o600);
  return server;
}

async function main() {
  if (process.argv[2] === "--inside") {
    const config = JSON.parse(Buffer.from(process.argv[3]!, "base64url").toString()) as IsolatedWorkerConfig;
    const mounts = await readFile("/proc/self/mountinfo", "utf8");
    assertSandboxMounts(config, mounts);
    const bin = resolve(config.codeRoot, "packages/tmux-bridge/bin");
    const provider = new ShellAgentSessionProvider({ agentId: config.agentId, agentType: config.provider,
      agentSessionPath: resolve(bin, "agent-session.sh"), agentSendPath: resolve(bin, "agent-send.sh"),
      agentNativeCallPath: resolve(bin, "agent-native-call.mjs"),
      workspaceRoots: { [config.workspaceId]: [config.repository] }, freshSessionCwds: { [config.workspaceId]: config.repository },
      ...(config.provider === "codex" ? { freshTaskSessions: true } : {}),
      isolatedAccessMode: config.accessMode, meshSocket: "mesh-isolated", timeoutSeconds: 240 });
    await startIsolatedWorker(config, provider);
    return;
  }
  const config = JSON.parse(await readFile(process.argv[2]!, "utf8")) as IsolatedWorkerConfig;
  validateWorkerRoute(config);
  if (!["claude", "codex"].includes(config.provider)) throw new Error("Unknown worker provider.");
  canonicalDirectory(config.control);
  canonicalDirectory(resolve(config.repository, ".git"));
  if (dirname(config.socketPath) !== config.control) throw new Error("Worker socket must be in the private control directory.");
  for (const path of [config.repository, config.codeRoot, config.home, config.temporary, config.control]) {
    if (contains("/usr", path) || contains(path, "/usr")) throw new Error("Worker data must be separate from runtime mounts.");
  }
  for (const path of [config.home, config.temporary, config.control]) {
    const info = statSync(path);
    if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error("Worker private directories require owner-only permissions.");
  }
  // No shell and no inherited host environment, credentials, app-server or tmux sockets.
  const args = sandboxArguments(config, process.execPath, [fileURLToPath(import.meta.url), "--inside", Buffer.from(JSON.stringify(config)).toString("base64url")]);
  // Pin every approved source directory before namespace creation (avoid symlink/rename races).
  const sources = [config.repository, config.codeRoot, config.home, config.temporary, config.control];
  const descriptors = sources.map((path) => openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
  for (let i = 0; i < sources.length; i++) {
    if (realpathSync(`/proc/self/fd/${descriptors[i]}`) !== sources[i]) throw new Error("Worker mount changed while pinning its directory.");
  }
  for (let i = 0; i < args.length - 2; i++) {
    if (args[i] === "--bind" || args[i] === "--ro-bind") {
      const index = sources.indexOf(args[i + 1]!);
      if (index >= 0) { args[i] = args[i] === "--bind" ? "--bind-fd" : "--ro-bind-fd"; args[i + 1] = String(index + 3); }
    }
  }
  const child = spawn("/usr/bin/bwrap", args, { stdio: ["inherit", "inherit", "inherit", ...descriptors], env: {} });
  for (const fd of descriptors) closeSync(fd);
  child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
  child.on("exit", (code) => { process.exitCode = code ?? 1; });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
}
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
