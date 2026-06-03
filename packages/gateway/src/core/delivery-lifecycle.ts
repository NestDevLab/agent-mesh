import type { AuditEvent } from "../schema/audit.js";
import type { DeadLetterRecord } from "./dead-letter-store.js";
import type { DeliveryRecord } from "../schema/delivery.js";
import type { IdempotencyRecord } from "./idempotency-store.js";

export interface DeliveryLifecycleSummary {
  message_id: string;
  adapters: string[];
  final_status_by_adapter: Record<string, DeliveryRecord["status"]>;
  attempts_by_adapter: Record<string, number>;
  audit_coverage: {
    queued: boolean;
    updated: boolean;
    invalid_transition: boolean;
    dead_lettered: boolean;
  };
  dead_letters: number;
  idempotency_present: boolean;
  issues: string[];
}

export function summarizeDeliveryLifecycle(input: {
  message_id: string;
  deliveries: DeliveryRecord[];
  audits: AuditEvent[];
  deadLetters?: DeadLetterRecord[];
  idempotencyRecords?: IdempotencyRecord[];
  idempotencyKey?: string;
}): DeliveryLifecycleSummary {
  const byAdapter = new Map<string, DeliveryRecord[]>();
  for (const record of input.deliveries.filter((entry) => entry.message_id === input.message_id)) {
    const bucket = byAdapter.get(record.adapter_id) ?? [];
    bucket.push(record);
    byAdapter.set(record.adapter_id, bucket);
  }

  const final_status_by_adapter: Record<string, DeliveryRecord["status"]> = {};
  const attempts_by_adapter: Record<string, number> = {};
  const issues: string[] = [];

  for (const [adapterId, records] of byAdapter.entries()) {
    const ordered = [...records].sort((a, b) => a.updated_at.localeCompare(b.updated_at));
    const final = ordered.at(-1);
    if (!final) continue;
    final_status_by_adapter[adapterId] = final.status;
    attempts_by_adapter[adapterId] = final.attempts;

    if (ordered[0]?.status !== "queued") {
      issues.push(`adapter ${adapterId} did not start at queued`);
    }
    if (!ordered.some((entry) => entry.status === "dispatching") && final.status !== "queued") {
      issues.push(`adapter ${adapterId} missing dispatching transition`);
    }
    if (final.status === "failed" && final.attempts < final.max_attempts) {
      issues.push(`adapter ${adapterId} failed before max attempts were exhausted`);
    }
  }

  const audits = input.audits.filter((event) => event.message_id === input.message_id);
  const deadLetters = (input.deadLetters ?? []).filter((entry) => {
    const payload = entry.payload as Record<string, unknown> | undefined;
    return payload?.message_id === input.message_id;
  });

  const audit_coverage = {
    queued: audits.some((event) => event.type === "delivery.queued"),
    updated: audits.some((event) => event.type === "delivery.updated"),
    invalid_transition: audits.some((event) => event.type === "delivery.invalid_transition"),
    dead_lettered: audits.some((event) => event.type === "delivery.dead_lettered")
  };

  if (!audit_coverage.queued) issues.push("missing delivery.queued audit event");
  if (!audit_coverage.updated) issues.push("missing delivery.updated audit event");
  if (deadLetters.length > 0 && !audit_coverage.dead_lettered) {
    issues.push("dead letters exist without delivery.dead_lettered audit coverage");
  }

  const idempotency_present =
    input.idempotencyKey === undefined
      ? (input.idempotencyRecords ?? []).length > 0
      : (input.idempotencyRecords ?? []).some((record) => record.key === input.idempotencyKey);

  if (!idempotency_present) {
    issues.push("missing idempotency record");
  }

  return {
    message_id: input.message_id,
    adapters: [...byAdapter.keys()].sort(),
    final_status_by_adapter,
    attempts_by_adapter,
    audit_coverage,
    dead_letters: deadLetters.length,
    idempotency_present,
    issues
  };
}
