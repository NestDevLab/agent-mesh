import assert from "node:assert/strict";
import test from "node:test";

import "./ts-extension-resolver.mjs";

const { summarizeDeliveryLifecycle } = await import("../src/core/delivery-lifecycle.ts");

test("surfaces invalid transition audit coverage for a broken lifecycle", () => {
  const summary = summarizeDeliveryLifecycle({
    message_id: "msg-broken",
    idempotencyKey: "idem-broken",
    idempotencyRecords: [{ key: "idem-broken", input_hash: "hash-broken", created_at: "2026-05-13T17:35:00.000Z" }],
    deliveries: [
      {
        id: "d-broken",
        message_id: "msg-broken",
        adapter_id: "simulated-agent",
        target_agent_id: "agent.software_engineer",
        status: "dispatching",
        attempts: 1,
        max_attempts: 3,
        created_at: "2026-05-13T17:35:00.000Z",
        updated_at: "2026-05-13T17:35:01.000Z"
      }
    ],
    audits: [
      {
        id: "audit-invalid",
        type: "delivery.invalid_transition",
        created_at: "2026-05-13T17:35:01.000Z",
        message_id: "msg-broken",
        details: { attempted_status: "delivered" }
      }
    ]
  });

  assert.equal(summary.audit_coverage.invalid_transition, true);
  assert.ok(summary.issues.includes("adapter simulated-agent did not start at queued"));
  assert.ok(summary.issues.includes("missing delivery.queued audit event"));
  assert.ok(summary.issues.includes("missing delivery.updated audit event"));
});
