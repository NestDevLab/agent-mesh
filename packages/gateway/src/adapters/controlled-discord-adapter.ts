import type { DiscordDeliveryPlan } from "../schema/discord-delivery-plan.js";
import {
  DISCORD_SEND_ATTEMPT_SCHEMA,
  type DiscordSendAttemptRecord
} from "../schema/discord-send-attempt.js";
import type { PolicyDecisionRecord } from "../schema/policy-decision.js";
import type { JsonObject } from "../schema/validation.js";
import { isoNow, newEventId, type StoreClock } from "../core/ndjson-store.js";
import type { DiscordSendAttemptStore } from "../core/discord-send-attempt-store.js";

export interface DiscordMessageSendRequest {
  target: {
    surface: "discord";
    guild_id?: string | null;
    channel_id: string;
    thread_id?: string | null;
  };
  content: {
    title: string;
    body: string;
  };
  idempotency_key: string;
}

export interface DiscordMessageSendResult {
  discord_message_id: string;
  metadata?: JsonObject;
}

export interface DiscordMessageSender {
  sendMessage(request: DiscordMessageSendRequest): Promise<DiscordMessageSendResult>;
}

export interface ConfiguredDiscordTarget {
  guild_id?: string | null;
  channel_id: string;
  thread_id?: string | null;
}

export interface DiscordSendGuards {
  accepted: boolean;
  kill_switch_active: boolean;
  paused: boolean;
}

export interface DiscordObjectMutationPolicy {
  allow_message_create: boolean;
  allow_channel_or_thread_mutation?: boolean;
}

export interface ControlledDiscordSendInput {
  enable_real_send: boolean;
  delivery_plan: DiscordDeliveryPlan;
  policy_decision: PolicyDecisionRecord;
  configured_targets: ConfiguredDiscordTarget[];
  guards: DiscordSendGuards;
  object_mutation_policy: DiscordObjectMutationPolicy;
  requested_object_mutations?: string[];
  metadata?: JsonObject;
}

export interface ControlledDiscordAdapterOptions {
  sender: DiscordMessageSender;
  attemptStore?: DiscordSendAttemptStore;
  clock?: StoreClock;
}

export class ControlledDiscordAdapter {
  private readonly sender: DiscordMessageSender;
  private readonly attemptStore?: DiscordSendAttemptStore;
  private readonly clock?: StoreClock;

  constructor(options: ControlledDiscordAdapterOptions) {
    this.sender = options.sender;
    this.attemptStore = options.attemptStore;
    this.clock = options.clock;
  }

  async send(input: ControlledDiscordSendInput): Promise<DiscordSendAttemptRecord> {
    const rejection = rejectionReason(input);
    if (rejection !== null) {
      return this.record(input, {
        status: "denied",
        reason: rejection,
        sender_called: false,
        sender_call_count: 0,
        discord_message_id: null
      });
    }

    try {
      const result = await this.sender.sendMessage({
        target: copyTarget(input.delivery_plan.target),
        content: { ...input.delivery_plan.content },
        idempotency_key: input.delivery_plan.idempotency_key
      });

      return this.record(input, {
        status: "sent",
        reason: "Discord message sent through injected sender boundary.",
        sender_called: true,
        sender_call_count: 1,
        discord_message_id: result.discord_message_id,
        metadata: result.metadata
      });
    } catch (error) {
      return this.record(input, {
        status: "failed",
        reason: error instanceof Error ? error.message : "Injected Discord sender failed.",
        sender_called: true,
        sender_call_count: 1,
        discord_message_id: null
      });
    }
  }

