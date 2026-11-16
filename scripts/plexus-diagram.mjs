// Update this diagram together with the public architecture when it changes.
export const plexusDiagram = `flowchart LR
  Client["Client or waker"] -- "channel mode" --> Channel["Stable channel"]
  Channel --> Queue["Channel queue"]
  Channel --> Session["Current session"]
  Queue --> Journal["Graph event journal"]
  Session --> Journal
  Module["Registered module"] --> Contract["Versioned JSON contract"]
  Contract --> Journal
  Queue -- "bound receipt" --> Session
  Restart["Restart state contract"] -. "planned validation" .-> Handover
  Handover["Handover"] -. "planned verified cutover" .-> Channel
`;
