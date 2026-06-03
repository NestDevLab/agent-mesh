# Controlled CAS Runner Integration Boundary

## Purpose

This document defines the boundary that must exist before Agent Mesh can route a real `execution_job` to Codex App Server (CAS). Phase 2 implementation remains stub-safe until Joseph explicitly approves real CAS execution.

## Current state

Implemented today:

- local `execution_job` records;
- Guardian-style local approval decisions;
- model/reasoning profile selection;
- CAS team-sizing helper;
- CAS runner plan records;
- strict real-dispatch adapter boundary with an injected dispatcher interface;
- runtime host binding facade that adapts the dispatcher interface to a host-provided CAS invocation function;
- local CAS dispatch attempt/result records;
- no direct OpenClaw tool or `codex_workers` calls from the mesh package.

## Required boundary before real CAS

A real CAS runner adapter must enforce:

- explicit `enable_real_dispatch: true`;
- an approved unified policy decision (`allow-once`) scoped to the execution job or CAS runner plan;
- explicit endpoint id, e.g. `default` or `nestdev`;
- explicit workspace/repo scope;
- allowed operation mode: analysis, code edit, test, review;
- approval policy: `ask_before_write`, `ask_before_commit`, `ask_before_push`;
- explicit allowed and forbidden action lists;
- no OpenClaw core edits unless separately approved;
- no publishing, pushing, deploying, or service restart;
- no delete operations;
- no secret injection into prompts beyond scoped necessity;
- persistent CAS thread id and summary;
- pause/cancel intent mapping;
- exact test/typecheck/build result capture;
- Discord-safe summary redaction before transcript mirroring.

## Real execution lifecycle

```text
execution_job proposal
  -> envelope/gateway validation
  -> model policy selection
  -> CAS team-sizing recommendation
  -> Guardian/local approval gate
  -> if approved, real CAS adapter creates/resumes worker thread
  -> CAS worker performs scoped work
  -> adapter records status, thread id, summary, verification
  -> optional Discord-safe transcript summary
```

## Approval requirements

Human approval is required before enabling real CAS execution from the mesh if any of these are true:

- the job can modify files;
- the job can run networked commands or external writes;
- the job can push, publish, deploy, restart, or message externally;
- the repo/workspace is not explicitly scoped;
- private/secret/customer-sensitive context would be sent to a remote provider;
- the model/profile selection implies high cost or high reasoning volume.

## Adapter contract

Controlled dispatch input:

```json
{
  "execution_job_id": "exec_job_...",
  "plan_id": "cas_runner_plan_...",
  "enable_real_dispatch": true,
  "policy_decision": {
    "decision_id": "policy_decision_...",
    "decision": "allow-once",
    "subject_id": "cas_runner_plan_..."
  },
  "endpoint_id": "default",
  "workspace_dir": "/root/.openclaw/workspace/openclaw-agent-mesh-gateway",
  "repo_scope": "openclaw-agent-mesh-gateway",
  "thread_name": "agent-mesh/job-x",
  "cas_roles": ["implementer", "reviewer_qa"],
  "approval_policy": "ask_before_write",
  "allowed_actions": ["read", "edit_package_files", "run_tests"],
  "forbidden_actions": ["openclaw_core_edit", "push", "publish", "deploy", "restart", "delete", "external_message", "codex_workers_run_task"],
  "no_external_side_effects": true
}
```

Injected dispatcher output:

```json
{
  "execution_job_id": "exec_job_...",
  "status": "dispatched",
  "dispatcher_result_id": "fake-or-real-boundary-result-id",
  "summary": "Safe dispatch summary."
}
```

The package owns only the strict gate and local record persistence. A caller must inject any real dispatcher implementation. Tests use a fake dispatcher and assert it is called exactly once only for the fully approved case.

The runtime host binding facade is the safe binding shape for OpenClaw CAS/Codex worker dispatch. It accepts only a host-provided function and translates the dispatcher payload into a strict request:

```json
{
  "endpointId": "default",
  "workspaceDir": "/tmp/openclaw-agent-mesh-cas-smoke",
  "threadName": "agent-mesh/job-v",
  "prompt": "Guardrails:\n- workspace-only\n- no push/publish/deploy/restart/delete\n- no secrets\n- report files/test output",
  "safety": {
    "smokeMode": true,
    "tempWorkspaceRequired": true,
    "workspaceOnly": true,
    "noPushPublishDeployRestartDelete": true,
    "noSecrets": true,
    "reportFilesAndTestOutput": true,
    "noDirectOpenClawTools": true,
    "noCodexWorkersRunTask": true
  }
}
```

By default it rejects non-`/tmp` workspaces. A non-temp workspace requires an explicit caller option and should only be used after a separate rollout approval.

## Hard non-goals

- No automatic CAS launch from inbound mesh envelopes.
- No direct CAS, OpenClaw tool, or `codex_workers` calls inside this package.
- No `codex_workers_run_task` call inside this package.
- No code-writing CAS jobs outside explicitly scoped package work.
- No production federation bridge mutation.
- No OpenClaw core changes.
- No deploy/push/publish/restart.

## Phase 2 implementation status

Job S added the strict injectable dispatch boundary. The existing plan facade still records `cas_runner_plan` intent; the new adapter can only cross the boundary when `enable_real_dispatch` is true, the unified policy decision is `allow-once`, workspace and repo scope are explicit, write-capable jobs have at least `ask_before_write`, prohibited actions are forbidden, and push/publish/deploy/restart are not allowed.
