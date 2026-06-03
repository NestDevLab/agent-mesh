import assert from "node:assert/strict";
import test from "node:test";

import "./ts-extension-resolver.mjs";

const { summarizeDeliveryLifecycle } = await import("../src/core/delivery-lifecycle.ts");

test("summarizes a healthy delivery lifecycle with audit and idempotency coverage", () => {
  const summary = summarizeDeliveryLifecycle({
    message_id: "msg-1",
    idempotencyKey: "idem-1",
    idempotencyRecords: [{ key: "idem-1", input_hash: "hash-1", created_at: "2026-05-13T17:35:00.000Z" }],
    deliveries: [
      delivery({ id: "d1", adapter_id: "simulated-agent", status: "queued", attempts: 0, updated_at: "2026-05-13T17:35:00.000Z" }),
      delivery({ id: "d1", adapter_id: "simulated-agent", status: "dispatching", attempts: 1, updated_at: "2026-05-13T17:35:01.000Z" }),
      delivery({ id: "d1", adapter_id: "simulated-agent", status: "stubbed", attempts: 1, updated_at: "2026-05-13T17:35:02.000Z" })
    ],
    audits: [
      audit("msg-1", "delivery.queued"),
      audit("msg-1", "delivery.updated")
    ],
    deadLetters: []
  });

  assert.deepEqual(summary.adapters, ["simulated-agent"]);
  assert.equal(summary.final_status_by_adapter["simulated-agent"], "stubbed");
  assert.equal(summary.audit_coverage.queued, true);
  assert.equal(summary.idempotency_present, true);
  assert.deepEqual(summary.issues, []);
});

test("flags missing dead-letter audit and missing idempotency coverage", () => {
  const summary = summarizeDeliveryLifecycle({
    message_id: "msg-2",
    deliveries: [
      delivery({ id: "d2", adapter_id: "discord-transcript-stub", status: "queued", attempts: 0, updated_at: "2026-05-13T17:35:00.000Z" }),
      delivery({ id: "d2", adapter_id: "discord-transcript-stub", status: "dispatching", attempts: 1, updated_at: "2026-05-13T17:35:01.000Z" }),
      delivery({ id: "d2", adapter_id: "discord-transcript-stub", status: "failed", attempts: 3, max_attempts: 3, updated_at: "2026-05-13T17:35:02.000Z" })
    ],
    audits: [audit("msg-2", "delivery.queued"), audit("msg-2", "delivery.updated")],
    deadLetters: [
      {
        id: "dead-1",
        source_file: "delivery-events.ndjson",
        reason: "max_attempts_exhausted",
        created_at: "2026-05-13T17:35:02.000Z",
        payload: { message_id: "msg-2" }
      }
    ]
  });

  assert.equal(summary.dead_letters, 1);
  assert.equal(summary.idempotency_present, false);
  assert.ok(summary.issues.includes("missing idempotency record"));
  assert.ok(summary.issues.includes("dead letters exist without delivery.dead_lettered audit coverage"));
});

function delivery(overrides = {}) {
  return {
    id: "d1",
    message_id: "msg-1",
    adapter_id: "simulated-agent",
    target_agent_id: "agent.software_engineer",
    status: "queued",
    attempts: 0,
    max_attempts: 3,
    created_at: "2026-05-13T17:35:00.000Z",
    updated_at: "2026-05-13T17:35:00.000Z",
    ...overrides
  };
}

function audit(messageId, type) {
  return {
    id: `audit-${messageId}-${type}`,
    type,
    created_at: "2026-05-13T17:35:00.000Z",
    message_id: messageId,
    details: {}
  };
}
