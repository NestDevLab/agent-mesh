import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, symlink, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import "./ts-extension-resolver.mjs";
const {providerCompanionFile}=await import("../src/mcp/workspace-sandbox.ts");
async function fixture(t) {
 const root=await mkdtemp(join(tmpdir(),"mesh-companion-"));t.after(()=>rm(root,{recursive:true,force:true}));
 const source=join(root,"codex-code-mode-host");await writeFile(source,"fixture executable",{mode:0o755});
 return {providerBinary:{name:"codex",source:join(root,"codex")},providerCompanion:{name:"codex-code-mode-host",source,sha256:createHash("sha256").update("fixture executable").digest("hex")}};
}
test("only explicit approved canonical executable sibling is mapped read-only",async t=>{const c=await fixture(t);assert.deepEqual(providerCompanionFile(c),{source:c.providerCompanion.source,target:"/opt/mesh-bin/codex-code-mode-host"});assert.equal(providerCompanionFile({}),undefined);});
for(const[name,mutate]of[
 ["hash mismatch",async c=>{c.providerCompanion.sha256="0".repeat(64)}],
 ["arbitrary name",async c=>{c.providerCompanion.name="other"}],
 ["foreign provider",async c=>{c.providerBinary.name="claude"}],
 ["nonexecutable",async c=>{await chmod(c.providerCompanion.source,0o600)}],
 ["writable executable",async c=>{await chmod(c.providerCompanion.source,0o777)}],
 ["symlink source",async c=>{const p=c.providerCompanion.source;await rm(p);await writeFile(p+"-target","fixture executable",{mode:0o755});await symlink(p+"-target",p)}],
 ["nonsibling",async c=>{c.providerBinary.source="/different/codex"}]
])test(`provider companion denies ${name}`,async t=>{const c=await fixture(t);await mutate(c);assert.throws(()=>providerCompanionFile(c));});
