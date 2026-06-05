import {
  StrictCasRunnerDispatchAdapter,
  createStrictDispatchInputFromPlan
} from "../adapters/cas-runner-dispatch-adapter.js";
import { ControlledDiscordAdapter } from "../adapters/controlled-discord-adapter.js";
import { createCasRunnerPlan } from "../core/cas-runner-planner.js";
import { planDiscordDelivery } from "../core/discord-delivery-planner.js";
import { selectMemoryFabricPolicyDecision } from "../core/memory-fabric-policy.js";
import {
  type CasTeamSizingRecommendation,
  recommendCasTeamSize,
  selectModelProfile
} from "../core/model-selection.js";
import { selectStaleBacklogProposals } from "../core/proactivity-selectors.js";
import { createPolicyDecisionRecord } from "../core/risk-classifier.js";
import type { PolicyRiskInput } from "../core/risk-classifier.js";
import type { CasRunnerDispatchRecord } from "../schema/cas-runner-dispatch.js";
import type { CasRunnerPlanRecord } from "../schema/cas-runner-plan.js";
import type { DiscordDeliveryPlan } from "../schema/discord-delivery-plan.js";
import type { DiscordSendAttemptRecord } from "../schema/discord-send-attempt.js";
import type { ExecutionJob } from "../schema/execution-job.js";
import type {
  MemoryFabricPolicyDecision,
  MemoryFabricProposal
} from "../schema/memory-fabric.js";
import type { ModelSelectionRecord } from "../schema/model-selection.js";
import type { PolicyDecisionRecord } from "../schema/policy-decision.js";
import type { ProactivityRecord } from "../schema/proactivity.js";

const DEMO_NOW = "2026-05-10T12:30:00.000Z";
const DEMO_STATE_DIR = "/tmp/openclaw-agent-mesh-gateway-phase2-policy-demo";

export interface Phase2PolicyDemoResult {
  demo: "phase2-policy-inspection" | "phase2-policy-completion";
  generated_at: string;
  memory_proposal_decision: MemoryFabricPolicyDecision;
  stale_backlog_proactivity_proposal: ProactivityRecord;
  model_selection_for_code_implementation: ModelSelectionRecord;
  cas_team_sizing: CasTeamSizingRecommendation;
  guardrails: {
    no_external_execution: true;
    no_external_write: true;
    no_runtime_config_change: true;
    real_adapters_called: false;
  };
}

export interface Phase2PolicyCompletionDemoResult extends Phase2PolicyDemoResult {
  demo: "phase2-policy-completion";
  unified_policy_decisions: {
    memory: PolicyDecisionRecord;
    proactivity: PolicyDecisionRecord;
    model_selection: PolicyDecisionRecord;
    cas_plan: PolicyDecisionRecord;
    cas_dispatch: PolicyDecisionRecord;
    discord_plan: PolicyDecisionRecord;
    discord_send: PolicyDecisionRecord;
  };
  cas_runner_plan: CasRunnerPlanRecord;
  cas_dispatch_attempt: CasRunnerDispatchRecord;
  cas_dispatch_result: CasRunnerDispatchRecord;
  discord_delivery_plan: DiscordDeliveryPlan;
  discord_send_attempt: DiscordSendAttemptRecord;
  injected_adapters: {
    fake_dispatcher_called: boolean;
    fake_dispatcher_call_count: number;
    fake_sender_called: boolean;
    fake_sender_call_count: number;
    direct_openclaw_message_tool_called: false;
    direct_codex_workers_called: false;
  };
}

