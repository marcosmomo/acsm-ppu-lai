import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { GovernanceRepository } from '../lib/governance/governanceRepository.mjs';
import { LifecycleEvidenceRepository } from '../lib/governance/lifecycleEvidenceRepository.mjs';
import { TransactionalGovernanceFacade } from '../lib/governance/transactionalGovernanceFacade.mjs';
import { createBackendLifecycleEvidence, LIFECYCLE_CONFIRMATION_LEVELS as LEVEL } from '../lib/governance/lifecycleEvidence.mjs';

const fixture = path.resolve('test/fixtures/governance-repository/current-valid.json');
const instant = '2026-10-14T15:00:00.000Z';
const source = { system: 'acsm-test', component: 'lifecycle-test', instanceId: 'server-test-1' };
const permissionFor = (operation) => `lifecycle.${operation === 'PLUG' ? 'plug' : 'unplug'}.record`;
const receiptFor = (permission) => ({
  verified: true, principal: { type: 'LIFECYCLE_AUTHORITY', ...source },
  authorizationId: 'auth-fixture-1', scheme: 'test-verifier', claimsHash: 'claims-fixture-hash', permission,
});

function evidence(identity, { operation = 'PLUG', transitionId = `transition-${operation.toLowerCase()}-1`, occurredAt = instant } = {}) {
  const previousState = operation === 'PLUG' ? 'idle' : 'plug';
  const resultingState = operation === 'PLUG' ? 'plug' : 'unplugged';
  return createBackendLifecycleEvidence({
    now: () => '2026-10-14T15:00:01.000Z',
    verifyTransitionResult: (_result, { permission }) => receiptFor(permission),
  }).issue({
    resultKind: 'LIFECYCLE_TRANSITION_RESULT', ...identity,
    transitionId, operation, previousState, resultingState,
    accepted: true, outcome: 'ACCEPTED', source, occurredAt,
    correlationId: identity.plugCycleId,
    commandId: null,
    evidenceReference: { kind: 'BACKEND_TRANSITION_RECORD', recordId: transitionId, contentHash: 'd'.repeat(64) },
  }, identity);
}

async function isolated(run, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acsm-lifecycle-evidence-'));
  const filePath = path.join(root, 'governance.json');
  fs.copyFileSync(fixture, filePath);
  const repository = new GovernanceRepository({ filePath, ...options.repositoryOptions });
  const facade = new TransactionalGovernanceFacade({ repository, now: () => instant });
  const evidenceRepository = (overrides = {}) => new LifecycleEvidenceRepository({
    repository,
    verifyEvidenceOrigin: (_evidence, { permission }) => receiptFor(permission),
    confirmationPolicy: { minimumConfirmationLevel: LEVEL.BACKEND_ACCEPTED },
    now: () => '2026-10-14T15:00:02.000Z',
    resolveExpectedPreviousState: (cycle, operation) => operation === 'PLUG'
      ? (cycle.testExpectedInitialState || 'idle')
      : cycle.lifecycleState || cycle.lifecycleEvidence?.PLUG?.evidence?.resultingState || null,
    ...overrides,
  });
  try { return await run({ root, filePath, repository, facade, evidenceRepository }); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function reserve(facade, eventId = 'plug-event-b6-2-5') {
  const result = facade.reserveAndCreatePendingProfile({
    cpsId: 'cpslai1', plugEventId: eventId,
    identity: { aasId: 'urn:test:cpslai1:aas', functionalVersion: '1', assetId: 'asset-cpslai1' },
  });
  return {
    cpsId: result.cycle.cpsId, plugEventId: result.cycle.plugEventId,
    plugCycleId: result.cycle.plugCycleId, profileId: result.profile.profileId,
  };
}

function markActive(facade, identity) {
  return facade.activateCycle({
    ...identity,
    lifecycleEvidence: { accepted: true, transitionId: 'test-only-activation-transition', phase: 'plug' },
  });
}

function worker(filePath, startPath, identity, candidate) {
  const workerPath = path.resolve('test/fixtures/lifecycle-evidence-worker.mjs');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, filePath, startPath, JSON.stringify(identity), JSON.stringify(candidate)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
  });
}

