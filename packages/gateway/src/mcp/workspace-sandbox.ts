import { realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve, relative } from "node:path";
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
  control?: string;
}
/** Empty mount namespace: never bind /, /home, /run, host /tmp or a host tmux socket. */
export function sandboxArguments(config: WorkspaceSandboxConfig, command: string, args: readonly string[]): string[] {
  for (const value of [config.repository, config.codeRoot, config.home, config.temporary]) canonicalDirectory(value);
  if (config.control !== undefined) canonicalDirectory(config.control);
  const paths = [config.repository, config.codeRoot, config.home, config.temporary, ...(config.control === undefined ? [] : [config.control])];
  for (let i = 0; i < paths.length; i++) for (let j = i + 1; j < paths.length; j++) {
    if (contains(paths[i]!, paths[j]!) || contains(paths[j]!, paths[i]!)) throw new Error("Worker mounts must not overlap.");
  }
  if (!["read-only", "workspace-write"].includes(config.accessMode)) throw new Error("Invalid sandbox mode.");
  const result = ["--unshare-all", "--die-with-parent", "--share-net", "--new-session", "--cap-drop", "ALL", "--clearenv",
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/run", "--tmpfs", "/var", "--dir", "/etc"];
  // Read-only runtime dependencies, deliberately excluding the host's home and socket trees.
  for (const path of ["/usr", "/bin", "/lib", "/lib64", "/etc/ssl", "/etc/hosts", "/etc/resolv.conf", "/etc/nsswitch.conf", "/etc/passwd", "/etc/group", "/etc/ld.so.cache"]) {
    try { statSync(path); result.push("--ro-bind", path, path); } catch { /* optional platform runtime */ }
  }
  result.push("--bind", config.temporary, "/tmp", "--bind", config.home, "/home/worker");
  if (config.control !== undefined) result.push("--bind", config.control, config.control);
  result.push("--ro-bind", config.codeRoot, config.codeRoot,
    config.accessMode === "workspace-write" ? "--bind" : "--ro-bind", config.repository, config.repository,
    "--setenv", "HOME", "/home/worker", "--setenv", "PATH", "/usr/local/bin:/usr/bin:/bin",
    "--setenv", "TMPDIR", "/tmp", "--setenv", "MESH_TMUX_SOCKET", "mesh-isolated",
    "--setenv", "MESH_STRICT_READY", "1", "--setenv", "MESH_PRESERVE_SESSION_POLICY", "1",
    "--setenv", "MESH_REPLACE_UNREADY_SESSION", "1", "--setenv", "AGENT_MESH_ROOT", config.codeRoot,
    "--chdir", config.repository, "--", command, ...args);
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
      !mounts.find((m) => m.path === config.repository)?.options.includes(config.accessMode === "workspace-write" ? "rw" : "ro")) {
    throw new Error("Isolated worker requires its verified mount namespace.");
  }
  const writable = ["/home/worker", "/tmp", ...(config.control === undefined ? [] : [config.control]), ...(config.accessMode === "workspace-write" ? [config.repository] : [])];
  for (const mount of mounts) {
    if (!mount.options.includes("rw") || ["tmpfs", "proc", "devpts", "mqueue"].includes(mount.fs ?? "") || contains("/dev", mount.path)) continue;
    if (!writable.some((root) => contains(root, mount.path))) throw new Error(`Unexpected writable worker mount: ${mount.path}`);
  }
}