export function buildPhase2PolicyDemo(): Phase2PolicyDemoResult {
  const memoryProposal = buildMemoryProposal();
  const memoryDecision = {
    ...selectMemoryFabricPolicyDecision(memoryProposal, {
      now: DEMO_NOW,
      agentDomainAccess: {
        "agent.software_engineer": ["domain.nestdev"]
      }
    }),
    id: "memory_policy_decision_phase2_demo"
  };

  const [staleBacklogProposal] = selectStaleBacklogProposals(
    [
      {
        id: "task-phase2-backlog-hygiene",
        title: "Phase 2 backlog hygiene has not been reviewed",
        workspace_id: "workspace.the operator",
        domain_id: "domain.nestdev",
        project_id: "project.agent_mesh",
        task_id: "task.phase2.backlog",
        owner_agent_id: null,
        stale_since: "2026-05-01T00:00:00.000Z",
        memory_policy_scope: "domain.nestdev"
      }
    ],
    {
      clock: fixedClock(DEMO_NOW),
      defaultAgentId: "agent.project_manager"
    }
  );

  const modelSelection = selectModelProfile({
    agent_id: "agent.software_engineer",
    agent_role: "software_engineering",
    workspace_id: "workspace.the operator",
    domain_id: "domain.nestdev",
    project_id: "project.agent_mesh",
    task_id: "task.phase2.demo",
    task_kind: "code_implementation",
    complexity: "medium",
    risk: "medium",
    sensitivity: "internal",
    external_side_effects_possible: false,
    created_at: DEMO_NOW
  });

  const casTeamSizing = recommendCasTeamSize({
    task_kind: "code_implementation",
    complexity: "medium",
    risk: "medium",
    external_side_effects_possible: false
  });

  return {
    demo: "phase2-policy-inspection",
    generated_at: DEMO_NOW,
    memory_proposal_decision: memoryDecision,
    stale_backlog_proactivity_proposal: staleBacklogProposal,
    model_selection_for_code_implementation: modelSelection,
    cas_team_sizing: casTeamSizing,
    guardrails: {
      no_external_execution: true,
      no_external_write: true,
      no_runtime_config_change: true,
      real_adapters_called: false
    }
  };
}

