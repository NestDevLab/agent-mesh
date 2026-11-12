import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ledgerView, ledgerViewRows, renderLedgerView } from "../bin/plexus.mjs";
import { ledgerViewValue, validateLedgerViewProfile } from "../bin/ledger-view.mjs";

const session = { session: "codex:11111111-1111-4111-8111-111111111111", nativeId: "11111111-1111-4111-8111-111111111111", harness: "codex", role: "owns", status: "active", title: "Example" };
const item = (id, fields = {}, extra = {}) => ({ ref: `work:${id}`, title: `Item ${id}`, state: "open", status: "open",
  updatedAt: "2030-01-01T00:00:00Z", sourceRevision: "sha256:" + "a".repeat(64),
  fields: { id, ...fields }, sessions: [], groups: [], ...extra });
const profile = { schema: "plexus.ledger-view-config/v1", waiting: { field: "fields.wait", values: [true] },
  ranks: { priority: { first: 0, second: 1 }, size: { small: 0, large: 1 } },
  projectAliases: { example: "p" }, projects: { p: { name: "Example", chan: "project_example", director: { cmsg: "thread_director" } } } };
const refs = result => result.items.map(row => row.ref);

test("view default sort prioritizes waiting, then due, priority and size with undated last", () => {
  const items = [
    item("c", { wait: false, due: "2030-01-01", priority: "first", size: "small" }),
    item("b", { wait: true, priority: "first", size: "small" }),
    item("a", { wait: true, due: "2030-02-01", priority: "first", size: "small" }),
    item("e", { wait: false, due: "2030-01-01", priority: "second", size: "small" }),
    item("d", { wait: false, due: "2030-01-01", priority: "first", size: "large" })
  ];
  const result = ledgerViewRows({ items }, {}, profile);
  assert.equal(result.schema, "plexus.ledger-view/v1");
  assert.deepEqual(result.sort, ["waitingOnOwner:desc", "due:asc", "priority:asc", "size:asc"]);
  assert.deepEqual(refs(result), ["work:a", "work:b", "work:c", "work:d", "work:e"]);
  assert.deepEqual(ledgerViewRows({ items }, {}, profile), result);
  assert.deepEqual(refs(ledgerViewRows({ items: items.toReversed() }, {}, profile)), refs(result));
  assert.ok(result.items.every(row => !Object.hasOwn(row, "sortKeys")));
});

test("view filters nested session/group paths and arbitrary raw fields using existing operators", () => {
  const items = [item("a", { wait: true, custom: "x".repeat(6000), blank: "", unknown: null }, { sessions: [session], groups: ["group:example"] }),item("b")];
  const filtered = ledgerViewRows({ items }, { filter: { "sessions.role": "owns", "fields.custom": { contains: "xxx" } }, sort: "owners:asc" }, profile);
  assert.deepEqual(refs(filtered), ["work:a"]);
  assert.equal(filtered.items[0].fields.custom.length, 6000);
  assert.equal(filtered.items[0].fields.blank, "");
  assert.equal(filtered.items[0].fields.unknown, null);
  assert.deepEqual(filtered.items[0].owners, [session.session]);
  assert.deepEqual(refs(ledgerViewRows({ items }, { filter: { owners: { exists: false } } }, profile)), ["work:b"]);
  assert.deepEqual(refs(ledgerViewRows({ items }, { filter: { "groups.ref": { in: ["group:example"] } } }, profile)), ["work:a"]);
});

test("historical project fallback is distinct from the default Director thread", () => {
  const items = [item("a", { project: "example" }, { sessions: [session] })];
  const current = ledgerViewRows({ items }, {}, profile).items[0];
  assert.deepEqual(current.thread, { chan: "project_example", cmsg: "thread_director",
    url: "https://claude.ai/code/project/project_example?thread=thread_director", resolution: "director",
    missingReason: "native-only", fallbackReason: null });
  const historical = ledgerViewRows({ items }, { fallback: "project" }, profile).items[0];
  assert.equal(historical.thread.resolution, "project");
  assert.equal(historical.thread.cmsg, null);
  assert.equal(historical.thread.url, "https://claude.ai/code/project/project_example");
  assert.equal(historical.thread.missingReason, "native-only");
});

