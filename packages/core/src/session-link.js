import { createHash } from "node:crypto";
import {
  formatCompactMeshV1Envelope,
  parseMeshV1Envelope,
  planMeshV1Dispatch,
} from "./policy.js";

const STATE_SCHEMA = "agent-mesh.session-link.v1";
const SIDES = ["left", "right"];
const MAX_TURN_EVENTS = 120;
const MAX_EVENT_BODY = 1600;
const MAX_POLICY_RECORDS = 512;

export function normalizeSessionLinkConfig(raw = {}) {
  const mode = String(raw.mode || "").trim();
  if (!new Set(["unidirectional", "bidirectional"]).has(mode)) {
    throw new Error("session link mode must be unidirectional or bidirectional");
  }

  const direction = mode === "unidirectional" ? String(raw.direction || "").trim() : "both";
  if (mode === "unidirectional" && !new Set(["left-to-right", "right-to-left"]).has(direction)) {
    throw new Error("unidirectional links require left-to-right or right-to-left direction");
  }

  return {
    mode,
    direction,
    left: normalizeParticipant(raw.left, "left"),
    right: normalizeParticipant(raw.right, "right"),
  };
}

export function createSessionLinkState(rawConfig = {}) {
  const config = normalizeSessionLinkConfig(rawConfig);
  const fingerprint = hash(JSON.stringify(config));
  return {
    schema: STATE_SCHEMA,
    config,
    configFingerprint: fingerprint,
    linkPrefix: `sl-${fingerprint.slice(0, 12)}-`,
    queues: { left: [], right: [] },
    policy: { left: { records: {} }, right: { records: {} } },
    outbox: [],
  };
}

export function assertSessionLinkState(rawState, rawConfig) {
  const config = normalizeSessionLinkConfig(rawConfig);
  if (!rawState || rawState.schema !== STATE_SCHEMA) {
    throw new Error(`session link state must use schema ${STATE_SCHEMA}`);
  }
  const fingerprint = hash(JSON.stringify(config));
  if (rawState.configFingerprint !== fingerprint) {
    throw new Error("session link state belongs to different endpoints or mode");
  }
  return rawState;
}

export function processSessionLinkEvents(rawState, side, rawEvents = []) {
  if (!SIDES.includes(side)) throw new Error(`unknown session link side: ${side}`);
  const state = structuredClone(rawState);
  const activity = [];
  ensureStateShape(state);

  for (const rawEvent of rawEvents) {
      const event = normalizeEvent(rawEvent);
    if (!event) continue;

    if (event.kind === "human_message") {
      const envelope = parseMeshV1Envelope(event.body);
      const ownRelay = envelope.valid && envelope.meshId.startsWith(state.linkPrefix);
      const knownRelay = ownRelay && isKnownInbound(state, side, envelope);
      const addressedHere = ownRelay
        && knownRelay
        && envelope.turn === state.config[side].name
        && envelope.to.includes(state.config[side].name);
      const origin = addressedHere ? "relay" : (envelope.valid ? "foreign_mesh" : "human");
      state.queues[side].push({
        origin,
        inbound: addressedHere ? compactInbound(envelope) : undefined,
        events: [event],
        droppedEvents: 0,
      });
      activity.push({ side, reason: `${origin}_turn_started` });
      continue;
    }

    if (event.kind === "turn_complete") {
      const turn = state.queues[side].shift();
      if (!turn) {
        activity.push({ side, reason: "turn_complete_without_start" });
        continue;
      }
      const routed = routeCompletedTurn(state, side, turn, event);
      activity.push(...routed);
      continue;
    }

    const current = state.queues[side][0];
    if (!current) continue;
    if (current.events.length < MAX_TURN_EVENTS) current.events.push(event);
    else current.droppedEvents += 1;
  }

  for (const policyState of Object.values(state.policy)) prunePolicyRecords(policyState);

  return { state, activity };
}

