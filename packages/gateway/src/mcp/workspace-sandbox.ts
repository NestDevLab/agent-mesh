import { createHash } from "node:crypto";
import { realpathSync, statSync, readFileSync } from "node:fs";
import { isAbsolute, resolve, relative, dirname, basename } from "node:path";
import type { AccessMode } from "./workspace-worker.js";

export function canonicalDirectory(path: string): string {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path || !statSync(path).isDirectory()) {
    throw new Error("Worker directories must be existing canonical absolute directories without symlinks or traversal.");
  }
  return path;
}
export function contains(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
export interface WorkspaceSandboxConfig {
  repository: string;
  codeRoot: string;
  home: string;
  temporary: string;
  accessMode: AccessMode;
  mountPath?: "/workspace";
  providerBinary?: { source: string; name: "claude" | "codex" };
  providerCompanion?: { source: string; name: "codex-code-mode-host"; sha256: string };
  readOnlyFiles?: Array<{ source: string; target: ".codex/auth.json" | ".claude/.credentials.json"; jsonKeys?: ["claudeAiOauth"] }>;

  control?: string;
}
/** One explicitly approved executable companion; never discover host siblings. */
export function providerCompanionFile(config: WorkspaceSandboxConfig): { source: string; target: string } | undefined {
  const file = config.providerCompanion;
  if (file === undefined) return undefined;
  if (config.providerBinary?.name !== "codex" || file.name !== "codex-code-mode-host" ||
      typeof file.source !== "string" || !isAbsolute(file.source) || resolve(file.source) !== file.source ||
      realpathSync(file.source) !== file.source || dirname(file.source) !== dirname(config.providerBinary.source) || basename(file.source) !== file.name || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error("Invalid explicit provider companion.");
  const info = statSync(file.source);
  if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0 || (info.mode & 0o111) === 0 ||
      createHash("sha256").update(readFileSync(file.source)).digest("hex") !== file.sha256) throw new Error("Provider companion executable identity mismatch.");
  return { source: file.source, target: "/opt/mesh-bin/codex-code-mode-host" };
}

/** Empty mount namespace: never bind /, /home, /run, host /tmp or a host tmux socket. */
export function sandboxArguments(config: WorkspaceSandboxConfig, command: string, args: readonly string[]): string[] {
  for (const value of [config.repository, config.codeRoot, config.home, config.temporary]) canonicalDirectory(value);
  if (config.control !== undefined) canonicalDirectory(config.control);
  const paths = [config.repository, config.codeRoot, config.home, config.temporary, ...(config.control === undefined ? [] : [config.control])];
  for (let i = 0; i < paths.length; i++) for (let j = i + 1; j < paths.length; j++) {
    if (contains(paths[i]!, paths[j]!) || contains(paths[j]!, paths[i]!)) throw new Error("Worker mounts must not overlap.");
  }
  if (config.mountPath !== undefined && config.mountPath !== "/workspace") throw new Error("Invalid internal workspace mount.");
  if (!["read-only", "workspace-write"].includes(config.accessMode)) throw new Error("Invalid sandbox mode.");
  const companion = providerCompanionFile(config);
  const files = [...(companion === undefined ? [] : [companion]), { source: realpathSync(process.execPath), target: "/opt/mesh-bin/node" }, ...(config.providerBinary === undefined ? [] : [{ source: config.providerBinary.source, target: `/opt/mesh-bin/${config.providerBinary.name}` }]), ...(config.readOnlyFiles ?? []).map((file) => ({ source: file.source, target: `/home/worker/${file.target}` }))];
  if (config.providerBinary !== undefined && !["claude", "codex"].includes(config.providerBinary.name)) throw new Error("Invalid isolated provider binary.");
  if ((config.readOnlyFiles ?? []).some((file) => ![".codex/auth.json", ".claude/.credentials.json"].includes(file.target))) throw new Error("Invalid isolated provider auth target.");
  if ((config.readOnlyFiles ?? []).some((file) => file.jsonKeys !== undefined && (file.target !== ".claude/.credentials.json" || JSON.stringify(file.jsonKeys) !== '["claudeAiOauth"]'))) throw new Error("Invalid provider authentication projection.");
  for (const file of files) if (!isAbsolute(file.source) || resolve(file.source) !== file.source || realpathSync(file.source) !== file.source || !statSync(file.source).isFile()) throw new Error("Isolated runtime files must be canonical regular files.");
  const result = ["--unshare-all", "--die-with-parent", "--share-net", "--new-session", "--cap-drop", "ALL", "--clearenv",
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/run", "--tmpfs", "/var", "--dir", "/etc"];
  // Read-only runtime dependencies, deliberately excluding the host's home and socket trees.
  for (const path of ["/usr", "/bin", "/lib", "/lib64", "/etc/ssl", "/etc/hosts", "/etc/resolv.conf", "/etc/nsswitch.conf", "/etc/passwd", "/etc/group", "/etc/ld.so.cache"]) {
    try { statSync(path); result.push("--ro-bind", path, path); } catch { /* optional platform runtime */ }
  }
  result.push("--bind", config.temporary, "/tmp", "--bind", config.home, "/home/worker");
  if (config.control !== undefined) result.push("--bind", config.control, config.control);
  for (const file of files) result.push("--ro-bind", file.source, file.target);
  result.push("--ro-bind", config.codeRoot, config.codeRoot,
    config.accessMode === "workspace-write" ? "--bind" : "--ro-bind", config.repository, config.mountPath ?? config.repository,
    "--setenv", "HOME", "/home/worker", "--setenv", "PATH", "/opt/mesh-bin:/usr/local/bin:/usr/bin:/bin",
    "--setenv", "TMPDIR", "/tmp", "--setenv", "MESH_TMUX_SOCKET", "mesh-isolated",
    "--setenv", "MESH_STRICT_READY", "1", "--setenv", "MESH_PRESERVE_SESSION_POLICY", "1",
    "--setenv", "MESH_REPLACE_UNREADY_SESSION", "1", "--setenv", "AGENT_MESH_ROOT", config.codeRoot,
    "--chdir", config.mountPath ?? config.repository, "--", command === process.execPath ? "/opt/mesh-bin/node" : command, ...args);
  return result;
}

/** Validate the effective namespace, including every host-backed writable mount. */
export function assertSandboxMounts(config: WorkspaceSandboxConfig, mountinfo: string): void {
  const decode = (path: string) => path.replace(/\\([0-7]{3})/g, (_, code: string) => String.fromCharCode(parseInt(code, 8)));
  const mounts = mountinfo.split("\n").filter(Boolean).map((line) => {
    const [left, right] = line.split(" - "); const fields = left!.split(" ");
    return { path: decode(fields[4]!), options: fields[5]!.split(","), fs: right?.split(" ")[0] };
  });
  if (mounts.find((m) => m.path === "/")?.fs !== "tmpfs" ||
      !mounts.find((m) => m.path === (config.mountPath ?? config.repository))?.options.includes(config.accessMode === "workspace-write" ? "rw" : "ro")) {
    throw new Error("Isolated worker requires its verified mount namespace.");
  }
  const writable = ["/home/worker", "/tmp", ...(config.control === undefined ? [] : [config.control]), ...(config.accessMode === "workspace-write" ? [config.mountPath ?? config.repository] : [])];
  for (const mount of mounts) {
    if (!mount.options.includes("rw") || ["tmpfs", "proc", "devpts", "mqueue"].includes(mount.fs ?? "") || contains("/dev", mount.path)) continue;
    if (!writable.some((root) => contains(root, mount.path))) throw new Error(`Unexpected writable worker mount: ${mount.path}`);
  }
}