export async function buildPhase2PolicyCompletionDemo(): Promise<Phase2PolicyCompletionDemoResult> {
  const base = buildPhase2PolicyDemo();
  const executionJob = buildExecutionJob();
  const casPlan = {
    ...createCasRunnerPlan(
      {
        executionJob,
        thread_name: "agent-mesh/job-u-policy-completion",
        cas_roles: base.cas_team_sizing.roles,
        operation_mode: "code_edit",
        approval_policy: "ask_before_write",
        allowed_actions: ["read", "edit_package_files", "run_tests"],
        forbidden_actions: ["openclaw_core_edit"],
        metadata: {
          demo: "phase2-policy-completion",
          common_policy_records: true
        }
      },
      fixedClock(DEMO_NOW)
    ),
    id: "cas_runner_plan_phase2_completion",
    created_at: DEMO_NOW
  };

  const discordPlan = {
    ...planDiscordDelivery(
      {
        message_kind: "safe_status_summary",
        workspace_id: "workspace.the operator",
        domain_id: "domain.nestdev",
        conversation_id: "conversation.phase2.policy",
        source_event_id: "event.phase2.policy",
        source_message_id: "message.phase2.policy",
        target: {
          surface: "discord",
          guild_id: "guild.demo",
          channel_id: "channel.demo",
          thread_id: "thread.demo",
          route_policy_id: "route.demo.stub"
        },
        content: {
          title: "Agent Mesh policy completion",
          body: "Redacted local-only status summary for the Phase 2/3 policy demo."
        },
        sensitivity: "internal",
        redaction_state: "redacted",
        idempotency_key: "discord-delivery-phase2-policy-completion",
        dry_run: true,
        no_external_send: true,
        metadata: {
          demo: "phase2-policy-completion",
          common_policy_records: true
        }
      },
      { clock: fixedClock(DEMO_NOW) }
    ),
    id: "discord_delivery_plan_phase2_completion",
    created_at: DEMO_NOW
  };

  const policyDecisions = {
    memory: deterministicPolicyDecision(
      "policy_decision_memory_phase2_completion",
      {
        subject_kind: "memory_action",
        subject_id: base.memory_proposal_decision.proposal_id,
        target: "mem0_scope",
        tool_capability: "propose_memory_write",
        operation_reversibility: "reversible",
        metadata: {
          source_decision_id: base.memory_proposal_decision.id
        }
      }
    ),
    proactivity: deterministicPolicyDecision(
      "policy_decision_proactivity_phase2_completion",
      {
        subject_kind: "proactivity_action",
        subject_id: base.stale_backlog_proactivity_proposal.event_id,
        tool_capability: "triage",
        explicitly_requested: false,
        metadata: {
          source_schema: base.stale_backlog_proactivity_proposal.schema
        }
      }
    ),
    model_selection: deterministicPolicyDecision(
      "policy_decision_model_selection_phase2_completion",
      {
        subject_kind: "model_selection",
        subject_id: base.model_selection_for_code_implementation.event_id,
        model_tier: base.model_selection_for_code_implementation.selected_profile,
        cost_tier: "medium",
        tool_capability: "select_model_profile",
        metadata: {
          selected_model_alias:
            base.model_selection_for_code_implementation.selected_model_alias
        }
      }
    ),
    cas_plan: deterministicPolicyDecision("policy_decision_cas_plan_phase2_completion", {
      subject_kind: "cas_runner_plan",
      subject_id: casPlan.id,
      target: "local_package_files",
      tool_capability: "read",
      metadata: {
        source_schema: casPlan.schema
      }
    }),
    cas_dispatch: deterministicPolicyDecision(
      "policy_decision_cas_dispatch_phase2_completion",
      {
        subject_kind: "cas_runner_plan",
        subject_id: casPlan.id,
        target: "local_package_files",
        tool_capability: "read",
        metadata: {
          injected_dispatcher_only: true
        }
      }
    ),
    discord_plan: deterministicPolicyDecision(
      "policy_decision_discord_plan_phase2_completion",
      {
        subject_kind: "discord_delivery",
        subject_id: discordPlan.id,
        destination: "discord",
        target: "discord_delivery_plan",
        tool_capability: "plan_message",
        metadata: {
          source_plan_decision: discordPlan.decision
        }
      }
    ),
    discord_send: deterministicPolicyDecision(
      "policy_decision_discord_send_phase2_completion",
      {
        subject_kind: "discord_delivery",
        subject_id: discordPlan.id,
        target: "injected_fake_sender",
        tool_capability: "fake_boundary",
        sensitivity: "public",
        metadata: {
          injected_sender_only: true
        }
      }
    )
  };

  const fakeDispatcher = createFakeDispatcher();
  const dispatchAdapter = new StrictCasRunnerDispatchAdapter(fakeDispatcher, {
    stateDir: DEMO_STATE_DIR,
    clock: fixedClock(DEMO_NOW)
  });
  const dispatch = await dispatchAdapter.dispatch(
    createStrictDispatchInputFromPlan(casPlan, {
      enable_real_dispatch: true,
      policy_decision: policyDecisions.cas_dispatch,
      metadata: {
        demo: "phase2-policy-completion",
        injected_dispatcher_only: true
      }
    })
  );

  if (!dispatch.result) {
    throw new Error("Phase 2 policy completion demo expected fake CAS dispatch result.");
  }

  const fakeSender = createFakeSender();
  const discordAdapter = new ControlledDiscordAdapter({
    sender: fakeSender,
    clock: fixedClock(DEMO_NOW)
  });
  const sendAttempt = await discordAdapter.send({
    enable_real_send: true,
    delivery_plan: discordPlan,
    policy_decision: policyDecisions.discord_send,
    configured_targets: [
      {
        guild_id: "guild.demo",
        channel_id: "channel.demo",
        thread_id: "thread.demo"
      }
    ],
    guards: {
      accepted: true,
      kill_switch_active: false,
      paused: false
    },
    object_mutation_policy: {
      allow_message_create: true,
      allow_channel_or_thread_mutation: false
    },
    requested_object_mutations: ["message_create"],
    metadata: {
      demo: "phase2-policy-completion",
      injected_sender_only: true
    }
  });

  return {
    ...base,
    demo: "phase2-policy-completion",
    unified_policy_decisions: policyDecisions,
    cas_runner_plan: casPlan,
    cas_dispatch_attempt: {
      ...dispatch.attempt,
      id: "cas_runner_dispatch_attempt_phase2_completion",
      created_at: DEMO_NOW
    },
    cas_dispatch_result: {
      ...dispatch.result,
      id: "cas_runner_dispatch_result_phase2_completion",
      created_at: DEMO_NOW
    },
    discord_delivery_plan: discordPlan,
    discord_send_attempt: {
      ...sendAttempt,
      attempt_id: "discord_send_attempt_phase2_completion",
      attempted_at: DEMO_NOW
    },
    guardrails: {
      ...base.guardrails,
      real_adapters_called: false
    },
    injected_adapters: {
      fake_dispatcher_called: fakeDispatcher.calls.length > 0,
      fake_dispatcher_call_count: fakeDispatcher.calls.length,
      fake_sender_called: fakeSender.calls.length > 0,
      fake_sender_call_count: fakeSender.calls.length,
      direct_openclaw_message_tool_called: false,
      direct_codex_workers_called: false
    }
  };
}

