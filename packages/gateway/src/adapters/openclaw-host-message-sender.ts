import type {
  DiscordMessageSender,
  DiscordMessageSendRequest,
  DiscordMessageSendResult
} from "./controlled-discord-adapter.js";
import type { JsonObject } from "../schema/validation.js";

export interface OpenClawHostDiscordTarget {
  surface: "discord";
  type: "channel" | "thread";
  channel_id: string;
  thread_id?: string | null;
  guild_id?: string | null;
}

export interface OpenClawHostMessageSendRequest {
  channel: "discord";
  target: OpenClawHostDiscordTarget;
  content: {
    title: string;
    body: string;
  };
  idempotency_key: string;
  dry_run: boolean;
  metadata: JsonObject & {
    facade: "openclaw-agent-mesh-gateway.discord-host-message-sender.v1";
    smoke: boolean;
    source: "agent-mesh-gateway";
    direct_openclaw_message_tool_call: false;
  };
}

export interface OpenClawHostMessageSendResult {
  message_id?: string | null;
  dry_run?: boolean;
  metadata?: JsonObject;
}

export type OpenClawHostMessageSendFunction = (
  request: OpenClawHostMessageSendRequest
) => Promise<OpenClawHostMessageSendResult>;

export interface OpenClawHostMessageSenderOptions {
  sendMessage: OpenClawHostMessageSendFunction;
  dryRun?: boolean;
  allowRealSends?: boolean;
  smoke?: boolean;
  metadata?: JsonObject;
}

export class OpenClawHostMessageSender implements DiscordMessageSender {
  private readonly hostSendMessage: OpenClawHostMessageSendFunction;
  private readonly dryRun: boolean;
  private readonly allowRealSends: boolean;
  private readonly smoke: boolean;
  private readonly metadata?: JsonObject;

  constructor(options: OpenClawHostMessageSenderOptions) {
    this.hostSendMessage = options.sendMessage;
    this.dryRun = options.dryRun ?? true;
    this.allowRealSends = options.allowRealSends === true;
    this.smoke = options.smoke ?? true;
    this.metadata = options.metadata;
  }

  async sendMessage(request: DiscordMessageSendRequest): Promise<DiscordMessageSendResult> {
    if (this.dryRun !== true && this.allowRealSends !== true) {
      throw new Error("OpenClaw host message sender rejects real sends by default.");
    }

    const hostRequest = toHostMessageSendRequest(request, {
      dryRun: this.dryRun,
      smoke: this.smoke,
      metadata: this.metadata
    });
    const result = await this.hostSendMessage(hostRequest);
    const messageId = result.message_id ?? dryRunMessageId(request.idempotency_key);

    return {
      discord_message_id: messageId,
      metadata: {
        host_channel: hostRequest.channel,
        dry_run: hostRequest.dry_run,
        smoke: hostRequest.metadata.smoke,
        target_type: hostRequest.target.type,
        ...(result.metadata ?? {})
      }
    };
  }
}

export function toHostMessageSendRequest(
  request: DiscordMessageSendRequest,
  options: {
    dryRun?: boolean;
    smoke?: boolean;
    metadata?: JsonObject;
  } = {}
): OpenClawHostMessageSendRequest {
  const dryRun = options.dryRun ?? true;

  return {
    channel: "discord",
    target: toHostTarget(request.target),
    content: {
      title: request.content.title,
      body: request.content.body
    },
    idempotency_key: request.idempotency_key,
    dry_run: dryRun,
    metadata: {
      ...(options.metadata ?? {}),
      facade: "openclaw-agent-mesh-gateway.discord-host-message-sender.v1",
      smoke: options.smoke ?? true,
      source: "agent-mesh-gateway",
      direct_openclaw_message_tool_call: false
    }
  };
}

function toHostTarget(
  target: DiscordMessageSendRequest["target"]
): OpenClawHostDiscordTarget {
  const threadId = normalizeOptionalString(target.thread_id);
  const guildId = normalizeOptionalString(target.guild_id);

  return {
    surface: "discord",
    type: threadId === undefined ? "channel" : "thread",
    channel_id: target.channel_id,
    ...(threadId !== undefined ? { thread_id: threadId } : {}),
    ...(guildId !== undefined ? { guild_id: guildId } : {})
  };
}

function normalizeOptionalString(value: string | null | undefined): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value;
}

function dryRunMessageId(idempotencyKey: string): string {
  return `dry-run:${idempotencyKey}`;
}
