import { homedir } from "node:os";
import { resolve } from "node:path";
import { canonicalDirectory, contains } from "./workspace-sandbox.js";

export interface ClientPathPolicy { allowedRoots: string[]; deniedRoots: string[] }
/** Owner-authorized path selection, with invariant system/credential exclusions. */
export function selectWorkspacePath(path: string, policy: ClientPathPolicy, protectedPaths: readonly string[]): string {
  if (typeof path !== "string" || /[\x00-\x1f\x7f]/.test(path)) throw new Error("workspace_path_denied: control characters are forbidden.");
  let canonical: string;
  try { canonical = canonicalDirectory(path); } catch { throw new Error("workspace_path_denied: directory must exist and be canonical, without symlinks or traversal."); }
  if (!Array.isArray(policy.allowedRoots) || policy.allowedRoots.length === 0 || !Array.isArray(policy.deniedRoots)) throw new Error("Invalid client path policy.");
  if (!policy.allowedRoots.some((root) => contains(canonicalDirectory(root), canonical))) throw new Error("workspace_path_denied: destination is outside owner-approved roots.");
  const denied = ["/proc", "/sys", "/dev", "/run", "/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/boot", "/root", "/opt", "/var",
    ...[".ssh", ".aws", ".config", ".codex", ".claude", ".agents", ".local", ".hermes", ".openclaw", ".gnupg"].map((name) => resolve(homedir(), name)),
    ...policy.deniedRoots, ...protectedPaths];
  if (denied.some((root) => !root.startsWith("/") || contains(resolve(root), canonical) || contains(canonical, resolve(root)))) {
    throw new Error("workspace_path_denied: destination overlaps protected system, credential or control paths.");
  }
  return canonical;
}