function buildMemoryProposal(): MemoryFabricProposal {
  return {
    id: "memory_proposal_phase2_demo",
    requested_by_agent_id: "agent.software_engineer",
    workspace_id: "workspace.the operator",
    domain_id: "domain.nestdev",
    project_id: "project.agent_mesh",
    task_id: "task.phase2.demo",
    target: "mem0_scope",
    operation: "propose_write",
    scope: "domain.nestdev",
    sensitivity: "internal",
    redaction_state: "none",
    provenance: {
      source_kind: "derived_summary",
      source_id: "phase2-demo"
    },
    content: {
      summary: "Phase 2 demo policy outputs are proposal-only and stubbed."
    },
    policy_profile: "memory_fabric_phase_2_stub",
    created_at: DEMO_NOW,
    no_external_write: true,
    metadata: {
      demo: "phase2-policy-inspection",
      adapter_mode: "stub-only"
    }
  };
}

function buildExecutionJob(): ExecutionJob {
  return {
    id: "execution_job_phase2_completion",
    status: "stubbed",
    runner: "codex-stub",
    request: {
      requested_by_agent_id: "agent.software_engineer",
      workspace_id: "workspace.the operator",
      domain_id: "domain.nestdev",
      project_id: "project.agent_mesh",
      task_id: "task.phase2.policy_completion",
      conversation_id: "conversation.phase2.policy",
      summary: "Record the local-only CAS runner plan for Phase 2 policy completion.",
      policy_profile: "software_business_standard",
      endpoint_id: "default",
      workspace_dir: "/path/to/runtime/workspace/openclaw-agent-mesh-gateway",
      repo_scope: "openclaw-agent-mesh-gateway",
      approval_profile: "phase-2-local-stub",
      approval_required: false,
      metadata: {
        demo: "phase2-policy-completion"
      }
    },
    governance: {
      decision: "record_only",
      policy_profile: "software_business_standard",
      approval_profile: "phase-2-local-stub",
      approval_status: "approved_stubbed",
      no_external_execution: true,
      reason: "Completion demo is local-only and uses injected fake adapters.",
      evaluated_at: DEMO_NOW,
      workspace_id: "workspace.the operator",
      domain_id: "domain.nestdev",
      project_id: "project.agent_mesh",
      task_id: "task.phase2.policy_completion",
      conversation_id: "conversation.phase2.policy",
      metadata: {
        no_real_cas_or_codex_workers: true
      }
    },
    created_at: DEMO_NOW,
    updated_at: DEMO_NOW
  };
}

function deterministicPolicyDecision(
  decisionId: string,
  overrides: Partial<PolicyRiskInput>
): PolicyDecisionRecord {
  return {
    ...createPolicyDecisionRecord(
      {
        subject_kind: "execution_job",
        subject_id: "execution_job_phase2_completion",
        sensitivity: "internal",
        external_side_effects: false,
        no_external_side_effects: true,
        target: "local_package_files",
        destination: "local",
        cost_tier: "low",
        model_tier: "routine_fast",
        tool_capability: "read",
        domain_id: "domain.nestdev",
        project_id: "project.agent_mesh",
        operation_reversibility: "reversible",
        explicitly_requested: true,
        redaction_state: "redacted",
        ...overrides
      },
      { clock: fixedClock(DEMO_NOW) }
    ),
    decision_id: decisionId,
    evaluated_at: DEMO_NOW
  };
}

function createFakeDispatcher() {
  return {
    calls: [] as unknown[],
    async dispatch(payload: unknown) {
      this.calls.push(payload);
      return {
        dispatcher_result_id: "fake-dispatch-result-phase2-completion",
        status: "dispatched" as const,
        summary: "Injected fake dispatcher accepted the local-only CAS dispatch.",
        metadata: {
          fake: true,
          no_cas_or_codex_workers_call: true
        }
      };
    }
  };
}

function createFakeSender() {
  return {
    calls: [] as unknown[],
    async sendMessage(request: unknown) {
      this.calls.push(request);
      return {
        discord_message_id: "fake-discord-message-phase2-completion",
        metadata: {
          fake: true,
          no_openclaw_message_tool_call: true
        }
      };
    }
  };
}

function fixedClock(isoTimestamp: string): { now(): Date } {
  return {
    now() {
      return new Date(isoTimestamp);
    }
  };
}
