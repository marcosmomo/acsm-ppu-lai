# INT-EVO-9 — Read-only AAS/Evolution query by PPU cycle

## Reuse and contract

`lib/evolution/evolutionCycleQuery.mjs` is the query-only service; it reuses `evolutionCycleReadModel.mjs`, `aasFunctionalCardPresentation.mjs`, the INT-EVO-5 verified document source and the frozen cycle identity created by INT-EVO-8. INT-EVO-8's `readCycle()` now delegates to this service. No second correlation algorithm, endpoint, Store, or Evolution comparator is introduced.

Input: `{ cpsId, plugCycleId }`. The authority provider must return that exact cycle and its exact profile. The service reads `plugEventId` from the cycle, requires `governanceProfileId === profileId`, and checks that the profile has the same cycle and event IDs. It never searches for a latest profile or uses timestamps. The cycle's frozen AAS reference, AAS/Asset IDs, content hash, functional hash, source ID and source type are checked against a catalog-resolved document.

The result has separate `correlationStatus`, `bindingStatus`, and `evolutionStatus` fields. Thus cycle identity can be `CORRELATED` while the AAS is `UNBOUND`/`UNAVAILABLE`, or while Evolution is `EVOLUTION_NOT_PROCESSED`/`UNAVAILABLE`. A corrupted identity or comparison returns `CONFLICT`. The sanitized `aas` projection includes only identity, version/hash, capabilities, services, provenance and evidence; it never includes document bytes, paths, or Store documents.

By default, experimental AAS references are not eligible for a query result. The INT-EVO-8 offline composition explicitly opts into experimental references for simulation only. The AAS source's new internal `resolve(..., { archive: false })` mode still validates authorized bytes and hash but does not archive or write during a query.

## Read-only boundaries

The query service accepts injected `cycleProvider.readCycle`, `aasSource.resolve`, and `evolutionProvider.inspect` providers. It imports no Store, filesystem, governance, lifecycle, network, PPU or operational API module. It does not run Evolution, approve a profile, mutate lifecycle, or create a binding. The endpoint is intentionally not implemented in INT-EVO-9.

## Tests

`test/int-evo-9-cycle-query.test.mjs` verifies an active and closed cycle, AAS identity/hash, declared functions/services, missing Evolution, unavailable Evolution provider, governance/profile conflict, AAS hash conflict, Evolution hash conflict, unbound cycle, unavailable cycle, experimental-source denial, and unchanged repository/Evolution/archive bytes across reads. INT-EVO-8 regressions continue to verify BASELINE, NO_CHANGE, CHANGED/ADDED, CHANGED/REMOVED, retry and failure recovery.

## Work remaining before a GET endpoint

Provide a production-authorized cycle provider backed by the single B6.3 transactional authority and a production AAS catalog/source whose references are frozen at Plug acceptance. Define authentication and CPS/cycle-level authorization, response-cache policy, timeout/error mapping, and safe logging. Then add a GET route that passes only the requested CPS/cycle identifiers to the injected query service. Do not expose internal stores or use experimental catalogs operationally.

B6.3's trusted human authorization, lifecycle baseline/evidence, existing-cycle migration, joint writer cutover and post-commit outbox/recovery remain prerequisites. Until then this service is test composition only and must not be used to imply operational binding.
