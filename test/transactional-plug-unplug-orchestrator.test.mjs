import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { GovernanceRepository } from '../lib/governance/governanceRepository.mjs';
import { TransactionalGovernanceFacade } from '../lib/governance/transactionalGovernanceFacade.mjs';
import { TransactionalGovernanceAdapters } from '../lib/governance/transactionalGovernanceAdapters.mjs';
import { TransactionalLifecycleAuthority } from '../lib/governance/transactionalLifecycleAuthority.mjs';
import { LifecycleEvidenceRepository } from '../lib/governance/lifecycleEvidenceRepository.mjs';
import { TransactionalPlugUnplugOrchestrator } from '../lib/governance/transactionalPlugUnplugOrchestrator.mjs';
import { LIFECYCLE_CONFIRMATION_LEVELS as LEVEL } from '../lib/governance/lifecycleEvidence.mjs';

const fixture = path.resolve('test/fixtures/governance-repository/current-valid.json');
const source = { system: 'acsm-test', component: 'orchestrator-test', instanceId: 'isolated-1' };
const now = () => '2026-10-14T18:00:00.000Z';
const identityInput = {
  aasReferenceId: 'test-cpslai1-aas-v1',
  aasId: 'urn:test:cpslai1:aas',
  assetId: 'asset-cpslai1',
  contentHash: 'a'.repeat(64),
  sourceId: 'transactional-orchestrator-fixture',
  sourceType: 'AUTHORIZED_TEST_AAS',
  aasVersion: '1',
  aasRevision: '1',
  functionalHash: 'b'.repeat(64),
};
const receipt = (permission) => ({ verified: true, principal: { type: 'LIFECYCLE_AUTHORITY', ...source }, authorizationId: 'isolated-authority', scheme: 'test-verifier', claimsHash: 'fixture-claims', permission });

