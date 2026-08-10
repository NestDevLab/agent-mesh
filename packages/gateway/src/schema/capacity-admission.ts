export const CAPACITY_WORK_CLASSES = ["L1", "L2", "L3"] as const;
export type CapacityWorkClass = (typeof CAPACITY_WORK_CLASSES)[number];

export interface CapacityAdmissionRequest {
  runId: string;
  provider: "codex" | "claude";
  harness: "codex" | "claude";
  workClass: CapacityWorkClass;
  project?: string;
  session?: string;
  model?: string;
  effort?: string;
  eligibleWork?: number;
}

export interface CapacityAdmissionResult {
  decision: "admit" | "defer";
  retryAt: number | null;
  decisionId: string;
  configHash: string;
  workClass: CapacityWorkClass;
  concurrencyTarget: number;
  reasons: string[];
}

/** Injected boundary. Agent Mesh never invokes a Limen binary or shell itself. */
export interface CapacityAdmissionBroker {
  admit(request: CapacityAdmissionRequest): Promise<CapacityAdmissionResult>;
}

export interface CapacityRoutePolicy {
  provider: "codex" | "claude";
  harness: "codex" | "claude";
  /** Undeclared work is L1 by contract. */
  workClass?: CapacityWorkClass;
  project?: string;
  model?: string;
  effort?: string;
  observerRetryMs?: number;
}
