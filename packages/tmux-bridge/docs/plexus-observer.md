# Scoped Plexus observers

The model-free `agent-plexus-observer.py` producer consumes the native Plexus
changes feed. The existing lifecycle beat can include it with `plexusObservers`.
The existing waker is the only sender: its transport, managed inbox, writer and
communications gates still apply. No timer, session launcher or supervisor is added.

```json
{
  "plexusObservers": {
    "destination": "codex:observer-session-id",
    "subscriptions": [
      {"id": "demo", "projects": ["demo"], "eventTypes": ["session.ended"]}
    ],
    "maxPages": 2,
    "pageSize": 100,
    "maxCatalogPages": 25
  }
}
```

The enclosing beat's `wakerState` supplies transport acknowledgements. State lives
in `beat-state/plexus-observer`. Optional `graphState` selects an existing native
graph; otherwise the native graph default applies. A standalone invocation uses
`--config FILE --state DIRECTORY` and includes `wakerState` in that config.

Each producer has one destination, which must match its existing waker recipient.
Subscriptions do not route to different actors. Separate existing observer jobs
can use separate namespaces; this module never creates them. Changing config
requires a new state namespace and an explicit decision about retained pending
reports. Never retarget an existing pending waker queue implicitly.

Selectors `refs`, `sessions`, `projects` and `eventTypes` are nonempty string
arrays when supplied. Multiple selectors combine with AND. A subscription with
no scope selector requires explicit `all: true`. Up to 16 subscriptions are
accepted. Destination session events are excluded to prevent feedback loops.
Session constraints require every session endpoint of an edge to match. Refs
filtering delegates to native changes, including link membership for session
updates. Project constraints use the authoritative catalog, not titles, paths or
inferred domains. Unknown membership and cross-project edges fail closed. A
system coverage-gap event reports the count of unclassified catalog sessions;
a bound/error in catalog enumeration stops that poll with a source error.
Catalog enumeration occurs only for project-constrained configurations.

The initial `changes({initial: "head"})` call establishes an exact quiet baseline
without scanning history. Changes after that boundary remain observable. Other
`initial` values and combining `initial` with `sinceCursor` are rejected. Later
cursors are opaque; the consumer never parses, compares or constructs them.
Each poll reads at most `maxPages` per subscription, default 2, maximum 20;
`pageSize` defaults to 100, maximum 200. The catalog page bound defaults to 25,
maximum 50, with 200 sessions per page. Work bounds limit pages/output; the native
file-backed feed may still replay its retained graph internally per query. The
quiet head reuses the existing native validated checkpoint; no consumer cache is
added. Before each query `maxEventBytes` checks the event log size (default 512 MiB,
maximum 8 GiB), and every subprocess has a 30 second timeout. Exceeding either
fails closed with a visible source error and preserves pending state/cursors.
This is a preflight size safeguard; concurrent appends can change the size during
the query. Incremental feed replay optimization is separate future work.

An immutable private report is written before atomic pending state. Pending owns
candidate cursors and event IDs; the acknowledged cursors remain unchanged until
all report item keys occur in `wakerState.lastDelivery`. Holds and restarts return
the exact same item and do not poll ahead or discard events. Feed errors before
staging preserve the previous cursor. A crash after report creation but before
state staging can leave an unreferenced report; it cannot advance the cursor.
State replacement fsyncs both the file and directory. Existing native follow
locking and atomic-write primitives are reused.

Reports are labeled `system-event`, observation-only, never human approval. The
compact item points to the full report; it includes no transcript content. Pending
means producer queue only. `lastTransportReceipt` proves native transport
acceptance only. `actorResponse: unverified` stays explicit until separate native
session evidence proves an actual response; this producer never infers one.

A native retention reset stages one `observer.reset` event and the feed's returned
baseline cursor. It reports missing history as unverified and resumes from that
boundary after transport acknowledgement. Stable event IDs suppress replay within
the last 10,000 acknowledged subscription/event pairs. Older replay after that
bounded dedup window can reappear. Unacknowledged reports are never evicted;
backpressure stops further feed polling. Immutable reports are delivery evidence;
the host owns their retention and must preserve referenced pending reports.

For an idle Codex observer, the existing waker supports explicit `--agent codex
--resume`; this forwards the native transport's supported resume option. The
default is unchanged. Claude resume is rejected. Resume remains behind the same
communications gate, and transport acceptance still does not prove actor response.