test('persists Plug evidence and its checkpoint in one Repository commit without activating or approving', () => isolated(({ repository, facade, evidenceRepository }) => {
  const identity = reserve(facade);
  const before = repository.read();
  const candidate = evidence(identity);
  const result = evidenceRepository().record({ identity, evidence: candidate });
  const after = repository.read();
  const cycle = after.document.plugCycles[identity.plugCycleId];
  assert.equal(after.revision, before.revision + 1);
  assert.equal(result.status, 'VALIDATED');
  assert.equal(cycle.lifecycleEvidence.PLUG.evidence.transitionId, candidate.transitionId);
  assert.equal(cycle.checkpoints.plugEvidenceStored, true);
  assert.equal(cycle.checkpoints.lifecycleTransitioned, false);
  assert.equal(cycle.state, 'RESERVED');
  assert.equal(cycle.lifecycleState, undefined);
  assert.equal(after.document.profileVersions.cpslai1.at(-1).status, 'PENDING_APPROVAL');
}));

test('recovers evidence/checkpoints after repository restart and idempotent retry writes nothing', () => isolated(({ root, filePath, repository, facade, evidenceRepository }) => {
  const identity = reserve(facade);
  const candidate = evidence(identity);
  const store = evidenceRepository();
  store.record({ identity, evidence: candidate });
  const bytes = fs.readFileSync(filePath, 'utf8');
  const recoveredRepository = new GovernanceRepository({ filePath });
  const restarted = evidenceRepository({ repository: recoveredRepository });
  const recovered = restarted.readCycle({ identity });
  assert.equal(recovered.plug.evidence.evidenceId, candidate.evidenceId);
  assert.equal(recovered.cycle.checkpoints.plugEvidenceStored, true);
  assert.equal(recovered.processingState, 'RESERVED');
  const retry = restarted.record({ identity, evidence: candidate });
  assert.equal(retry.idempotent, true);
  assert.equal(recoveredRepository.read().revision, repository.read().revision);
  assert.equal(fs.readFileSync(filePath, 'utf8'), bytes);
  assert.ok(root);
}));

test('identical transitionId/content is NO_OP, divergent content or identity conflicts', () => isolated(({ repository, facade, evidenceRepository }) => {
  const identity = reserve(facade);
  const store = evidenceRepository();
  const first = evidence(identity);
  store.record({ identity, evidence: first });
  const revision = repository.read().revision;
  assert.equal(store.record({ identity, evidence: first }).idempotent, true);
  assert.equal(repository.read().revision, revision);
  const divergent = evidence(identity, { occurredAt: '2026-10-14T15:00:00.500Z' });
  assert.throws(() => store.record({ identity, evidence: divergent }), { code: 'LIFECYCLE_TRANSITION_ID_CONFLICT' });
  assert.throws(() => store.record({ identity: { ...identity, plugCycleId: 'old-cycle' }, evidence: first }), { code: 'LIFECYCLE_EVIDENCE_CYCLE_IDENTITY_CONFLICT' });
}));

test('Unplug persistence is correlated, recoverable, and does not close cycle or change approval', () => isolated(({ repository, facade, evidenceRepository }) => {
  const identity = reserve(facade);
  const store = evidenceRepository();
  const plugEvidence = evidence(identity);
  store.record({ identity, evidence: plugEvidence });
  markActive(facade, identity);
  const before = repository.read();
  const unplug = evidence(identity, { operation: 'UNPLUG' });
  const result = store.record({ identity, evidence: unplug });
  const after = repository.read();
  assert.equal(result.status, 'VALIDATED');
  assert.equal(after.document.plugCycles[identity.plugCycleId].state, 'ACTIVE');
  assert.equal(after.document.plugCycles[identity.plugCycleId].lifecycleState, undefined);
  assert.equal(after.document.plugCycles[identity.plugCycleId].checkpoints.unplugEvidenceStored, true);
  assert.equal(after.document.plugCycles[identity.plugCycleId].checkpoints.closeRequested, false);
  assert.equal(after.document.profileVersions.cpslai1.at(-1).status, 'PENDING_APPROVAL');
  assert.equal(after.document.history.length, before.document.history.length + 1);
  assert.equal(store.readCycle({ identity }).unplug.evidence.evidenceId, unplug.evidenceId);
}));

