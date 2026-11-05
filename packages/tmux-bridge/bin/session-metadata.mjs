#!/usr/bin/env node
/** Join native session enumeration to the local catalog; never expose the graph. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sessionMetadata } from './session-catalog.mjs';
let body = '';
for await (const chunk of process.stdin) body += chunk;
const payload = JSON.parse(body);
payload.discovery_truncated = Number(process.argv[3]) > 0 && payload.sessions.length >= Number(process.argv[3]);
const args = [fileURLToPath(new URL('./mesh-graph.mjs', import.meta.url)), 'catalog', 'list', '--archive', 'include'];
if (process.env.MESH_GRAPH_STATE) args.push('--state', process.env.MESH_GRAPH_STATE);
const result = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 10_000 });
let catalog = [];
if (result.status === 0) catalog = JSON.parse(result.stdout).sessions;
const byId = new Map(catalog.map(row => [row.sessionId, row]));
// Sweep/discovery also indexes native archived and DB-only sessions. Join those
// identities locally so moving a transcript out of the active tree cannot hide it.
{
  const seen = new Set(payload.sessions.map(row => row.session_id));
  for (const row of catalog) {
    const [agent, id] = row.sessionId.split(':');
    if (agent === payload.agent_type && (!process.argv[2] || id === process.argv[2]) &&
        !seen.has(id) && row.cwd && row.last_activity_at) {
      payload.sessions.push({ session_id: id, agent_type: agent, cwd: row.cwd, updated_at: row.last_activity_at });
      seen.add(id);
    }
  }
}
payload.sessions = payload.sessions.map(session => {
  const metadata = byId.get(`${payload.agent_type}:${session.session_id}`);
  const { title, title_source, summary, summary_source, summary_freshness, summary_updated_at, last_activity_at, archived, archive_source } = metadata || sessionMetadata({});
  return { ...session, title, title_source, summary, summary_source, summary_freshness, summary_updated_at,
    last_activity_at, archived, archive_source };
});
payload.sessions.sort((a,b) => b.updated_at.localeCompare(a.updated_at) || a.session_id.localeCompare(b.session_id));
payload.metadata_available = result.status === 0;
process.stdout.write(JSON.stringify(payload) + '\n');
