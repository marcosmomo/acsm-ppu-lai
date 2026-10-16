# CPS-LAI-01 local persistence

The service owns only the `acsm_cpslai1` schema. MQTT ingestion and PPU-event
ingestion are independently disabled by default.

## PPU event topic

Historical PPU facts use `cpslai1/ppu/events` with QoS 1 and `retain=false`.
The current-state projection topic `acsm/cpslai1/lifecycle` is not consumed or
modified by this service.

Envelope version `1.0`:

```json
{
  "schemaVersion": "1.0",
  "eventId": "stable-id-for-this-fact",
  "correlationId": "shared-lifecycle-correlation",
  "commandId": null,
  "cpsId": "cpslai1",
  "operation": "PLAY",
  "result": "REQUESTED",
  "previousState": "STOPPED",
  "newState": null,
  "occurredAt": "2026-01-15T12:00:00.000Z",
  "actor": { "id": "acsm1", "type": "SYSTEM" },
  "humanDecision": null,
  "source": "ACSM",
  "evidence": {},
  "episodeId": null
}
```

Allowed operations are `PLUG`, `PLAY`, `STOP`, `MAINTENANCE`, `RETURN`,
`UNPLUG`, `GOVERNANCE_APPROVAL`, and `GOVERNANCE_REJECTION`. Allowed results
are `REQUESTED`, `GOVERNANCE_DECIDED`, `ACKNOWLEDGED`, `COMPLETED`, and
`FAILED`. `GOVERNANCE_DECIDED` requires an explicit `humanDecision.decision`
of `APPROVED` or `REJECTED`.

A request and its confirmed outcome are separate facts: they must use separate
`eventId` values and may share `correlationId` and `commandId`. Missing states,
acknowledgements, decisions, or evidence must remain absent or null.

## Deferred activation

After an approved deployment window and after a real publisher has been
validated independently:

1. Keep `PERSISTENCE_ENABLE_MQTT=true` for the existing consumer.
2. Set `PERSISTENCE_ENABLE_PPU_EVENTS=true` for the persistence service.
3. Recreate/redeploy only that service through the approved operational
   procedure.
4. Verify `/health` reports `ppuEventsEnabled: true` and monitor the spool and
   dead-letter files.

Until step 2, the running consumer subscribes only to `cpslai1/data`,
`cpslai1/status`, `cpslai1/oee`, and `cpslai1/health`.
