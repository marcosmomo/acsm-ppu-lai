import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { GovernanceRepository } from '../lib/governance/governanceRepository.mjs';
import { TransactionalGovernanceFacade } from '../lib/governance/transactionalGovernanceFacade.mjs';
import { TransactionalLifecycleAuthority } from '../lib/governance/transactionalLifecycleAuthority.mjs';
import { LIFECYCLE_CONFIRMATION_LEVELS as LEVEL } from '../lib/governance/lifecycleEvidence.mjs';

const fixture = path.resolve('test/fixtures/governance-repository/current-valid.json');
const now = () => '2026-10-14T18:00:00.000Z';
const source = { system: 'acsm-isolated', component: 'transactional-lifecycle-authority', instanceId: 'worker-fixture' };
const identityFrom = (result) => ({
  cpsId: result.cycle.cpsId, plugEventId: result.cycle.plugEventId,
  plugCycleId: result.cycle.plugCycleId, profileId: result.profile.profileId,
});

function makeAuthority(repository, overrides = {}) {
  return new TransactionalLifecycleAuthority({
    repository, source, now,
    verifyTransitionResult: (_result, { permission, source: authoritySource }) => ({
      verified: true,
      principal: { type: 'LIFECYCLE_AUTHORITY', ...authoritySource },
      authorizationId: 'server-test-authority', scheme: 'injected-isolated-verifier',
      claimsHash: 'test-claims-digest', permission,
    }),
    ...overrides,
  });
}

async function isolated(run, repositoryOverrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acsm-transactional-lifecycle-'));
  const filePath = path.join(root, 'governance.json');
  fs.copyFileSync(fixture, filePath);
  const repository = new GovernanceRepository({ filePath, ...repositoryOverrides });
  const facade = new TransactionalGovernanceFacade({ repository, now });
  const reserved = facade.reserveAndCreatePendingProfile({
    cpsId: 'cpslai1', plugEventId: 'plug-event-b6-2-6',
    identity: { aasId: 'urn:test:cpslai1:aas', functionalVersion: '1', assetId: 'asset-cpslai1' },
  });
  const identity = identityFrom(reserved);
  repository.transact((draft) => { draft.plugCycles[identity.plugCycleId].authoritativeLifecycleState = 'idle'; });
  try { return await run({ root, filePath, repository, facade, identity, authority: makeAuthority(repository) }); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function runWorker(filePath, startPath, identity, operation) {
  const workerPath = path.resolve('test/fixtures/transactional-lifecycle-authority-worker.mjs');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, filePath, startPath, JSON.stringify(identity), operation], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
  });
}

test('Plug transition, logical state, correlated BACKEND_ACCEPTED evidence and checkpoint commit together', () => isolated(({ repository, identity, authority }) => {
  const beforeRevision = repository.read().revision;
  const result = authority.transition({ identity, operation: 'PLUG' });
  const recovered = authority.read({ identity });
  assert.equal(repository.read().revision, beforeRevision + 1);
  assert.equal(result.transition.previousState, 'idle');
  assert.equal(result.transition.resultingState, 'plug');
  assert.equal(result.evidence.confirmationLevel, LEVEL.BACKEND_ACCEPTED);
  for (const key of ['cpsId', 'plugEventId', 'plugCycleId', 'profileId']) assert.equal(result.evidence[key], identity[key]);
  assert.equal(recovered.logicalState, 'plug');
  assert.equal(recovered.plug.transitionId, result.evidence.transitionId);
  assert.equal(recovered.plugEvidence.evidenceId, result.evidence.evidenceId);
  assert.equal(recovered.cycleState, 'RESERVED');
  assert.equal(recovered.cycle.checkpoints.lifecycleTransitioned, false);
  assert.equal(recovered.cycle.checkpoints.plugEvidenceStored, true);
  assert.equal(result.evidence.outcome, 'ACCEPTED');
  assert.equal(result.evidence.commandId, null);
}));

test('Unplug is accepted only from persisted plug/play state and does not close governance cycle', () => isolated(({ repository, identity, authority }) => {
  const plugged = authority.transition({ identity, operation: 'PLUG' });
  const unplugged = authority.transition({ identity, operation: 'UNPLUG' });
  const state = authority.read({ identity });
  assert.equal(unplugged.transition.previousState, 'plug');
  assert.equal(unplugged.transition.resultingState, 'unplugged');
  assert.equal(unplugged.evidence.confirmationLevel, LEVEL.BACKEND_ACCEPTED);
  assert.equal(state.logicalState, 'unplugged');
  assert.equal(state.cycleState, 'RESERVED');
  assert.equal(state.cycle.checkpoints.closeRequested, false);
  assert.equal(state.cycle.checkpoints.lifecycleTransitioned, false);
  assert.equal(state.unplug.transitionId, unplugged.evidence.transitionId);
  assert.ok(plugged.evidence.evidenceId);
  assert.equal(repository.read().document.profileVersions.cpslai1.at(-1).status, 'PENDING_APPROVAL');
}));

test('same identity and operation retry returns original transition/evidence without a write', () => isolated(({ filePath, repository, identity, authority }) => {
  const first = authority.transition({ identity, operation: 'PLUG' });
  const bytes = fs.readFileSync(filePath, 'utf8');
  const revision = repository.read().revision;
  const retry = authority.transition({ identity, operation: 'PLUG', accepted: false, httpStatus: 500 });
  assert.equal(retry.idempotent, true);
  assert.equal(retry.evidence.evidenceId, first.evidence.evidenceId);
  assert.equal(retry.transition.transitionId, first.transition.transitionId);
  assert.equal(repository.read().revision, revision);
  assert.equal(fs.readFileSync(filePath, 'utf8'), bytes);
}));

