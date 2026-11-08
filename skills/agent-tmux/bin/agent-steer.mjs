#!/usr/bin/env node
import { parseArgs } from "node:util";
import { withCodexAppServer } from "./codex-app-server.mjs";

const NO_ACTIVE_TURN = 3;

try {
  const { values, positionals } = parseArgs({
    options: {
      agent: { type: "string" },
      message: { type: "string" },
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  if (!["codex", "claude"].includes(values.agent)) throw new Error("--agent must be codex or claude");
  if (values.agent === "claude") throw new Error("steer is unsupported for claude; no API injects into a running turn");
  const [sessionId] = positionals;
  if (positionals.length !== 1) throw new Error("expected steer <SESSION_ID> --message TEXT");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) {
    throw new Error("SESSION_ID must be a complete UUID");
  }
  if (!values.message?.trim()) throw new Error("steer requires --message TEXT");
  const timeout = Number(process.env.AGENT_STEER_TIMEOUT_MS || 30000);
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 600000) {
    throw new Error("AGENT_STEER_TIMEOUT_MS must be an integer from 1 to 600000");
  }
  const result = await steerCodex(sessionId, values.message, timeout);
  console.log(values.json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`agent-steer: ${error.message}`);
  process.exitCode = error.exitCode || 1;
}

async function steerCodex(threadId, text, timeout) {
  return withCodexAppServer({
    clientName: "agent-mesh-steer",
    timeout,
    timeoutMessage: "app-server steer call timed out; outcome unknown; inspect before retrying",
  }, async (request) => {
    const { data } = await request("thread/turns/list", { threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded" });
    const [turn] = data;
    if (turn?.status !== "inProgress") {
      throw Object.assign(new Error(`thread ${threadId} has no active turn; nothing was sent, use codex queue`), { exitCode: NO_ACTIVE_TURN });
    }
    const { turnId } = await request("turn/steer", {
      threadId,
      input: [{ type: "text", text, text_elements: [] }],
      expectedTurnId: turn.id,
    });
    return { agent: "codex", sessionId: threadId, status: "steered", turnId };
  });
}