test('uncertain order is persisted as PENDING_RECONCILIATION and reconciles without lifecycle transition', () => isolated(({ repository, facade, evidenceRepository }) => {
  const identity = reserve(facade);
  const pendingStore = evidenceRepository({ resolveExpectedPreviousState: () => null });
  const candidate = evidence(identity);
  const pending = pendingStore.record({ identity, evidence: candidate });
  assert.equal(pending.status, 'PENDING_RECONCILIATION');
  assert.equal(pendingStore.listPendingReconciliation().pending.length, 1);
  const recoveryStore = evidenceRepository({ resolveExpectedPreviousState: (cycle, operation) => operation === 'PLUG' ? 'idle' : null });
  const reconciled = recoveryStore.reconcile({ identity, operation: 'PLUG' });
  assert.equal(reconciled.status, 'VALIDATED');
  assert.equal(reconciled.cycle.state, 'RESERVED');
  assert.equal(reconciled.cycle.checkpoints.lifecycleTransitioned, false);
  assert.equal(repository.read().document.plugCycles[identity.plugCycleId].lifecycleEvidence.PLUG.status, 'VALIDATED');
}));

test('rejects stale Unplug after close/replug and transitionId reuse across cycles', () => isolated(({ repository, facade, evidenceRepository }) => {
  const firstIdentity = reserve(facade, 'plug-old');
  const store = evidenceRepository();
  store.record({ identity: firstIdentity, evidence: evidence(firstIdentity) });
  markActive(facade, firstIdentity);
  const staleUnplug = evidence(firstIdentity, { operation: 'UNPLUG', transitionId: 'reused-transition' });
  store.record({ identity: firstIdentity, evidence: staleUnplug });
  facade.closeCorrelatedCycle({ ...firstIdentity, unplugEvidence: { accepted: true, transitionId: 'legacy-test-close' } });
  const secondIdentity = reserve(facade, 'plug-new');
  assert.equal(store.record({ identity: firstIdentity, evidence: staleUnplug }).idempotent, true);
  assert.throws(() => store.record({ identity: secondIdentity, evidence: evidence(secondIdentity, { transitionId: 'reused-transition' }) }), { code: 'LIFECYCLE_TRANSITION_ID_CONFLICT' });
  assert.throws(() => store.record({ identity: firstIdentity, evidence: evidence(firstIdentity, { operation: 'UNPLUG', transitionId: 'different-late-unplug' }) }), { code: 'LIFECYCLE_EVIDENCE_UNPLUG_CYCLE_NOT_ACTIVE' });
  assert.equal(repository.read().document.plugCycles[secondIdentity.plugCycleId].state, 'RESERVED');
}));

test('concurrent processes persist one transition once; divergent reuse conflicts', () => isolated(async ({ root, filePath, repository, facade }) => {
  const identity = reserve(facade);
  const candidate = evidence(identity);
  const startPath = path.join(root, 'start.signal');
  const left = worker(filePath, startPath, identity, candidate);
  const right = worker(filePath, startPath, identity, candidate);
  fs.writeFileSync(startPath, 'go');
  const results = await Promise.all([left, right]);
  assert.equal(results.filter((result) => result.idempotent === true).length, 1);
  assert.equal(results.filter((result) => result.idempotent === false).length, 1);
  assert.equal(repository.read().revision, 2);
  assert.equal(repository.read().document.history.filter((entry) => entry.eventType === 'GOVERNANCE_LIFECYCLE_EVIDENCE_STORED').length, 1);

  const divergentStart = path.join(root, 'divergent.signal');
  const divergent = evidence(identity, { occurredAt: '2026-10-14T15:00:00.500Z' });
  const one = worker(filePath, divergentStart, identity, candidate);
  const two = worker(filePath, divergentStart, identity, divergent);
  fs.writeFileSync(divergentStart, 'go');
  const conflictResults = await Promise.all([one, two]);
  assert.equal(conflictResults.filter((result) => result.status === 'LIFECYCLE_TRANSITION_ID_CONFLICT').length, 1);
  assert.equal(repository.read().revision, 2);
}));