async function isolated(run, { faultInjector } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acsm-plug-unplug-orchestration-'));
  const filePath = path.join(root, 'governance.json');
  fs.copyFileSync(fixture, filePath);
  const repository = new GovernanceRepository({ filePath, faultInjector });
  const facade = new TransactionalGovernanceFacade({ repository, now });
  const adapters = new TransactionalGovernanceAdapters({ facade });
  const lifecycleAuthority = new TransactionalLifecycleAuthority({
    repository, source, now, initialStateByCps: { cpslai1: 'idle' },
    verifyTransitionResult: (_result, { permission }) => receipt(permission),
  });
  const evidenceRepository = new LifecycleEvidenceRepository({
    repository, now,
    verifyEvidenceOrigin: (_evidence, { permission }) => receipt(permission),
    confirmationPolicy: { minimumConfirmationLevel: LEVEL.BACKEND_ACCEPTED },
    resolveExpectedPreviousState: (cycle, operation) => operation === 'PLUG'
      ? cycle.authoritativeLifecycleState || 'idle'
      : cycle.authoritativeLifecycleState || cycle.lifecycleEvidence?.PLUG?.evidence?.resultingState || null,
  });
  const orchestrator = new TransactionalPlugUnplugOrchestrator({ adapters, lifecycleAuthority, evidenceRepository });
  try { return await run({ root, filePath, repository, facade, adapters, lifecycleAuthority, evidenceRepository, orchestrator }); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function plug(orchestrator, plugEventId = 'plug-orch-1') {
  return orchestrator.plug({ cpsId: 'cpslai1', plugEventId, identity: identityInput });
}

test('Plug reserves pending profile, persists lifecycle evidence and activates exact cycle', () => isolated(({ repository, orchestrator, adapters }) => {
  const result = plug(orchestrator);
  assert.equal(result.cycleState, 'ACTIVE');
  assert.equal(result.governanceStatus, 'PENDING_APPROVAL');
  assert.equal(result.confirmationLevel, LEVEL.BACKEND_ACCEPTED);
  for (const id of ['cpsId', 'plugEventId', 'plugCycleId', 'profileId']) assert.ok(result[id]);
  assert.equal(repository.read().document.plugCycles[result.plugCycleId].checkpoints.lifecycleTransitioned, true);
  assert.equal(repository.read().document.plugCycles[result.plugCycleId].logicalTransitions.PLUG.transitionId, result.lifecycle.evidence.transitionId);
  assert.equal(adapters.projectPlayGate({ cpsId: result.cpsId, profileId: result.profileId, plugCycleId: result.plugCycleId, lifecyclePhase: 'play' }).ok, false);
}));

test('identical Plug retry is byte-stable, does not transition again, and returns original profile', () => isolated(({ filePath, repository, orchestrator }) => {
  const first = plug(orchestrator);
  const bytes = fs.readFileSync(filePath, 'utf8');
  const revision = repository.read().revision;
  const retry = plug(orchestrator);
  assert.equal(retry.plugCycleId, first.plugCycleId);
  assert.equal(retry.profileId, first.profileId);
  assert.equal(repository.read().revision, revision);
  assert.equal(fs.readFileSync(filePath, 'utf8'), bytes);
}));

test('reserved AAS reference is persisted with complete cycle/profile identity and cannot be replaced', () => isolated(({ repository, orchestrator }) => {
  const result = plug(orchestrator, 'immutable-aas-event');
  const cycle = repository.read().document.plugCycles[result.plugCycleId];
  assert.deepEqual(cycle.aasReference, {
    schemaVersion: 'cycle-aas-reference/1.0',
    cpsId: result.cpsId,
    plugEventId: result.plugEventId,
    plugCycleId: result.plugCycleId,
    profileId: result.profileId,
    referenceId: identityInput.aasReferenceId,
    aasId: identityInput.aasId,
    assetId: identityInput.assetId,
    contentHash: identityInput.contentHash,
    sourceId: identityInput.sourceId,
    sourceType: identityInput.sourceType,
    version: identityInput.aasVersion,
    revision: identityInput.aasRevision,
  });
  assert.equal(cycle.identityHash.length, 64);
  assert.equal(cycle.identity.aasRevision, '1');
  assert.equal(repository.read().document.profileVersions.cpslai1.at(-1).status, 'PENDING_APPROVAL');

  assert.throws(() => repository.transact((draft) => {
    draft.plugCycles[result.plugCycleId].identity.aasId = 'urn:replacement';
  }), { code: 'GOVERNANCE_CYCLE_IDENTITY_IMMUTABLE' });
  assert.throws(() => repository.transact((draft) => {
    draft.plugCycles[result.plugCycleId].aasReference.referenceId = 'another-reference';
  }), { code: 'GOVERNANCE_CYCLE_IDENTITY_IMMUTABLE' });
  assert.equal(repository.read().document.plugCycles[result.plugCycleId].aasReference.referenceId, identityInput.aasReferenceId);
}));

test('same-event retry with a divergent AAS reference is rejected; a new closed-cycle Replug gets a new pending profile', () => isolated(({ repository, orchestrator }) => {
  const first = plug(orchestrator, 'aas-change-event-1');
  assert.throws(() => orchestrator.plug({
    cpsId: 'cpslai1', plugEventId: first.plugEventId,
    identity: { ...identityInput, aasReferenceId: 'different-reference' },
  }), { code: 'GOVERNANCE_PLUG_IDENTITY_CONFLICT' });
  orchestrator.unplug(first);
  const nextIdentity = { ...identityInput, aasReferenceId: 'test-cpslai1-aas-v2', aasVersion: null, aasRevision: null };
  const second = orchestrator.plug({ cpsId: 'cpslai1', plugEventId: 'aas-change-event-2', identity: nextIdentity });
  assert.notEqual(second.plugCycleId, first.plugCycleId);
  assert.notEqual(second.profileId, first.profileId);
  assert.equal(second.governanceStatus, 'PENDING_APPROVAL');
  assert.equal(repository.read().document.plugCycles[second.plugCycleId].aasReference.version, null);
  assert.equal(repository.read().document.plugCycles[second.plugCycleId].aasReference.revision, null);
  assert.equal(repository.read().document.plugCycles[first.plugCycleId].aasReference.referenceId, identityInput.aasReferenceId);
}));

test('Unplug closes only correlated cycle, preserves pending approval and retry is a no-op', () => isolated(({ filePath, repository, orchestrator }) => {
  const active = plug(orchestrator);
  const unplug = orchestrator.unplug(active);
  assert.equal(unplug.cycleState, 'CLOSED');
  assert.equal(unplug.governanceStatus, 'PENDING_APPROVAL');
  assert.equal(unplug.closed.profile.profileVersion, active.reserved.profile.profileVersion);
  assert.equal(repository.read().document.plugCycles[active.plugCycleId].aasReference.referenceId, identityInput.aasReferenceId);
  const bytes = fs.readFileSync(filePath, 'utf8');
  const revision = repository.read().revision;
  const retry = orchestrator.unplug(active);
  assert.equal(retry.cycleState, 'CLOSED');
  assert.equal(repository.read().revision, revision);
  assert.equal(fs.readFileSync(filePath, 'utf8'), bytes);
}));

test('authorization is separate: human approval allows correlated Play projection; old profile is not inherited on replug', () => isolated(({ adapters, orchestrator, repository }) => {
  const first = plug(orchestrator);
  assert.throws(() => adapters.approveProfile({ ...first, authorization: { subject: 'operator' } }), { code: 'GOVERNANCE_SERVER_AUTHORIZATION_REQUIRED' });
  const approved = adapters.approveProfile({ ...first, authorization: { authenticated: true, authorized: true, trusted: true, subject: 'operator-fixture' } });
  assert.equal(approved.profile.status, 'APPROVED');
  assert.equal(adapters.projectPlayGate({ cpsId: first.cpsId, profileId: first.profileId, plugCycleId: first.plugCycleId, lifecyclePhase: 'play' }).ok, true);
  const closed = orchestrator.unplug(first);
  assert.equal(closed.governanceStatus, 'APPROVED');
  assert.equal(closed.closed.profile.approvedBy, 'operator-fixture');
  const second = plug(orchestrator, 'plug-orch-2');
  assert.notEqual(second.profileId, first.profileId);
  assert.equal(second.governanceStatus, 'PENDING_APPROVAL');
  assert.equal(repository.read().document.profiles.cpslai1.profileId, second.profileId);
}));

test('missing or divergent correlated identity/evidence blocks advancement and closure', () => isolated(({ repository, facade, orchestrator, adapters }) => {
  const active = plug(orchestrator);
  assert.throws(() => adapters.closeUnplugFromPersistedEvidence({ ...active, plugCycleId: 'wrong-cycle' }), { code: 'GOVERNANCE_CYCLE_IDENTITY_CONFLICT' });
  const reserved = facade.reserveAndCreatePendingProfile({ cpsId: 'cpslai2', plugEventId: 'reserved-only', identity: { aasId: 'urn:test:cpslai2', functionalVersion: '1', assetId: 'asset-cpslai2' } });
  assert.throws(() => adapters.activatePlugFromPersistedEvidence({ cpsId: 'cpslai2', plugEventId: reserved.cycle.plugEventId, plugCycleId: reserved.cycle.plugCycleId, profileId: reserved.profile.profileId }), { code: 'GOVERNANCE_VALIDATED_LIFECYCLE_EVIDENCE_REQUIRED' });
  assert.equal(repository.read().document.plugCycles[reserved.cycle.plugCycleId].state, 'RESERVED');
}));

test('failure after reservation leaves recoverable RESERVED cycle; same request resumes without second profile', () => isolated(({ repository, orchestrator }) => {
  const reserve = orchestrator.adapters.reservePlug({ cpsId: 'cpslai1', plugEventId: 'partial-plug', identity: identityInput });
  const failedAuthority = new TransactionalLifecycleAuthority({ repository, source, now, initialStateByCps: { cpslai1: 'idle' }, verifyTransitionResult: () => { throw new Error('injected authority outage'); } });
  const failing = new TransactionalPlugUnplugOrchestrator({ adapters: orchestrator.adapters, lifecycleAuthority: failedAuthority, evidenceRepository: orchestrator.evidenceRepository });
  assert.throws(() => failing.plug({ cpsId: 'cpslai1', plugEventId: 'partial-plug', identity: identityInput }), /injected authority outage/);
  assert.equal(repository.read().document.plugCycles[reserve.plugCycleId].state, 'RESERVED');
  assert.equal(repository.read().document.plugCycles[reserve.plugCycleId].aasReference.referenceId, identityInput.aasReferenceId);
  const recovered = plug(orchestrator, 'partial-plug');
  assert.equal(recovered.plugCycleId, reserve.plugCycleId);
  assert.equal(repository.read().document.profileVersions.cpslai1.filter((p) => p.plugEventId === 'partial-plug').length, 1);
}));

test('AAS reference and pending profile survive repository restart between reservation and lifecycle acceptance', () => isolated(({ filePath, repository, orchestrator }) => {
  const reserved = orchestrator.adapters.reservePlug({ cpsId: 'cpslai1', plugEventId: 'aas-restart-event', identity: identityInput });
  const frozenBeforeRestart = repository.read().document.plugCycles[reserved.plugCycleId].aasReference;
  const restartedRepository = new GovernanceRepository({ filePath });
  const restartedFacade = new TransactionalGovernanceFacade({ repository: restartedRepository, now });
  const restartedAdapters = new TransactionalGovernanceAdapters({ facade: restartedFacade });
  const restartedAuthority = new TransactionalLifecycleAuthority({
    repository: restartedRepository, source, now, initialStateByCps: { cpslai1: 'idle' },
    verifyTransitionResult: (_result, { permission }) => receipt(permission),
  });
  const restartedEvidence = new LifecycleEvidenceRepository({
    repository: restartedRepository, now,
    verifyEvidenceOrigin: (_evidence, { permission }) => receipt(permission),
    confirmationPolicy: { minimumConfirmationLevel: LEVEL.BACKEND_ACCEPTED },
    resolveExpectedPreviousState: (cycle) => cycle.authoritativeLifecycleState || 'idle',
  });
  const restartedOrchestrator = new TransactionalPlugUnplugOrchestrator({
    adapters: restartedAdapters, lifecycleAuthority: restartedAuthority, evidenceRepository: restartedEvidence,
  });
  const recovered = restartedOrchestrator.plug({ cpsId: 'cpslai1', plugEventId: 'aas-restart-event', identity: identityInput });
  assert.equal(recovered.cycleState, 'ACTIVE');
  assert.equal(recovered.governanceStatus, 'PENDING_APPROVAL');
  assert.deepEqual(restartedRepository.read().document.plugCycles[recovered.plugCycleId].aasReference, frozenBeforeRestart);
  assert.equal(restartedRepository.read().document.profileVersions.cpslai1.filter((profile) => profile.plugEventId === 'aas-restart-event').length, 1);
}));

test('transition/evidence commit followed by activation failure is recoverable by persisted evidence retry', () => isolated(({ repository, facade, orchestrator }) => {
  const reserved = facade.reserveAndCreatePendingProfile({ cpsId: 'cpslai1', plugEventId: 'activation-fail', identity: identityInput });
  const identity = { cpsId: 'cpslai1', plugEventId: reserved.cycle.plugEventId, plugCycleId: reserved.cycle.plugCycleId, profileId: reserved.profile.profileId };
  const transition = orchestrator.lifecycleAuthority.transition({ identity, operation: 'PLUG' });
  const restarted = new TransactionalGovernanceFacade({ repository, now });
  const failOnce = new TransactionalGovernanceAdapters({ facade: restarted });
  const original = failOnce.activatePlugFromPersistedEvidence.bind(failOnce);
  let first = true;
  failOnce.activatePlugFromPersistedEvidence = (input) => { if (first) { first = false; throw new Error('injected activation interruption'); } return original(input); };
  const recoveredOrchestrator = new TransactionalPlugUnplugOrchestrator({ adapters: failOnce, lifecycleAuthority: orchestrator.lifecycleAuthority, evidenceRepository: orchestrator.evidenceRepository });
  assert.throws(() => recoveredOrchestrator.plug({ cpsId: 'cpslai1', plugEventId: 'activation-fail', identity: identityInput }), /injected activation interruption/);
  assert.equal(repository.read().document.plugCycles[identity.plugCycleId].state, 'RESERVED');
  const result = recoveredOrchestrator.plug({ cpsId: 'cpslai1', plugEventId: 'activation-fail', identity: identityInput });
  assert.equal(result.lifecycle.transition.transitionId, transition.transition.transitionId);
  assert.equal(result.cycleState, 'ACTIVE');
}));

test('failure after Unplug evidence but before governance close is recovered without a second transition', () => isolated(({ repository, orchestrator }) => {
  const active = plug(orchestrator, 'close-fail-event');
  let first = true;
  const adapters = Object.create(orchestrator.adapters);
  adapters.closeUnplugFromPersistedEvidence = (input) => {
    if (first) { first = false; throw new Error('injected close interruption'); }
    return orchestrator.adapters.closeUnplugFromPersistedEvidence(input);
  };
  const recovering = new TransactionalPlugUnplugOrchestrator({ adapters, lifecycleAuthority: orchestrator.lifecycleAuthority, evidenceRepository: orchestrator.evidenceRepository });
  assert.throws(() => recovering.unplug(active), /injected close interruption/);
  const cycle = repository.read().document.plugCycles[active.plugCycleId];
  assert.equal(cycle.state, 'ACTIVE');
  assert.equal(cycle.lifecycleEvidence.UNPLUG.status, 'VALIDATED');
  assert.equal(cycle.checkpoints.closeRequested, false);
  assert.equal(recovering.unplug(active).cycleState, 'CLOSED');
}));

test('two Node processes race the same Plug event and converge on one cycle/profile', () => isolated(async ({ root, filePath, repository }) => {
  const startPath = path.join(root, 'start.signal');
  const workerPath = path.resolve('test/fixtures/transactional-plug-unplug-orchestrator-worker.mjs');
  const runWorker = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, filePath, startPath, 'concurrent-event', JSON.stringify(identityInput)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
  });
  const first = runWorker(); const second = runWorker();
  fs.writeFileSync(startPath, 'go');
  const results = await Promise.all([first, second]);
  assert.equal(results[0].plugCycleId, results[1].plugCycleId);
  assert.equal(results[0].profileId, results[1].profileId);
  assert.deepEqual(results[0].aasReference, results[1].aasReference);
  assert.equal(results[0].aasReference.referenceId, identityInput.aasReferenceId);
  assert.equal(results[0].cycleState, 'ACTIVE');
  assert.equal(repository.read().document.profileVersions.cpslai1.filter((profile) => profile.plugEventId === 'concurrent-event').length, 1);
  assert.equal(Object.values(repository.read().document.plugCycles).filter((cycle) => cycle.cpsId === 'cpslai1' && cycle.state !== 'CLOSED').length, 1);
}));

