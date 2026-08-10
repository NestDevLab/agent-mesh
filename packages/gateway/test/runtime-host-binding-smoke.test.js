import assert from "node:assert/strict";
import test from "node:test";

import "./ts-extension-resolver.mjs";

const { buildRuntimeHostBindingSmokeDemo } = await import(
  "../src/demo/runtime-host-binding-smoke.ts"
);

test("runtime host binding smoke demo returns deterministic dry-run JSON", async () => {
  assert.deepEqual(
    await buildRuntimeHostBindingSmokeDemo(),
    await buildRuntimeHostBindingSmokeDemo()
  );
});

test("runtime host binding smoke demo includes runner and Discord host requests", async () => {
  const demo = await buildRuntimeHostBindingSmokeDemo();

  assert.equal(demo.demo, "runtime-host-binding-smoke");
  assert.equal(demo.generated_at, "2026-05-10T19:06:00.000Z");
  assert.equal(demo.runner.request.endpointId, "default");
  assert.equal(
    demo.runner.request.workspaceDir,
    "/tmp/openclaw-agent-mesh-runtime-wrapper-smoke"
  );
  assert.equal(demo.runner.request.safety.noDirectOpenClawTools, true);
  assert.equal(demo.runner.request.safety.noCodexWorkersRunTask, true);
  assert.equal(demo.runner.facade_result.dispatcher_result_id, "fake-runner-invocation-runtime-smoke");
  assert.equal(demo.runner.facade_result.metadata.fake_host_invoker, true);

  assert.equal(demo.discord.request.channel, "discord");
  assert.deepEqual(demo.discord.request.target, {
    surface: "discord",
    type: "thread",
    channel_id: "channel.runtime-smoke",
    thread_id: "thread.runtime-smoke",
    guild_id: "guild.runtime-smoke"
  });
  assert.equal(demo.discord.request.dry_run, true);
  assert.equal(demo.discord.request.metadata.direct_openclaw_message_tool_call, false);
  assert.equal(
    demo.discord.facade_result.discord_message_id,
    "fake-discord-dry-run-message-runtime-smoke"
  );
});

test("runtime host binding smoke demo exposes explicit operational guardrails", async () => {
  const demo = await buildRuntimeHostBindingSmokeDemo();

  assert.deepEqual(demo.guardrails, {
    no_core_config_change: true,
    no_direct_tool_calls: true,
    dry_run: true,
    temp_workspace_required: true,
    temp_workspace_required_default: true,
    real_send_enabled: false
  });
  assert.equal(demo.runner.request.safety.tempWorkspaceRequired, true);
  assert.equal(demo.runner.request.safety.smokeMode, true);
  assert.equal(demo.discord.request.metadata.no_core_config_change, true);
  assert.equal(demo.discord.request.metadata.no_direct_tool_calls, true);
  assert.equal(demo.discord.request.metadata.real_send_enabled, false);
});

test("runtime host binding smoke demo calls only injected fake host functions", async () => {
  const demo = await buildRuntimeHostBindingSmokeDemo();

  assert.deepEqual(demo.injected_fakes, {
    fake_runner_invoker_called: true,
    fake_runner_invoker_call_count: 1,
    fake_discord_host_sender_called: true,
    fake_discord_host_sender_call_count: 1,
    direct_openclaw_tool_called: false,
    direct_codex_workers_called: false,
    real_message_send_called: false
  });
});
