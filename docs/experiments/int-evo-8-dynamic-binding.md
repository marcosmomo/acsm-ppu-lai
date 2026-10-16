# INT-EVO-8 — Dynamic AAS binding offline rehearsal

This experiment composes the verified AAS source, the existing transactional Plug/Unplug orchestrator, Evolution coordinator/store, INT-EVO-2 read model, and the pure AAS card presenter. It is not wired to the operational Plug Phase.

## Frozen binding

Schema: `accepted-cycle-aas-binding/1.0.0`. The immutable read projection contains `cpsId`, `plugEventId`, `plugCycleId`, `profileId`, `aasId`, `assetId`, `contentHash`, `sourceId`, `sourceType`, `aasVersion`, and the authorized reference ID. A functional hash is also retained as an internal integrity field.

The source catalog is resolved and verified before reserve. Its identity and content hash are included in the transactional cycle identity at reserve, where the existing authority freezes that identity. The externally visible binding object is only materialized after the orchestrator confirms lifecycle evidence, an ACTIVE cycle, and the matching governance profile from the same injected transactional repository. A repeated event with a different AAS identity conflicts; the composition never replaces the accepted reference.

There is no separate binding Store. Temporary GovernanceRepository, lifecycle evidence, AAS archive, and EvolutionStore are created below the OS temporary directory by the runner. All authority/evidence dependencies in the composition must share one repository/adapters instance.

## Composition and failure boundaries

`AcceptedCycleAasComposition` resolves AAS through the injected authorized catalog, validates content hash and document identities using `verifiableAasDocumentSource`, consumes its normalized functional snapshot, reserves/accepts via the existing orchestrator, materializes the binding, executes the existing Evolution coordinator, then builds the INT-EVO-2 projection and card presentation. It does not import or initialize any operational Store, route, React component, OPC UA or MQTT client.

Unplug calls only the transactional orchestrator and checks that Evolution comparison count did not change. Closed cycles can still be queried by their exact cycle identity. Play-gate reads the existing governance adapter; human approval is an explicitly named test fixture and is never automatic.

## Offline run

Run `node scripts/experiments/run-int-evo-8-dynamic-binding.mjs` to write `report.json` and `summary.md` under a new temporary directory. The report includes four accepted cycles (V1 BASELINE, V1 NO_CHANGE, V2 CHANGED, V3 CHANGED/ADDED), a removal probe, unique cycle/profile identities, idempotent retry and closed-cycle history checks. No project data files are written by the runner.

The OperatingMode check varies only an abstract injected `AUTO`/`MANUAL` lifecycle field and asserts the read model's identity, lifecycle, AAS/capabilities and Evolution are unchanged. These labels are simulation inputs, not claims about station OPC UA values.

## Operational integration still required (not implemented)

1. The server-side Plug request coordinator must receive a server-authorized AAS reference from the AAS registration/selection boundary. The browser may submit an opaque reference, never a filesystem path or trusted hash.
2. Resolve and verify that reference immediately before reservation; freeze its ID/hash/source/version in the same authoritative transaction that reserves the PPU cycle. Only after lifecycle evidence makes that cycle ACTIVE should the binding be exposed.
3. Extend the lifecycle authority/repository schema and migration only as part of the approved B6.3 writer cutover; do not add a parallel writer. Ensure idempotent outbox/event handling survives a crash between acceptance and Evolution projection.
4. Add a read-only API that queries by the complete `cpsId + plugEventId + plugCycleId + profileId`, joins the authority-frozen AAS identity and exact Evolution snapshot/comparison/hash, and returns the sanitized card projection. Missing/ambiguous/conflicting identity stays UNBOUND/CONFLICT.
5. Only after API and authorization review, change PlugFase to pass that projection into the existing `AasFunctionalCapabilitiesPreview`; remove its static-only source if/when approved. The card itself remains read-only and has no version selector.

B6.3 blockers remain: trusted human authentication/authorization, authoritative lifecycle baseline and evidence, migration of existing cycles, joint replacement of all governance/lifecycle writers, transactional outbox post-commit delivery/recovery, and deployment coordination for multiple workers. Evolution must not create or approve governance profiles. None of these prerequisites is addressed by this offline rehearsal.