test('failed commit leaves evidence/checkpoint absent and retry succeeds after restart', () => isolated(({ filePath, facade }) => {
  const identity = reserve(facade);
  const candidate = evidence(identity);
  const failingRepository = new GovernanceRepository({
    filePath,
    faultInjector(stage) { if (stage === 'beforeRename') throw new Error('isolated failpoint'); },
  });
  const failingStore = new LifecycleEvidenceRepository({
    repository: failingRepository,
    verifyEvidenceOrigin: (_evidence, { permission }) => receiptFor(permission),
    confirmationPolicy: { minimumConfirmationLevel: LEVEL.BACKEND_ACCEPTED },
    now: () => '2026-10-14T15:00:02.000Z',
    resolveExpectedPreviousState: () => 'idle',
  });
  assert.throws(() => failingStore.record({ identity, evidence: candidate }), { code: 'GOVERNANCE_WRITE_FAILED' });
  const recoveredRepository = new GovernanceRepository({ filePath });
  const recoveredStore = new LifecycleEvidenceRepository({
    repository: recoveredRepository,
    verifyEvidenceOrigin: (_evidence, { permission }) => receiptFor(permission),
    confirmationPolicy: { minimumConfirmationLevel: LEVEL.BACKEND_ACCEPTED },
    now: () => '2026-10-14T15:00:02.000Z', resolveExpectedPreviousState: () => 'idle',
  });
  assert.equal(recoveredStore.readCycle({ identity }).plug, null);
  recoveredStore.record({ identity, evidence: candidate });
  assert.equal(recoveredStore.readCycle({ identity }).plug.evidence.transitionId, candidate.transitionId);
}));

test('fails closed for corrupt JSON, missing authority, and confirmation below policy', () => isolated(({ root, filePath, facade, evidenceRepository }) => {
  const identity = reserve(facade);
  const candidate = evidence(identity);
  assert.throws(() => new LifecycleEvidenceRepository({
    repository: new GovernanceRepository({ filePath }),
    confirmationPolicy: { minimumConfirmationLevel: LEVEL.BACKEND_ACCEPTED },
  }), { code: 'LIFECYCLE_EVIDENCE_ORIGIN_VERIFIER_REQUIRED' });
  const untrusted = evidenceRepository({ verifyEvidenceOrigin: () => ({ verified: false }) });
  assert.throws(() => untrusted.record({ identity, evidence: candidate }), { code: 'LIFECYCLE_EVIDENCE_ORIGIN_UNTRUSTED' });
  const strict = evidenceRepository({ confirmationPolicy: { minimumConfirmationLevel: LEVEL.PHYSICAL_STATE_CONFIRMED } });
  assert.throws(() => strict.record({ identity, evidence: candidate }), { code: 'LIFECYCLE_EVIDENCE_CONFIRMATION_INSUFFICIENT' });
  const corruptPath = path.join(root, 'corrupt.json');
  fs.writeFileSync(corruptPath, '{ truncated');
  const corruptStore = new LifecycleEvidenceRepository({
    repository: new GovernanceRepository({ filePath: corruptPath }),
    verifyEvidenceOrigin: (_evidence, { permission }) => receiptFor(permission),
    confirmationPolicy: { minimumConfirmationLevel: LEVEL.BACKEND_ACCEPTED },
  });
  assert.throws(() => corruptStore.listPendingReconciliation(), { code: 'GOVERNANCE_JSON_INVALID' });
}));

test('preserves legacy history, versions, outbox and approval decisions', () => isolated(({ repository, facade, evidenceRepository }) => {
  const before = repository.read().document;
  const identity = reserve(facade);
  const beforeEvidence = repository.read().document;
  const postReserveStatus = beforeEvidence.profiles.cpslai1.status;
  evidenceRepository().record({ identity, evidence: evidence(identity) });
  const after = repository.read().document;
  assert.deepEqual(after.profileVersions.cpslai1.slice(0, before.profileVersions.cpslai1.length), before.profileVersions.cpslai1);
  assert.equal(after.profiles.cpslai1.status, postReserveStatus);
  assert.deepEqual(after.ppuOutbox, beforeEvidence.ppuOutbox);
  assert.ok(after.history.length > before.history.length);
  assert.ok(after.profileVersions.cpslai1.some((profile) => profile.status === 'APPROVED'));
  assert.equal(after.profileVersions.cpslai1.at(-1).status, 'PENDING_APPROVAL');
}));
