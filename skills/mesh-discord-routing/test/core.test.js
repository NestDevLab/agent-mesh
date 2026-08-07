import assert from "node:assert/strict";
import test from "node:test";
import { hydrateCcMeshMessage, matchesLocalParticipant, parseCcMeshRecipients } from "../src/core.js";

const participants = {
  facilitator: {
    discordUserId: "111111111111111111",
    aliases: ["host"]
  },
  reviewer: {
    discordUserId: "222222222222222222",
    aliases: ["review"]
  }
};

test("parses cc-mesh recipients", () => {
  assert.deepEqual(parseCcMeshRecipients("cc-mesh: host, reviewer\nhello"), ["host", "reviewer"]);
});

test("hydrates cc-mesh labels into mentions", () => {
  assert.equal(
    hydrateCcMeshMessage("cc-mesh: host,reviewer\nCan you review?", participants),
    "cc-mesh: facilitator,reviewer\n<@111111111111111111> <@222222222222222222> Can you review?"
  );
});

test("refuses to silently hydrate unknown recipient labels", () => {
  assert.throws(
    () => hydrateCcMeshMessage("cc-mesh: missing\nCan you review?", participants),
    (err) => err.code === "UNKNOWN_RECIPIENTS" && err.unknown.includes("missing")
  );
});

test("matches local participant aliases", () => {
  assert.equal(matchesLocalParticipant("cc-mesh: host\nhello", ["facilitator"], participants), true);
  assert.equal(matchesLocalParticipant("cc-mesh: reviewer\nhello", ["facilitator"], participants), false);
});
