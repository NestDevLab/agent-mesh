// Update this diagram together with the public architecture when it changes.
export const plexusDiagram = `flowchart LR
  Client["Client or waker"] -- "channel mode" --> Channel["Stable channel"]
  Channel --> Queue["Channel queue"]
  Channel --> Session["Current session"]
  Queue --> Journal["Graph event journal"]
  Session --> Journal
  Wake["Codex queued wake evidence"] --> Journal
  Wake -. "planned waker integration" .-> Queue
  Compaction["Codex compaction evidence"] --> Journal
  Module["Registered module"] --> Contract["Versioned JSON contract"]
  Contract --> Journal
  Queue -- "bound receipt" --> Session
  CloudAccount["Cloud account binding"] -. "planned routing" .-> Queue
  Yaml["Bounded YAML decoder"] --> Restart
  Restart["Restart state contract"] --> StatePrep["Reserved state preparation"]
  Restart --> RoleProfile["Role-scoped launch plan"]
  RoleProfile -. "synthetic rehearsal" .-> Rehearsal["In-memory handover rehearsal"]
  RoleProfile -. "isolated assessment" .-> IsolatedRollback["Owned isolated rollback"]
  IsolatedRollback -. "live handover blocked" .-> Handover
  RoleProfile -. "planned runtime launch" .-> Handover
  StatePrep --> Journal
  StatePrep --> Revalidate["Restart state revalidation"]
  Revalidate -. "planned lifecycle exclusion" .-> Handover
  TriggerTxn["Trigger transaction engine"] --> TriggerJournal["Private trigger journal"]
  TriggerRecovery["Explicit uncertain recovery"] --> TriggerJournal
  TriggerTxn -. "planned scheduler adapters" .-> Handover
  Notice["Successor notice formatter"] -. "planned publication" .-> Handover
  Observation["Codex notice snapshot"] -. "planned finality check" .-> Handover
  Handover["Handover"] -. "planned verified cutover" .-> Channel
  Channel -. "pure switch model" .-> Drain["Observe queued deliveries"]
  Drain -. "then reserve" .-> Notice
  AutoWake["Auto-wake observation disabled"] -. "consumption unproven" .-> Wake
  Wake -. "bound native proof" .-> Drain
  ClaudeReadback["Local Claude transcript observer"] -. "observed inbox record" .-> Drain
`;
