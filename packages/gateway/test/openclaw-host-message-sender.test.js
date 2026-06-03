import assert from "node:assert/strict";
import test from "node:test";

import "./ts-extension-resolver.mjs";

const { OpenClawHostMessageSender, toHostMessageSendRequest } = await import(
  "../src/adapters/openclaw-host-message-sender.ts"
);

test("dry-run host send succeeds and calls the injected host function once", async () => {
  const host = fakeHostSender();
  const sender = new OpenClawHostMessageSender({
    sendMessage: host.sendMessage,
    metadata: { smoke_label: "discord-rollout" }
  });

  const result = await sender.sendMessage(discordRequest());

  assert.equal(host.calls.length, 1);
  assert.equal(result.discord_message_id, "host-dry-run-message-1");
  assert.equal(result.metadata.dry_run, true);
  assert.equal(host.calls[0].channel, "discord");
  assert.equal(host.calls[0].dry_run, true);
  assert.equal(host.calls[0].metadata.smoke, true);
  assert.equal(host.calls[0].metadata.direct_openclaw_message_tool_call, false);
  assert.equal(host.calls[0].metadata.smoke_label, "discord-rollout");
});

test("reserved host metadata cannot be overridden by caller metadata", () => {
  const hostRequest = toHostMessageSendRequest(discordRequest(), {
    metadata: {
      channel: "not-discord",
      facade: "caller-value",
      source: "caller",
      direct_openclaw_message_tool_call: true
    }
  });

  assert.equal(hostRequest.metadata.facade, "openclaw-agent-mesh-gateway.discord-host-message-sender.v1");
  assert.equal(hostRequest.metadata.source, "agent-mesh-gateway");
  assert.equal(hostRequest.metadata.direct_openclaw_message_tool_call, false);
});

test("real host send is rejected by default before calling the host function", async () => {
  const host = fakeHostSender();
  const sender = new OpenClawHostMessageSender({
    sendMessage: host.sendMessage,
    dryRun: false
  });

  await assert.rejects(
    sender.sendMessage(discordRequest()),
    /rejects real sends by default/
  );
  assert.equal(host.calls.length, 0);
});

test("channel and thread targets map deterministically into strict host requests", () => {
  const channelHostRequest = toHostMessageSendRequest(
    discordRequest({
      target: {
        surface: "discord",
        guild_id: "guild-1",
        channel_id: "channel-1"
      }
    })
  );
  const threadHostRequest = toHostMessageSendRequest(discordRequest());

  assert.deepEqual(channelHostRequest.target, {
    surface: "discord",
    type: "channel",
    channel_id: "channel-1",
    guild_id: "guild-1"
  });
  assert.deepEqual(threadHostRequest.target, {
    surface: "discord",
    type: "thread",
    channel_id: "channel-1",
    thread_id: "thread-1",
    guild_id: "guild-1"
  });
  assert.equal(threadHostRequest.channel, "discord");
  assert.deepEqual(threadHostRequest.content, {
    title: "Status",
    body: "Dry-run only."
  });
  assert.equal(threadHostRequest.idempotency_key, "idem-host-discord-1");
});

test("host failure maps to a sender error", async () => {
  const sender = new OpenClawHostMessageSender({
    async sendMessage() {
      throw new Error("host message/send failed");
    }
  });

  await assert.rejects(sender.sendMessage(discordRequest()), /host message\/send failed/);
});

function fakeHostSender() {
  const calls = [];
  return {
    calls,
    async sendMessage(request) {
      calls.push(request);
      return {
        message_id: "host-dry-run-message-1",
        dry_run: request.dry_run,
        metadata: { host_receipt: "receipt-1" }
      };
    }
  };
}

function discordRequest(overrides = {}) {
  return {
    target: {
      surface: "discord",
      guild_id: "guild-1",
      channel_id: "channel-1",
      thread_id: "thread-1"
    },
    content: {
      title: "Status",
      body: "Dry-run only."
    },
    idempotency_key: "idem-host-discord-1",
    ...overrides
  };
}
