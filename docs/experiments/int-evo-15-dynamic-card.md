# INT-EVO-15 — supervised dynamic card demonstration

The Plug Phase contains one AAS Functional Capabilities card. A separate,
clearly labeled experimental control area can select pre-generated read-only
projections for that same card. Its default is the official `DOCUMENT_PREVIEW`.

The artifact `int-evo-15-card-projections.json` is generated offline by the
INT-EVO-8 `AcceptedCycleAasComposition`. Each accepted cycle resolves an
explicitly authorized experimental AAS, freezes event/cycle/profile/AAS
identity, runs Evolution only after acceptance, and is read through
`evolutionCycleQuery`. Runtime UI code imports only the sanitized artifact.

The scenarios preserve BASELINE history after Unplug, then demonstrate a
same-AAS NO_CHANGE replug and a functionally changed-AAS CHANGED replug. A
deliberately corrupted profile projection demonstrates fail-closed conflict.

No route is added. The controls use component-local state and do not read or
write CPSContext, operational governance profiles, governanceStore,
GovernanceRepository, EvolutionStore, Play-gate, MQTT, OPC UA, PLC or MySQL.
They do not call Plug, Play, Approve or Unplug and cannot authorize physical
execution. Human governance remains experimental and unauthenticated.
