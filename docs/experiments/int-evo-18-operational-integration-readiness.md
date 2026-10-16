# INT-EVO-18 — operational AAS integration readiness

## Current flow and authority boundary

`CPSContext.plugCPS` creates a client-side `plugEventId` and POSTs the registered
asset to `/api/acsm/plug`. The current `plugPostHandler` creates a legacy
PENDING_APPROVAL profile, changes the in-memory Plug snapshot and returns it to
the frontend. That HTTP success and the visual `plug` state are backend-logical
acceptance only; neither proves physical confirmation by the CPS.

The future authoritative path is already modeled by
`AcceptedCycleAasComposition.acceptPlug`: backend resolution through an
allowlisted verifiable AAS source, transactional cycle/profile reservation,
persisted lifecycle evidence, cycle activation, immutable AAS reference,
Evolution after acceptance, then `evolutionCycleQuery` projection.

## Additive Plug response contract

The existing operational response remains intact and may receive:

```json
{
  "aasIntegration": {
    "schemaVersion": "operational-aas-integration/1.0.0",
    "status": "CORRELATED",
    "binding": {
      "cpsId": "...",
      "plugEventId": "...",
      "plugCycleId": "...",
      "profileId": "...",
      "referenceId": "...",
      "aasId": "...",
      "assetId": "...",
      "contentHash": "...",
      "sourceId": "...",
      "sourceType": "AUTHORIZED_...",
      "version": null,
      "revision": null
    },
    "projection": "evolutionCycleQuery response"
  }
}
```

Frontend AAS metadata is never accepted as identity evidence. Experimental
source types are rejected. The PENDING_APPROVAL profile must belong to the exact
cycle and no approval is inherited.

## Read-only card query

The request is exactly `{ cpsId, plugCycleId }`; neither latest-by-CPS nor
timestamp inference is permitted. The response wraps the existing
`evolutionCycleQuery` result and preserves `CORRELATED`, `UNBOUND`, `UNAVAILABLE`,
`CONFLICT`, and `EVOLUTION_NOT_PROCESSED`. Query providers are reads only and do
not execute Plug, Evolution, archive writes or Store mutations.

## Future attachment points (not implemented)

- Backend: inside the Plug POST branch, replace the legacy writer sequence only
  after B6.3 authorization. The attachment point is after trusted lifecycle
  evidence has activated the transactional cycle and before the final JSON
  response. Build the additive envelope from the returned accepted composition;
  do not run it beside the legacy writers.
- Frontend: after `CPSContext.plugCPS` validates the POST response, retain only
  `aasIntegration.binding.cpsId` and `.plugCycleId` as the exact query key. Pass
  the returned/read-only projection to the existing card. Do not infer from the
  registry, current timestamp or current operating mode.

## B6.3 blockers

1. Select one transactional cycle authority and remove competing writers.
2. Migrate and reconcile pre-existing cycles/profiles and incomplete identities.
3. Coordinate all Plug, approval, Play and Unplug writers under revision/CAS.
4. Guarantee post-commit outbox publication, retry and idempotency.
5. Establish trusted lifecycle evidence and explicitly define physical versus
   backend-logical confirmation.
6. Keep experimental human governance separate from physical command authority.
7. Define authenticated principals and authorization policy before physical use.

Until those items have evidence, the integration is a tested contract only and
must not be described as operationally completed.