test("explicit item and stable session mappings precede fallback without transcript access", () => {
  const configured = { ...profile, itemThreads: { "work:a": { chan: "project_example", cmsg: "thread_item" } },
    sessionThreads: { [session.session]: { chan: "project_example", cmsg: "thread_session" } } };
  const result = ledgerViewRows({ items: [item("a", {}, { sessions: [session] }),item("b", {}, { sessions: [session] })] }, {}, configured);
  assert.equal(result.items[0].thread.resolution, "item");
  assert.equal(result.items[0].thread.cmsg, "thread_item");
  assert.equal(result.items[1].thread.resolution, "session");
  assert.equal(result.items[1].thread.cmsg, "thread_session");
  assert.equal(result.items[0].thread.missingReason, null);
});

test("missing data is explicit and source group lead stays separate from session ownership", () => {
  const groups = [
    { group_id: "one", source_ref: "group:one", name: "One", role_key: "example", ledger_links: [{ ref: "work:a", lead: true }] },
    { group_id: "two", source_ref: "group:two", name: "Two", role_key: null, ledger_links: [{ ref: "work:a", lead: false }] }
  ];
  const result = ledgerViewRows({ items: [item("a"),item("b")], groupMetadata: groups }, {}, profile);
  const a = result.items.find(row => row.id === "a"),b = result.items.find(row => row.id === "b");
  assert.equal(a.groups.length, 2);
  assert.equal(a.leadGroupRef, "group:one");
  assert.deepEqual(a.owners, []);
  assert.equal(b.due, null);
  assert.equal(b.priority, null);
  assert.equal(b.thread.chan, null);
  assert.equal(b.thread.missingReason, "unassigned");
  assert.equal(b.thread.fallbackReason, "project-unmapped");
  assert.equal(result.groups_revision, null);
  groups[1].ledger_links[0].lead = true;
  assert.throws(() => ledgerViewRows({ items: [item("a")], groupMetadata: groups }, {}, profile), /Multiple lead/);
});

test("view rejects scope, malformed query and profile before requesting ledger data", () => {
  let reads = 0;
  const graph = { nodes: [], links: [], lastSeq: 0 },read = () => { reads++;return { items: [], errors: [] }; };
  assert.throws(() => ledgerView(graph, {}, {}, read, profile), /local callers/);
  for (const input of [{ sort: ["bad key"] },{ filter: { due: { invalid: 1 } } },{ limit: 0 }]) {
    assert.throws(() => ledgerView(graph, input, null, read, profile));
  }
  assert.throws(() => ledgerView(graph, {}, null, read, { schema: "unknown" }));
  assert.equal(reads, 0);
  assert.throws(() => ledgerViewValue({}, "__proto__.value"), /Unsafe/);
  assert.throws(() => validateLedgerViewProfile({ ranks: { priority: { first: true } } }), /ranks/);
});

test("Markdown uses the same versioned data and rejects a mismatched profile", () => {
  const result = ledgerViewRows({ items: [item("a", { project: "example", custom: "extra" })] }, {}, profile);
  const md = renderLedgerView(result, profile);
  assert.match(md, /https:\/\/claude.ai\/code\/project\/project_example\?thread=thread_director/);
  assert.match(md, /No thread \(unassigned\)/);
  assert.throws(() => renderLedgerView(result, {}), /revision mismatch/);
  const config = { ...profile, markdown: { title: "Example", rowTemplate: "{number}. {id} · {title} · {thread}" } };
  const escaped = ledgerViewRows({ items: [item("a", {}, { title: "**literal**" })] }, {}, config);
  assert.match(renderLedgerView(escaped, config), /\\\*\\\*literal\\\*\\\*/);
});

test("the published JSON schema requires explicit fields in each normalized row", async () => {
  const schema = JSON.parse(await readFile(new URL("../schemas/plexus-ledger-view-v1.schema.json", import.meta.url), "utf8"));
  const result = ledgerViewRows({ items: [item("a")] }, {}, profile);
  assert.equal(schema.properties.schema.const, result.schema);
  for (const key of schema.required) assert.ok(Object.hasOwn(result, key), key);
  for (const key of schema.$defs.item.required) assert.ok(Object.hasOwn(result.items[0], key), key);
  for (const key of schema.$defs.thread.required) assert.ok(Object.hasOwn(result.items[0].thread, key), key);
});
