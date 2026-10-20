import { createServer, request } from "node:http";
import { mkdir, readFile, readdir, lstat, cp, chmod, unlink } from "node:fs/promises";
import { statSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { MeshTaskRecord } from "./mesh-task-store.js";
import { validateWorkerRoute, type WorkspaceWorkerRoute } from "./workspace-worker.js";
import { canonicalDirectory, contains, type WorkspaceSandboxConfig } from "./workspace-sandbox.js";
import { selectWorkspacePath, type ClientPathPolicy } from "./workspace-path-policy.js";

export interface WorkspaceBrokerConfig extends WorkspaceWorkerRoute, ClientPathPolicy {
  providerBinary?: WorkspaceSandboxConfig["providerBinary"];
  readOnlyFiles?: WorkspaceSandboxConfig["readOnlyFiles"];
  pathSelection: "client";
  provider: "claude" | "codex";
  codeRoot: string;
  stateRoot: string;
  /** Owner-curated, private non-secret onboarding/preferences. Never use a personal harness home. */
  homeTemplate: string;
}

async function assertTemplate(path: string): Promise<void> {
  for (const name of await readdir(path)) {
    const file = resolve(path, name); const info = await lstat(file);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new Error("Provider home template must contain only regular files and directories.");
    if (info.isDirectory()) await assertTemplate(file);
  }
}
function privateDirectory(path: string) {
  canonicalDirectory(path);
  const info = statSync(path);
  if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error("Broker private directories require owner-only permissions.");
}

export async function startWorkspaceBroker(config: WorkspaceBrokerConfig) {
  validateWorkerRoute(config);
  if (config.pathSelection !== "client" || !["claude", "codex"].includes(config.provider)) throw new Error("Invalid workspace broker configuration.");
  for (const path of [config.stateRoot, config.homeTemplate, dirname(config.socketPath)]) privateDirectory(path);
  canonicalDirectory(config.codeRoot);
  for (const root of config.allowedRoots) canonicalDirectory(root);
  if (contains(config.stateRoot, config.homeTemplate) || contains(config.homeTemplate, config.stateRoot)) throw new Error("Broker state and provider template must be disjoint.");
  await assertTemplate(config.homeTemplate);
  let stopping = false;
  const children = new Map<string, { child: ChildProcess; socket: string; ready: Promise<void> }>();
  const childFor = async (destination: string) => {
    const digest = createHash("sha256").update(JSON.stringify([config.id, config.principalId, config.agentId, config.workspaceId, config.accessMode, destination])).digest("hex").slice(0, 32);
    const cached = children.get(digest);
    if (cached !== undefined) { await cached.ready; return cached.socket; }
    const root = resolve(config.stateRoot, digest);
    await mkdir(root, { recursive: true, mode: 0o700 }); privateDirectory(root);
    for (const name of ["home", "tmp", "control"]) { await mkdir(resolve(root, name), { mode: 0o700 }).catch((error) => { if (error.code !== "EEXIST") throw error; }); privateDirectory(resolve(root, name)); }
    const marker = resolve(root, "home-ready");
    try { await readFile(marker); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // Only the explicit owner-curated provider template is copied; never the caller's home.
      for (const name of await readdir(config.homeTemplate)) await cp(resolve(config.homeTemplate, name), resolve(root, "home", name), { recursive: true, force: false, errorOnExist: true });
      const { writeFile } = await import("node:fs/promises"); await writeFile(marker, "ready\n", { mode: 0o600, flag: "wx" });
    }
    const socket = resolve(root, "control/worker.sock");
    try { await lstat(socket); throw new Error("Existing worker socket requires owner inspection; it is not reused."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    // A persisted socket is never removed merely because a connection failed.
    // A clean broker shutdown removes it only after its own child has exited.
    const childConfig = { ...config, socketPath: socket, repository: destination, mountPath: "/workspace", home: resolve(root, "home"), temporary: resolve(root, "tmp"), control: resolve(root, "control") };
    const configPath = resolve(root, "worker.json");
    const { writeFile } = await import("node:fs/promises"); await writeFile(configPath, JSON.stringify(childConfig), { mode: 0o600 });
    if (stopping) throw new Error("Workspace broker is stopping.");
    const child = spawn(process.execPath, [resolve(config.codeRoot, "packages/gateway/dist/mcp/workspace-worker-server.js"), configPath], { stdio: ["ignore", "ignore", "ignore", "ipc"], env: {} });
    const ready = new Promise<void>((ok, fail) => {
      const deadline = Date.now() + 5000;
      const probe = () => {
        if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) { fail(new Error("workspace_worker_unavailable: isolated child did not start.")); return; }
        const req = request({ socketPath: socket, path: "/ready", method: "GET" }, (res) => { res.resume(); ok(); });
        req.once("error", () => setTimeout(probe, 50)); req.end();
      };
      child.once("error", fail); probe();
    });
    children.set(digest, { child, socket, ready });
    child.once("exit", () => { children.delete(digest); });
    try { await ready; } catch (error) { child.kill("SIGTERM"); throw error; }
    return socket;
  };
  let tail = Promise.resolve();
  const execute = async (task: MeshTaskRecord) => {
    const base = { taskId: task?.task_id, workerId: config.id, accessMode: config.accessMode };
    if (task?.principal_id !== config.principalId || task.target_agent_id !== config.agentId || task.workspace_id !== config.workspaceId || task.access_mode !== config.accessMode || task.worker_id !== config.id || typeof task.workspace_path !== "string") return { ...base, error: "workspace_write_denied: broker policy mismatch." };
    let dispatched = false;
    try {
      if (stopping) throw new Error("Workspace broker is stopping.");
      const destination = selectWorkspacePath(task.workspace_path, config, [config.codeRoot, config.stateRoot, config.homeTemplate, dirname(config.socketPath), ...(config.providerBinary === undefined ? [] : [config.providerBinary.source]), ...(config.readOnlyFiles ?? []).map((file) => file.source)]);
      const socket = await childFor(destination);
      dispatched = true;
      return await new Promise<unknown>((ok, fail) => {
        const req = request({ socketPath: socket, path: "/execute", method: "POST" }, (res) => {
          const chunks: Buffer[] = []; let size = 0;
          res.on("data", (data: Buffer) => { size += data.length; if (size > 1_048_576) req.destroy(new Error("Worker response too large.")); else chunks.push(data); });
          res.on("end", () => { try { if (res.statusCode !== 200) throw new Error("Worker rejected task."); ok(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (error) { fail(error); } });
          res.on("error", fail);
        });
        req.on("error", fail); req.setTimeout(290_000, () => req.destroy(new Error("Worker timeout."))); req.end(JSON.stringify({ task }));
      });
    } catch (error) { return { ...base, error: error instanceof Error && error.message.startsWith("workspace_path_denied:") ? error.message : dispatched ? "delivery_uncertain: destination worker connection interrupted; retain the task key." : "workspace_worker_unavailable: isolated destination worker unavailable; no fallback." }; }
  };
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/execute") { res.writeHead(404).end(); return; }
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 1_048_576) throw new Error("Oversized broker request."); chunks.push(chunk); }
      const { task } = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { task: MeshTaskRecord };
      const result = tail.then(() => execute(task)); tail = result.then(() => undefined, () => undefined);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(await result));
    } catch { res.writeHead(400).end(); }
  });
  await new Promise<void>((ok, fail) => { server.once("error", fail); server.listen(config.socketPath, ok); });
  await chmod(config.socketPath, 0o600);
  const close = async () => {
    stopping = true;
    const closed = new Promise<void>((ok) => server.close(() => ok()));
    await Promise.all([...children.values()].map(({ child, socket }) => new Promise<void>((ok) => {
      const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
      child.once("exit", () => { clearTimeout(timeout); void unlink(socket).catch(() => undefined).finally(ok); }); child.kill("SIGTERM");
    })));
    await closed;
  };
  return { close };
}
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  readFile(process.argv[2]!, "utf8").then((raw) => startWorkspaceBroker(JSON.parse(raw) as WorkspaceBrokerConfig)).then((broker) => {
    for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { void broker.close(); });
  }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
