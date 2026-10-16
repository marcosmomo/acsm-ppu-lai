# INT-EVO-14 — AAS/Evolution card boundary

The existing **AAS Functional Capabilities** card is a read-only presentation.
Its default source is the hash-verified official CPS-LAI-01 document projection,
shown as `DOCUMENT_PREVIEW` and `DECLARED_ONLY`. This preview does not claim to
represent the current physical configuration and has no PPU-cycle binding.

A cycle view may be injected only as an already-produced
`evolutionCycleQuery` projection. The card does not search by CPS or timestamp,
does not select an AAS version, and does not call lifecycle, governance,
Evolution, PLC, OPC UA, MQTT, or database services. A complete correlated
identity (`cpsId`, `plugEventId`, `plugCycleId`, and `profileId`) plus the frozen,
validated AAS hash is required. Otherwise the cycle projection is rejected.

Experimental sources are labeled `EXPERIMENTAL PPU CYCLE — NOT OPERATIONAL
STATE`. Evolution is displayed only for a correlated cycle with an available
comparison; `EVOLUTION_NOT_PROCESSED`, unavailable, and conflict results do not
receive a BASELINE, NO_CHANGE, or CHANGED label from the card.

Existing governance controls and Play-gate rules are unchanged. The identifier
`human-operator` continues to represent an experimental human intervention
without proven individual authentication. Card presentation and Evolution
detection grant no authorization and cannot release physical operations.