  private async record(
    input: ControlledDiscordSendInput,
    result: {
      status: "sent" | "denied" | "failed";
      reason: string;
      sender_called: boolean;
      sender_call_count: number;
      discord_message_id: string | null;
      metadata?: JsonObject;
    }
  ): Promise<DiscordSendAttemptRecord> {
    const attempt: DiscordSendAttemptRecord = {
      schema: DISCORD_SEND_ATTEMPT_SCHEMA,
      attempt_id: newEventId("discord_send_attempt"),
      delivery_plan_id: input.delivery_plan.id,
      policy_decision_id: input.policy_decision.decision_id,
      idempotency_key: input.delivery_plan.idempotency_key,
      status: result.status,
      reason: result.reason,
      sender_called: result.sender_called,
      sender_call_count: result.sender_call_count,
      openclaw_message_tool_called: false,
      discord_message_id: result.discord_message_id,
      target: copyTarget(input.delivery_plan.target),
      attempted_at: isoNow(this.clock),
      metadata: {
        enable_real_send: input.enable_real_send,
        delivery_plan_decision: input.delivery_plan.decision,
        policy_decision: input.policy_decision.decision,
        requested_object_mutations: [...(input.requested_object_mutations ?? [])],
        ...(input.metadata ?? {}),
        ...(result.metadata !== undefined ? { sender_result: result.metadata } : {})
      }
    };

    await this.attemptStore?.append(attempt);
    return attempt;
  }
}

function rejectionReason(input: ControlledDiscordSendInput): string | null {
  const plan = input.delivery_plan;

  if (input.enable_real_send !== true) {
    return "Real Discord send requires explicit enable_real_send true.";
  }
  if (input.policy_decision.decision !== "allow-once") {
    return "Real Discord send requires an approved allow-once policy decision.";
  }
  if (
    input.policy_decision.subject_kind !== "discord_delivery" ||
    input.policy_decision.subject_id !== plan.id
  ) {
    return "Policy decision must approve this Discord delivery plan.";
  }
  if (plan.decision !== "allow-dry-run" || plan.status !== "planned_stubbed") {
    return "Real Discord send requires a previously allowed dry-run delivery plan.";
  }
  if (plan.dry_run !== true || plan.no_external_send !== true) {
    return "Real Discord send requires the prior plan to be dry-run and no-external-send.";
  }
  if (plan.idempotency_key.trim().length === 0) {
    return "Real Discord send requires a non-empty idempotency key.";
  }
  if (!isConfiguredTarget(plan.target, input.configured_targets)) {
    return "Real Discord send target is not explicitly configured.";
  }
  if (!input.guards.accepted || input.guards.kill_switch_active || input.guards.paused) {
    return "Real Discord send requires accepted kill-switch and pause guards.";
  }
  if (plan.sensitivity === "secret") {
    return "Secret Discord payloads cannot be sent by the controlled adapter.";
  }
  if (plan.sensitivity !== "public" && plan.redaction_state !== "redacted") {
    return "Non-public Discord payloads require redaction before real send.";
  }
  if (!input.object_mutation_policy.allow_message_create) {
    return "Real Discord send requires explicit permission to create a Discord message.";
  }
  if (hasForbiddenObjectMutations(input)) {
    return "Discord channel/thread/edit/delete mutations are not allowed by this adapter input.";
  }

  return null;
}

function isConfiguredTarget(
  target: DiscordDeliveryPlan["target"],
  configuredTargets: ConfiguredDiscordTarget[]
): boolean {
  return configuredTargets.some((configured) => {
    return (
      configured.channel_id === target.channel_id &&
      nullishEqual(configured.thread_id, target.thread_id) &&
      nullishEqual(configured.guild_id, target.guild_id)
    );
  });
}

function hasForbiddenObjectMutations(input: ControlledDiscordSendInput): boolean {
  const requested = input.requested_object_mutations ?? ["message_create"];
  return requested.some((mutation) => {
    if (mutation === "message_create") {
      return false;
    }
    return input.object_mutation_policy.allow_channel_or_thread_mutation !== true;
  });
}

function copyTarget(target: DiscordDeliveryPlan["target"]): DiscordMessageSendRequest["target"] {
  return {
    surface: "discord",
    ...(target.guild_id !== undefined ? { guild_id: target.guild_id } : {}),
    channel_id: target.channel_id,
    ...(target.thread_id !== undefined ? { thread_id: target.thread_id } : {})
  };
}

function nullishEqual(left: string | null | undefined, right: string | null | undefined): boolean {
  return (left ?? null) === (right ?? null);
}
