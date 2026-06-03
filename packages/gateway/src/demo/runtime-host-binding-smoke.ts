import {
  CasHostBindingFacade,
  createHostCasInvocationRequest,
  type HostCasInvocationRequest
} from "../adapters/cas-host-binding-facade.js";
import type { CasRunnerDispatchPayload } from "../adapters/cas-runner-dispatch-adapter.js";
import {
  OpenClawHostMessageSender,
  toHostMessageSendRequest,
  type OpenClawHostMessageSendRequest
} from "../adapters/openclaw-host-message-sender.js";
import type { DiscordMessageSendRequest } from "../adapters/controlled-discord-adapter.js";

const DEMO_NOW = "2026-05-10T19:06:00.000Z";

export interface RuntimeHostBindingSmokeResult {
  demo: "runtime-host-binding-smoke";
  generated_at: string;
  guardrails: {
    no_core_config_change: true;
    no_direct_tool_calls: true;
    dry_run: true;
    temp_workspace_required: true;
    temp_workspace_required_default: true;
    real_send_enabled: false;
  };
  cas: {
    request: HostCasInvocationRequest;
    facade_result: {
      dispatcher_result_id: string;
      status: "dispatched";
      summary: string;
      metadata?: Record<string, unknown>;
    };
  };
  discord: {
    request: OpenClawHostMessageSendRequest;
    facade_result: {
      discord_message_id: string;
      metadata?: Record<string, unknown>;
    };
  };
  injected_fakes: {
    fake_cas_invoker_called: boolean;
    fake_cas_invoker_call_count: number;
    fake_discord_host_sender_called: boolean;
    fake_discord_host_sender_call_count: number;
    direct_openclaw_tool_called: false;
    direct_codex_workers_called: false;
    real_message_send_called: false;
  };
}

export async function buildRuntimeHostBindingSmokeDemo(): Promise<RuntimeHostBindingSmokeResult> {
  const casPayload = sampleCasPayload();
  const discordPayload = sampleDiscordPayload();
  const expectedCasRequest = createHostCasInvocationRequest(casPayload, {
    smokeMode: true,
    tempWorkspaceRequired: true
  });
  const expectedDiscordRequest = toHostMessageSendRequest(discordPayload, {
    dryRun: true,
    smoke: true,
    metadata: {
      demo: "runtime-host-binding-smoke",
      no_core_config_change: true,
      no_direct_tool_calls: true,
      real_send_enabled: false
    }
  });

  const casCalls: HostCasInvocationRequest[] = [];
  const casFacade = new CasHostBindingFacade(async (request) => {
    casCalls.push(request);
    return {
      invocationId: "fake-cas-invocation-runtime-smoke",
      summary: "Fake CAS host invoker accepted the dry-run smoke request.",
      metadata: {
        fake_host_invoker: true,
        dry_run: true,
        no_direct_tool_calls: true
      }
    };
  });

  const discordCalls: OpenClawHostMessageSendRequest[] = [];
  const discordSender = new OpenClawHostMessageSender({
    dryRun: true,
    allowRealSends: false,
    metadata: {
      demo: "runtime-host-binding-smoke",
      no_core_config_change: true,
      no_direct_tool_calls: true,
      real_send_enabled: false
    },
    async sendMessage(request) {
      discordCalls.push(request);
      return {
        message_id: "fake-discord-dry-run-message-runtime-smoke",
        dry_run: true,
        metadata: {
          fake_host_sender: true,
          dry_run: true,
          real_send_enabled: false
        }
      };
    }
  });

  const casResult = await casFacade.dispatch(casPayload);
  const discordResult = await discordSender.sendMessage(discordPayload);

  return {
    demo: "runtime-host-binding-smoke",
    generated_at: DEMO_NOW,
    guardrails: {
      no_core_config_change: true,
      no_direct_tool_calls: true,
      dry_run: true,
      temp_workspace_required: true,
      temp_workspace_required_default: true,
      real_send_enabled: false
    },
    cas: {
      request: casCalls[0] ?? expectedCasRequest,
      facade_result: casResult
    },
    discord: {
      request: discordCalls[0] ?? expectedDiscordRequest,
      facade_result: discordResult
    },
    injected_fakes: {
      fake_cas_invoker_called: casCalls.length > 0,
      fake_cas_invoker_call_count: casCalls.length,
      fake_discord_host_sender_called: discordCalls.length > 0,
      fake_discord_host_sender_call_count: discordCalls.length,
      direct_openclaw_tool_called: false,
      direct_codex_workers_called: false,
      real_message_send_called: false
    }
  };
}

function sampleCasPayload(): CasRunnerDispatchPayload {
  return {
    execution_job_id: "execution_job_runtime_smoke",
    plan_id: "cas_runner_plan_runtime_smoke",
    endpoint_id: "default",
    workspace_dir: "/tmp/openclaw-agent-mesh-runtime-wrapper-smoke",
    repo_scope: "openclaw-agent-mesh-runtime-wrapper-smoke",
    thread_name: "agent-mesh/runtime-host-binding-smoke",
    cas_roles: ["implementer"],
    operation_mode: "code_edit",
    approval_policy: "ask_before_write",
    allowed_actions: ["read", "edit_package_files", "run_tests"],
    forbidden_actions: [
      "push",
      "publish",
      "deploy",
      "restart",
      "delete",
      "openclaw_core_edit",
      "external_message",
      "real_cas_adapter_call",
      "codex_workers_run_task"
    ],
    metadata: {
      summary: "Dry-run wrapper smoke for host CAS binding facades.",
      demo: "runtime-host-binding-smoke"
    }
  };
}

function sampleDiscordPayload(): DiscordMessageSendRequest {
  return {
    target: {
      surface: "discord",
      guild_id: "guild.runtime-smoke",
      channel_id: "channel.runtime-smoke",
      thread_id: "thread.runtime-smoke"
    },
    content: {
      title: "Runtime wrapper smoke",
      body: "Dry-run only: fake host sender request for the local runtime wrapper."
    },
    idempotency_key: "runtime-host-binding-smoke-discord"
  };
}
