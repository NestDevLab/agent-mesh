# Private maintenance admission and drain

The MCP gateway binds `<stateDir>/maintenance-admission.sock` before opening HTTP ingress. The Unix socket has mode `0600`; no HTTP management route or public MCP administration tool is exposed. Failure to validate the marker or acquire the control socket prevents HTTP startup. A live socket, symlink, or non-socket path is never replaced. A stale socket is removed only following `ECONNREFUSED` and an unchanged device/inode check.

Send newline-delimited JSON, with a UUID owner generated once per maintenance window:

```json
{"operation":"pause","owner":"00000000-0000-4000-8000-000000000001"}
{"operation":"status","owner":"00000000-0000-4000-8000-000000000001"}
{"operation":"resume","owner":"00000000-0000-4000-8000-000000000001"}
```

Each command receives one JSON line. Successful responses have this shape:

```json
{"ok":true,"protocol":"agent-mesh.admission.v1","paused":true,"owner":"00000000-0000-4000-8000-000000000001","pid":1234,"inflightRequests":0,"nonterminalTasks":0}
```

The owner is `null` when no maintenance marker is held. Errors return `ok:false`, `protocol`, and `error`; do not interpret an error, timeout, missing socket, or malformed response as permission to continue maintenance. Close the control connection after reading the reply. Commands are serialized across all connections. Invalid commands and ownership mismatches cannot acquire or release another owner's window.

`pause` closes admission synchronously before acknowledging or attempting persistence. It writes `<stateDir>/maintenance-admission.json` with exactly `protocol` and `owner`, using an exclusive temporary file, fsync, atomic rename, and directory fsync. The marker has mode `0600`; malformed, unsafe-permission, and symlink markers fail closed. Persistence failure leaves in-memory admission closed and returns an error. The same owner can retry pause. The marker survives process restart; only a matching owner can resume and remove it. A failed persistence operation requires inspection before proceeding.

The gate covers every HTTP request before route lookup, authentication, body parsing, or MCP dispatch, including every hub profile. While paused, new requests receive HTTP 503. Already-admitted requests and their pending executions finish normally. The socket remains available independently of the HTTP gate.

`inflightRequests` counts all HTTP requests (including rejected 503 responses) until both execution settles and the response emits `finish` or `close`, including pending request execution even if the client disconnects. `nonterminalTasks` counts the union of nonterminal durable task records and coordinator-active task IDs. A cancelled task whose executor is still running therefore prevents drain. Existing persisted tasks resume at startup, including while admission is paused, so their work can finish.

An installer must verify the protocol, expected gateway PID, matching owner, and `paused:true`, and wait for **both counts to reach zero** before stopping or replacing the gateway. Recheck after restart before resuming with the same owner. The installer must keep its maintenance lease throughout the window; it must not fall back to direct runtime mutation if control is missing or fails. The private state directory and its parents must remain under the gateway operator's control.
