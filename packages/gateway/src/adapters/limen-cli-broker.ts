import type { CapacityAdmissionBroker, CapacityAdmissionRequest, CapacityAdmissionResult } from "../schema/capacity-admission.js";

export interface LimenCommandResult { code: number; stdout: string; stderr: string; }
export interface LimenCommandRunner { run(executable: string, args: readonly string[]): Promise<LimenCommandResult>; }

export interface LimenCliBrokerOptions {
  runner: LimenCommandRunner;
  configPath: string;
  executable?: string;
}

/**
 * Host-injected Limen CLI binding. It constructs argv without a shell and
 * accepts only the documented 0/75 machine protocol.
 */
export class LimenCliBroker implements CapacityAdmissionBroker {
  private readonly runner: LimenCommandRunner;
  private readonly configPath: string;
  private readonly executable: string;

  constructor(options: LimenCliBrokerOptions) {
    if (!options.configPath) throw new Error("LimenCliBroker requires configPath");
    this.runner = options.runner;
    this.configPath = options.configPath;
    this.executable = options.executable ?? "limen";
  }

  async admit(request: CapacityAdmissionRequest): Promise<CapacityAdmissionResult> {
    const args = ["admit", "--config", this.configPath, "--provider", request.provider, "--harness", request.harness, "--run-id", request.runId, "--class", request.workClass];
    for (const [flag, value] of [["--project", request.project], ["--session", request.session], ["--model", request.model], ["--effort", request.effort]] as const) if (value !== undefined) args.push(flag, value);
    if (request.eligibleWork !== undefined) args.push("--eligible-work", String(request.eligibleWork));
    const result = await this.runner.run(this.executable, args);
    if (result.code !== 0 && result.code !== 75) throw new Error(`Limen admission failed with exit ${result.code}: ${bounded(result.stderr)}`);
    let parsed: unknown;
    try { parsed = JSON.parse(result.stdout.trim()); } catch { throw new Error("Limen admission returned invalid JSON"); }
    if (!isAdmission(parsed) || (result.code === 0 && parsed.decision !== "admit") || (result.code === 75 && parsed.decision !== "defer")) throw new Error("Limen admission protocol mismatch");
    return parsed;
  }
}

function isAdmission(value: unknown): value is CapacityAdmissionResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (item.decision === "admit" || item.decision === "defer") && (item.retryAt === null || typeof item.retryAt === "number") && typeof item.decisionId === "string" && typeof item.configHash === "string" && (item.workClass === "L1" || item.workClass === "L2" || item.workClass === "L3") && typeof item.concurrencyTarget === "number" && Array.isArray(item.reasons) && item.reasons.every(reason => typeof reason === "string");
}

const bounded = (value: string) => value.replace(/[\r\n]+/g, " ").slice(0, 240);
