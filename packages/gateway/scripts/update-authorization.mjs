import { readFileSync } from "node:fs";
import { AuthorizationJournal } from "../dist/mcp/authorization-journal.js";

// Offline operator tool. Input is a complete policy plus the observed revision;
// never pass bearer assertions on the command line or in the policy document.
const [path] = process.argv.slice(2);
if (!path || process.argv.length !== 3) throw new Error("Usage: update-authorization.mjs JOURNAL < UPDATE.json");
const { expectedRevision, policy, revokeAssertionDigests = [] } = JSON.parse(readFileSync(0, "utf8"));
const revision = await new AuthorizationJournal(path).replace(expectedRevision, policy, revokeAssertionDigests);
process.stdout.write(`${JSON.stringify({ revision })}\n`);