export function markSessionLinkDeliveryDispatching(rawState, deliveryId) {
  return updateDelivery(rawState, deliveryId, (delivery) => ({
    ...delivery,
    status: "dispatching",
    attempts: Number(delivery.attempts || 0) + 1,
    lastError: undefined,
  }));
}

export function markSessionLinkDeliveryUncertain(rawState, deliveryId, error) {
  return updateDelivery(rawState, deliveryId, (delivery) => ({
    ...delivery,
    status: "uncertain",
    lastError: clipped(error, 500),
  }));
}

export function retrySessionLinkDelivery(rawState, deliveryId) {
  return updateDelivery(rawState, deliveryId, (delivery) => ({
    ...delivery,
    status: "pending",
    lastError: undefined,
  }));
}

export function acknowledgeSessionLinkDelivery(rawState, deliveryId) {
  const state = structuredClone(rawState);
  const before = state.outbox.length;
  state.outbox = state.outbox.filter((delivery) => delivery.id !== deliveryId);
  if (state.outbox.length === before) throw new Error(`unknown session link delivery: ${deliveryId}`);
  return state;
}

function routeCompletedTurn(state, side, turn, completionEvent) {
  const targetSide = otherSide(side);
  const source = state.config[side];
  const target = state.config[targetSide];
  let meshId;
  let seen;
  let hopLimit;

  if (turn.origin === "human") {
    if (!directionAllows(state.config, side)) {
      return [{ side, reason: "direction_not_enabled" }];
    }
    meshId = `${state.linkPrefix}${hash(`${side}:${turn.events[0]?.source_event_id || completionEvent.source_event_id}`).slice(0, 16)}`;
    seen = [];
    hopLimit = state.config.mode === "bidirectional" ? 2 : 1;
  } else if (turn.origin === "relay") {
    hopLimit = Number.isInteger(turn.inbound?.hopLimit) ? turn.inbound.hopLimit - 1 : 0;
    if (hopLimit <= 0) {
      return [{ side, reason: "hop_limit_exhausted", meshId: turn.inbound?.meshId }];
    }
    meshId = turn.inbound.meshId;
    seen = unique([...(turn.inbound.seen || []), source.name]);
  } else {
    return [{ side, reason: "foreign_mesh_not_relayed" }];
  }

  const parts = turn.events
    .filter((event) => !(turn.origin === "relay" && event.kind === "human_message"))
    .map((event) => ({ event, body: formatTurnEvent(event) }))
    .filter((part) => part.body);
  if (turn.droppedEvents > 0) {
    parts.push({
      event: { source_event_id: `${completionEvent.source_event_id}:omitted` },
      body: `[relay] ${turn.droppedEvents} additional events omitted`,
    });
  }

  let policyState = state.policy[targetSide];
  for (const [index, part] of parts.entries()) {
    const envelope = formatCompactMeshV1Envelope({
      from: source.name,
      meshId,
      turn: target.name,
      final: false,
      seen,
      hopLimit,
      body: part.body,
    });
    const plan = planMeshV1Dispatch(
      { localParticipant: target.name },
      {
        messageId: part.event.source_event_id || `${meshId}:part:${index}`,
        text: envelope,
        state: policyState,
      },
    );
    policyState = plan.stateTransition || policyState;
  }

  const finalEnvelope = formatCompactMeshV1Envelope({
    from: source.name,
    meshId,
    turn: target.name,
    final: true,
    seen,
    hopLimit,
    body: "",
  });
  const plan = planMeshV1Dispatch(
    { localParticipant: target.name },
    {
      messageId: completionEvent.source_event_id || `${meshId}:complete`,
      text: finalEnvelope,
      state: policyState,
    },
  );
  state.policy[targetSide] = plan.stateTransition || policyState;

  if (plan.nextAction !== "dispatch_once") {
    return [{ side, targetSide, meshId, reason: plan.reason }];
  }

  const body = [
    `Connected-session turn from ${source.name}. The user explicitly enabled this bounded link.`,
    "Read the context, think about it, and respond normally in this session. Do not forward it manually.",
    "",
    plan.dispatchText || "[relay] Source turn completed without readable content.",
  ].join("\n");
  const prompt = formatCompactMeshV1Envelope({
    from: source.name,
    meshId,
    turn: target.name,
    final: true,
    seen,
    hopLimit,
    body,
  });
  const delivery = {
    id: `${meshId}:${source.name}:${target.name}`,
    meshId,
    sourceSide: side,
    targetSide,
    prompt,
    status: "pending",
    attempts: 0,
  };
  if (!state.outbox.some((item) => item.id === delivery.id)) state.outbox.push(delivery);
  return [{ side, targetSide, meshId, reason: "delivery_queued", deliveryId: delivery.id }];
}

