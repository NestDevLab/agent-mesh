import { AuditStore } from "./audit-store.js";
import { ApprovalStore } from "./approval-store.js";
import { CasRunnerPlanStore } from "./cas-runner-plan-store.js";
import { DeadLetterStore } from "./dead-letter-store.js";
import { DeliveryStore } from "./delivery-store.js";
import { DiscordDeliveryPlanStore } from "./discord-delivery-plan-store.js";
import { EnvelopeStore } from "./envelope-store.js";
import { ExecutionJobStore } from "./execution-job-store.js";
import { GatewayControlStore } from "./gateway-control-store.js";
import { HeartbeatStore } from "./heartbeat-store.js";
import { IdempotencyStore } from "./idempotency-store.js";
import { isoNow, newEventId, type ReplayWarning, type StoreClock } from "./ndjson-store.js";

export interface StartupRecoverySummary {
  gateway: {
    recovered: {
      audit_events: number;
      delivery_events: number;
      discord_delivery_plans: number;
      envelopes: number;
      idempotency_events: number;
      execution_jobs: number;
      approval_events: number;
      cas_runner_plans: number;
      heartbeats: number;
      dead_letter_records: number;
      gateway_control_events: number;
    };
    warnings: ReplayWarning[];
  };
}

export async function recoverStartupState(
  options: { stateDir?: string; clock?: StoreClock } = {}
): Promise<StartupRecoverySummary> {
  const [
    audit,
    delivery,
    discordDeliveryPlans,
    envelopes,
    idempotency,
    executionJobs,
    approvalEvents,
    casRunnerPlans,
    heartbeats,
    deadLetters,
    gatewayControl
  ] =
    await Promise.all([
      new AuditStore(options).replay(),
      new DeliveryStore(options).replay(),
      new DiscordDeliveryPlanStore(options).replay(),
      new EnvelopeStore(options).replay(),
      new IdempotencyStore(options).hydrate(),
      new ExecutionJobStore(options).replay(),
      new ApprovalStore(options).replay(),
      new CasRunnerPlanStore(options).replay(),
      new HeartbeatStore(options).replay(),
      new DeadLetterStore(options).replay(),
      new GatewayControlStore(options).replay()
    ]);

  const summaryCounts = {
    audit_events: audit.records.length,
    delivery_events: delivery.records.length,
    discord_delivery_plans: discordDeliveryPlans.records.length,
    envelopes: envelopes.records.length,
    idempotency_events: idempotency.records.length,
    execution_jobs: executionJobs.records.length,
    approval_events: approvalEvents.records.length,
    cas_runner_plans: casRunnerPlans.records.length,
    heartbeats: heartbeats.records.length,
    dead_letter_records: deadLetters.records.length,
    gateway_control_events: gatewayControl.records.length
  };
  const warnings = [
    ...audit.warnings,
    ...delivery.warnings,
    ...discordDeliveryPlans.warnings,
    ...envelopes.warnings,
    ...idempotency.warnings,
    ...executionJobs.warnings,
    ...approvalEvents.warnings,
    ...casRunnerPlans.warnings,
    ...heartbeats.warnings,
    ...deadLetters.warnings,
    ...gatewayControl.warnings
  ];

  await new AuditStore(options).append({
    id: newEventId("audit"),
    type: "gateway.recovered",
    created_at: isoNow(options.clock),
    details: {
      recovered: summaryCounts,
      warning_count: warnings.length
    }
  });

  return {
    gateway: {
      recovered: summaryCounts,
      warnings
    }
  };
}