test('HTTP-response-loss retry after close and delayed old Unplug cannot close new cycle', () => isolated(({ orchestrator }) => {
  const first = plug(orchestrator, 'old-plug');
  orchestrator.unplug(first); // Treat returned response as lost.
  assert.equal(orchestrator.unplug(first).cycleState, 'CLOSED');
  const second = plug(orchestrator, 'new-plug');
  assert.notEqual(second.plugCycleId, first.plugCycleId);
  assert.equal(orchestrator.unplug(first).cycleState, 'CLOSED');
  assert.equal(orchestrator.evidenceRepository.readCycle({ identity: second }).cycle.state, 'ACTIVE');
}));

test('composition rejects separate repositories, preventing a competing evidence store', () => isolated(({ adapters, lifecycleAuthority }) => {
  const anotherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'acsm-other-repo-'));
  try {
    fs.copyFileSync(fixture, path.join(anotherRoot, 'other.json'));
    const other = new GovernanceRepository({ filePath: path.join(anotherRoot, 'other.json') });
    const otherEvidence = new LifecycleEvidenceRepository({ repository: other, verifyEvidenceOrigin: (_e, { permission }) => receipt(permission), confirmationPolicy: { minimumConfirmationLevel: LEVEL.BACKEND_ACCEPTED } });
    assert.throws(() => new TransactionalPlugUnplugOrchestrator({ adapters, lifecycleAuthority, evidenceRepository: otherEvidence }), { code: 'GOVERNANCE_ORCHESTRATION_SHARED_REPOSITORY_REQUIRED' });
  } finally { fs.rmSync(anotherRoot, { recursive: true, force: true }); }
}));