function normalizeParticipant(raw, side) {
  const name = String(raw?.name || side).trim();
  const agent = String(raw?.agent || "").trim();
  const sessionId = String(raw?.sessionId || "").trim();
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`${side} participant name contains unsafe characters`);
  if (!agent) throw new Error(`${side} agent is required`);
  if (!sessionId) throw new Error(`${side} session id is required`);
  return { name, agent, sessionId };
}

function normalizeEvent(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  const kind = String(raw.kind || "").trim();
  if (!new Set(["human_message", "agent_message", "reasoning", "tool", "turn_complete", "context"]).has(kind)) {
    return undefined;
  }
  return {
    timestamp: raw.timestamp || null,
    agent: String(raw.agent || "unknown"),
    session_id: String(raw.session_id || ""),
    kind,
    body: clipped(raw.body, MAX_EVENT_BODY),
    phase: raw.phase ? String(raw.phase) : undefined,
    tool_name: raw.tool_name ? String(raw.tool_name) : undefined,
    source_event_id: String(raw.source_event_id || hash(JSON.stringify(raw))),
  };
}

function compactInbound(envelope) {
  return {
    meshId: envelope.meshId,
    from: envelope.from,
    seen: [...envelope.seen],
    hopLimit: envelope.hopLimit,
  };
}

function isKnownInbound(state, side, envelope) {
  const recordKey = `${envelope.meshId}::${envelope.from}::${state.config[side].name}`;
  return state.policy[side]?.records?.[recordKey]?.dispatched === true;
}

function formatTurnEvent(event) {
  const labels = {
    human_message: "human",
    agent_message: `${event.agent}${event.phase ? `/${event.phase}` : ""}`,
    reasoning: `${event.agent}/reasoning`,
    tool: `tool:${event.tool_name || "unknown"}`,
    context: `${event.agent}/context`,
  };
  const label = labels[event.kind];
  return label && event.body ? `[${label}] ${event.body}` : "";
}

function directionAllows(config, side) {
  if (config.mode === "bidirectional") return true;
  return config.direction === `${side}-to-${otherSide(side)}`;
}

function otherSide(side) {
  return side === "left" ? "right" : "left";
}

function ensureStateShape(state) {
  state.queues ||= { left: [], right: [] };
  state.policy ||= { left: { records: {} }, right: { records: {} } };
  state.outbox ||= [];
  for (const side of SIDES) {
    state.queues[side] ||= [];
    state.policy[side] ||= { records: {} };
  }
}

function prunePolicyRecords(policyState) {
  const entries = Object.entries(policyState.records || {});
  if (entries.length <= MAX_POLICY_RECORDS) return;
  policyState.records = Object.fromEntries(entries.slice(-MAX_POLICY_RECORDS));
}

function updateDelivery(rawState, deliveryId, update) {
  const state = structuredClone(rawState);
  const index = state.outbox.findIndex((delivery) => delivery.id === deliveryId);
  if (index < 0) throw new Error(`unknown session link delivery: ${deliveryId}`);
  state.outbox[index] = update(state.outbox[index]);
  return state;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function clipped(value, limit) {
  const text = String(value || "").trim();
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[…truncated]`;
}
