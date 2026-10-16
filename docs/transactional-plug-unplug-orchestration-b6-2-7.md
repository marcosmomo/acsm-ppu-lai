# B6.2.7 — isolated Plug/Unplug orchestration

## Scope

`TransactionalPlugUnplugOrchestrator` composes the injected `TransactionalGovernanceAdapters`, `TransactionalLifecycleAuthority`, and `LifecycleEvidenceRepository`. Its constructor requires all three to reference the **same `GovernanceRepository` object**. It has no route/runtime wiring and performs no HTTP, MQTT, HCM, OPC UA, PPU, or physical operation. Tests use sanitized fixture copies in temporary directories.

## Commit sequence and recoverability

Plug is deliberately a sequence of two commits after reservation:

1. `reserveAndCreatePendingProfile`: one Repository commit creates the `RESERVED` cycle, a new `PENDING_APPROVAL` profile/version, history, and any initial PPU outbox intent.
2. `TransactionalLifecycleAuthority.transition(PLUG)`: one Repository commit stores the typed logical transition, `BACKEND_ACCEPTED` evidence, evidence checkpoint, logical lifecycle state and history together.
3. Facade activation: a separate commit re-reads that persisted validated evidence under the Repository lock, verifies exact CPS/event/cycle/profile correlation, and transitions the cycle to `ACTIVE` while preserving the profile's approval status.

Unplug follows the corresponding pattern: validate the exact active cycle, atomically persist Unplug logical state + evidence, then separately close that exact cycle/profile while preserving approval/denial. Closing is not driven by CPS-only snapshots.

These steps are **not one atomic lifecycle+governance commit**: the lifecycle authority contract commits before governance activation/closure. Intermediate states are durable and recoverable:

- `RESERVED`, no Plug evidence: retry the same event/identity; do not infer a successful transition.
- `RESERVED`, validated Plug evidence: retry activation; it consumes the stored evidence and does not issue a second transition.
- `ACTIVE`, no Unplug evidence: retry the same correlated Unplug request.
- `ACTIVE`, validated Unplug evidence: retry close; it consumes persisted evidence and does not issue another transition.
- Conflicting identity, missing/invalid evidence, or incompatible state: stop with conflict; no automatic repair by elapsed time.

The transition/evidence pair is atomic in one Repository commit. Activation and close each have their own commit, so there is an intentional observable checkpoint boundary. A later design could combine authority transition/evidence and cycle activation/close in one Repository transaction only if the authority can return a verified, durable transition result synchronously *inside* the same transaction without external I/O, and the domain explicitly approves that changed contract. This prototype keeps the existing authority/evidence contract and does not silently combine semantics.

## Initial logical state

The authority will not assume an initial state. In these tests the trusted harness explicitly injects `initialStateByCps: { cpslai1: 'idle' }`; a replug derives its prior state from the latest **closed** cycle persisted in the same document. Production must obtain or reconcile the first-cycle baseline from a server-authoritative source before using this authority. An arbitrary request body cannot supply the state.

## Governance and Play

Every new cycle creates a `PENDING_APPROVAL` profile regardless of the previous profile's decision. Lifecycle activation changes only the cycle/lifecycle status. Human approval in tests uses an injected trusted authorization context; that fixture is not an operational authentication system. The Play projection passes only when the current profile and cycle identities correlate, cycle is `ACTIVE`, profile is `APPROVED`, and lifecycle phase equals the expected phase. The operational Play-gate is unchanged.

## Test evidence

`test/transactional-plug-unplug-orchestrator.test.mjs` covers first Plug, no-write retry, correlated Unplug, preserved approval state, replug without approval inheritance, evidence/identity rejection, failure after reservation, recovery after persisted evidence but failed activation, failure after Unplug evidence but before close, lost-response retry, stale-cycle isolation, same-event races from two Node processes, and rejection of separate Repository instances.

The isolated regression command used for B6.2.7 passed **134/134 tests**, including Repository, facade, adapter, lifecycle evidence/authority, and Evolution regression suites. It does not access runtime services or operational storage. These results validate prototype behavior only; they do not prove operational lifecycle authority, human authentication, physical actuation, filesystem suitability across hosts, or runtime cutover readiness.

## B6.3 blockers

- The operational lifecycle implementation does not durably accept transitions with all four IDs and stable `transitionId`; this authority is a prototype.
- No operational server identity/origin verifier or human authentication/authorization integration is provided.
- No authoritative initial lifecycle baseline for the first cycle is wired.
- `BACKEND_ACCEPTED` is logical acceptance only, not communication acknowledgement or physical confirmation.
- Operational writers/readers are not suspended or redirected to this Repository; legacy CPS-only close paths still exist outside this isolated code.
- No operational backup/topology/cutover/rollback authorization has been performed.

Therefore readiness remains **BLOCKED**, and B6.3/cutover must not proceed on the strength of these isolated tests alone.
