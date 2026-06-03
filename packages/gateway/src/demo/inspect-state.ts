import {
  recoverStartupState,
  type StartupRecoverySummary
} from "../core/recovery-summary.js";

export function describeInspectStateDemo(): string {
  return "Replays append-only Phase 1 state files and returns restart-recovery counts.";
}

export async function inspectStateDemo(): Promise<StartupRecoverySummary> {
  return recoverStartupState();
}