test('rejects mismatched cycle identity and transitions not allowed by persisted logical state', () => isolated(({ repository, identity, authority }) => {
  assert.throws(() => authority.transition({ identity: { ...identity, profileId: 'old-profile' }, operation: 'PLUG' }), { code: 'LIFECYCLE_AUTHORITY_IDENTITY_CONFLICT' });
  assert.throws(() => authority.transition({ identity, operation: 'UNPLUG' }), { code: 'LIFECYCLE_AUTHORITY_TRANSITION_NOT_ALLOWED' });
  repository.transact((draft) => { draft.plugCycles[identity.plugCycleId].authoritativeLifecycleState = 'play'; });
  assert.throws(() => authority.transition({ identity, operation: 'PLUG' }), { code: 'LIFECYCLE_AUTHORITY_TRANSITION_NOT_ALLOWED' });
  assert.equal(repository.read().document.plugCycles[identity.plugCycleId].lifecycleEvidence?.PLUG, undefined);
}));

test('restart recovers logical state and evidence before the next lifecycle phase', () => isolated(({ filePath, identity, authority }) => {
  const plug = authority.transition({ identity, operation: 'PLUG' });
  const restartedRepository = new GovernanceRepository({ filePath });
  const restarted = makeAuthority(restartedRepository);
  assert.equal(restarted.read({ identity }).logicalState, 'plug');
  assert.equal(restarted.read({ identity }).plugEvidence.evidenceId, plug.evidence.evidenceId);
  const unplug = restarted.transition({ identity, operation: 'UNPLUG' });
  assert.equal(unplug.transition.previousState, 'plug');
  assert.equal(restarted.read({ identity }).logicalState, 'unplugged');
}));

test('failed atomic commit exposes no logical transition or evidence; retry after restart succeeds', () => isolated(({ filePath, identity }) => {
  const failingRepository = new GovernanceRepository({
    filePath,
    faultInjector(stage) { if (stage === 'beforeRename') throw new Error('isolated authority failpoint'); },
  });
  const failing = makeAuthority(failingRepository);
  assert.throws(() => failing.transition({ identity, operation: 'PLUG' }), { code: 'GOVERNANCE_WRITE_FAILED' });
  const recoveredRepository = new GovernanceRepository({ filePath });
  const recovered = makeAuthority(recoveredRepository);
  const stateBeforeRetry = recovered.read({ identity });
  assert.equal(stateBeforeRetry.logicalState, 'idle');
  assert.equal(stateBeforeRetry.plugEvidence, null);
  const committed = recovered.transition({ identity, operation: 'PLUG' });
  assert.equal(recovered.read({ identity }).logicalState, 'plug');
  assert.equal(recovered.read({ identity }).plugEvidence.evidenceId, committed.evidence.evidenceId);
}));

test('multiple processes produce one deterministic transition and consistent evidence', () => isolated(async ({ filePath, repository, identity }) => {
  const startPath = path.join(path.dirname(filePath), 'start.signal');
  const children = [
    runWorker(filePath, startPath, identity, 'PLUG'),
    runWorker(filePath, startPath, identity, 'PLUG'),
  ];
  fs.writeFileSync(startPath, 'go');
  const results = await Promise.all(children);
  assert.equal(results.filter((result) => result.idempotent === true).length, 1);
  assert.equal(results.filter((result) => result.idempotent === false).length, 1);
  const cycle = repository.read().document.plugCycles[identity.plugCycleId];
  assert.equal(cycle.authoritativeLifecycleState, 'plug');
  assert.equal(cycle.logicalTransitions.PLUG.transitionId, cycle.lifecycleEvidence.PLUG.evidence.transitionId);
  assert.equal(cycle.checkpoints.plugEvidenceStored, true);
  assert.equal(repository.read().document.history.filter((item) => item.eventType === 'GOVERNANCE_LIFECYCLE_TRANSITION_ACCEPTED').length, 1);
}));

test('authority cannot infer communication or physical execution and readiness remains blocked', () => isolated(({ identity, authority }) => {
  const result = authority.transition({ identity, operation: 'PLUG' });
  assert.equal(result.evidence.confirmationLevel, LEVEL.BACKEND_ACCEPTED);
  assert.notEqual(result.evidence.confirmationLevel, LEVEL.COMMUNICATION_ACK);
  assert.notEqual(result.evidence.confirmationLevel, LEVEL.PHYSICAL_STATE_CONFIRMED);
  assert.equal(authority.readiness().status, 'BLOCKED');
  assert.ok(authority.readiness().blockers.includes('NO_PHYSICAL_CONFIRMATION_SOURCE'));
}));

test('authority module has no filesystem, Store, route, MQTT, OPC UA, or command dependency', () => {
  const sourceCode = fs.readFileSync(path.resolve('lib/governance/transactionalLifecycleAuthority.mjs'), 'utf8');
  const imports = [...sourceCode.matchAll(/^import[\s\S]*?from\s+['"]([^'"]+)['"];?$/gm)].map((match) => match[1]);
  assert.deepEqual(imports, ['node:crypto', './lifecycleEvidence.mjs', './governanceRepository.mjs']);
});
