import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { GovernanceRepository } from '../lib/governance/governanceRepository.mjs';
import { TransactionalGovernanceFacade } from '../lib/governance/transactionalGovernanceFacade.mjs';

const fixture = path.resolve('test/fixtures/governance-repository/current-valid.json');
const identity = (aasId = 'urn:test:cpslai1:aas', functionalVersion = '1') => ({ aasId, functionalVersion, assetId: 'asset-cpslai1' });
const reserveInput = (overrides = {}) => ({
  cpsId: 'cpslai1', cps: { id: 'cpslai1' }, plugEventId: 'plug-event-b3-1', identity: identity(), ...overrides,
});
const exact = (result) => ({
  cpsId: result.cycle.cpsId, plugEventId: result.cycle.plugEventId, plugCycleId: result.cycle.plugCycleId,
  profileId: result.profile.profileId,
});
const lifecycleEvidence = (transitionId = 'plug-transition-1') => ({ accepted: true, transitionId, phase: 'plug', source: 'ISOLATED_TEST' });
const unplugEvidence = (transitionId = 'unplug-transition-1') => ({ accepted: true, transitionId, phase: 'unplug', source: 'ISOLATED_TEST' });
const human = (id = 'operator-b3') => ({ id, type: 'HUMAN' });

async function isolated(run, repositoryOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acsm-governance-cycles-'));
  const filePath = path.join(root, 'governance.json');
  fs.copyFileSync(fixture, filePath);
  const repository = new GovernanceRepository({ filePath, ...repositoryOptions });
  const facade = new TransactionalGovernanceFacade({ repository, now: () => '2026-10-14T15:00:00.000Z' });
  try { return await run({ root, filePath, repository, facade }); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function worker(root, filePath, startFile, operation, input) {
  const script = path.resolve('test/fixtures/transactional-governance-facade-worker.mjs');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, filePath, startFile, operation, JSON.stringify(input)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(`${stderr}\n${root}`)));
  });
}

test('first Plug atomically reserves cycle, pending profile, history and initial outbox', () => isolated(({ facade }) => {
  const result = facade.reserveAndCreatePendingProfile(reserveInput());
  const stored = facade.read();
  assert.equal(stored.revision, 1);
  assert.equal(result.cycle.state, 'RESERVED');
  assert.deepEqual(result.cycle.checkpoints, {
    profilePersisted: true, lifecycleTransitioned: false, ppuOutboxStored: true, closeRequested: false,
  });
  assert.equal(result.profile.status, 'PENDING_APPROVAL');
  assert.equal(result.profile.plugCycleStatus, 'RESERVED');
  assert.equal(stored.document.profileVersions.cpslai1[0].status, 'APPROVED');
  assert.equal(Object.keys(stored.document.ppuOutbox).length, 1);
  assert.equal(stored.document.history[0].plugCycleId, result.cycle.plugCycleId);
}));

test('same event and identity is a byte-stable NO_OP with no extra revision, history or outbox', () => isolated(({ filePath, facade }) => {
  const first = facade.reserveAndCreatePendingProfile(reserveInput());
  const before = fs.readFileSync(filePath, 'utf8');
  const counts = {
    history: facade.read().document.history.length,
    outbox: Object.keys(facade.read().document.ppuOutbox).length,
    versions: facade.read().document.profileVersions.cpslai1.length,
  };
  const retry = facade.reserveAndCreatePendingProfile(reserveInput());
  assert.equal(retry.idempotent, true);
  assert.equal(retry.cycle.plugCycleId, first.cycle.plugCycleId);
  assert.equal(facade.read().revision, 1);
  assert.equal(fs.readFileSync(filePath, 'utf8'), before);
  assert.deepEqual({
    history: facade.read().document.history.length,
    outbox: Object.keys(facade.read().document.ppuOutbox).length,
    versions: facade.read().document.profileVersions.cpslai1.length,
  }, counts);
}));

test('same event with divergent identity or cycle is an explicit conflict', () => isolated(({ facade }) => {
  const first = facade.reserveAndCreatePendingProfile(reserveInput());
  assert.throws(() => facade.reserveAndCreatePendingProfile(reserveInput({ identity: identity('urn:different') })), { code: 'GOVERNANCE_PLUG_IDENTITY_CONFLICT' });
  assert.throws(() => facade.reserveAndCreatePendingProfile(reserveInput({ plugCycleId: `${first.cycle.plugCycleId}-different` })), { code: 'GOVERNANCE_PLUG_IDENTITY_CONFLICT' });
  assert.equal(facade.read().revision, 1);
}));

test('different event is blocked by RESERVED, ACTIVE and FAILED cycles', () => isolated(({ facade }) => {
  const reserved = facade.reserveAndCreatePendingProfile(reserveInput());
  assert.throws(() => facade.reserveAndCreatePendingProfile(reserveInput({ plugEventId: 'different-reserved' })), { code: 'GOVERNANCE_ACTIVE_CYCLE_CONFLICT' });
  const active = facade.activateCycle({ ...exact(reserved), lifecycleEvidence: lifecycleEvidence() });
  assert.throws(() => facade.reserveAndCreatePendingProfile(reserveInput({ plugEventId: 'different-active' })), { code: 'GOVERNANCE_ACTIVE_CYCLE_CONFLICT' });
  facade.recordCycleFailure({ ...exact(active), stage: 'AFTER_LIFECYCLE', error: new Error('partial') });
  assert.throws(() => facade.reserveAndCreatePendingProfile(reserveInput({ plugEventId: 'different-failed' })), { code: 'GOVERNANCE_ACTIVE_CYCLE_CONFLICT' });
}));

test('RESERVED becomes ACTIVE only with accepted lifecycle evidence and activation retry is NO_OP', () => isolated(({ facade }) => {
  const reserved = facade.reserveAndCreatePendingProfile(reserveInput());
  assert.throws(() => facade.activateCycle({ ...exact(reserved), lifecycleEvidence: { accepted: false, transitionId: 'denied' } }), { code: 'GOVERNANCE_LIFECYCLE_EVIDENCE_REQUIRED' });
  assert.equal(facade.read().document.plugCycles[reserved.cycle.plugCycleId].state, 'RESERVED');
  const active = facade.activateCycle({ ...exact(reserved), lifecycleEvidence: lifecycleEvidence() });
  assert.equal(active.cycle.state, 'ACTIVE');
  assert.equal(active.cycle.checkpoints.lifecycleTransitioned, true);
  assert.equal(active.profile.plugCycleStatus, 'ACTIVE');
  const revision = facade.read().revision;
  const retry = facade.activateCycle({ ...exact(active), lifecycleEvidence: lifecycleEvidence() });
  assert.equal(retry.idempotent, true);
  assert.equal(facade.read().revision, revision);
  assert.throws(() => facade.activateCycle({ ...exact(active), lifecycleEvidence: lifecycleEvidence('different') }), { code: 'GOVERNANCE_ACTIVATION_EVIDENCE_CONFLICT' });
}));

test('failure after reservation is durable across restart and FAILED remains blocking', () => isolated(({ filePath, facade }) => {
  const reserved = facade.reserveAndCreatePendingProfile(reserveInput());
  facade.recordCycleFailure({ ...exact(reserved), stage: 'BEFORE_LIFECYCLE', error: Object.assign(new Error('transition unavailable'), { code: 'LIFECYCLE_UNAVAILABLE' }) });
  const restarted = new TransactionalGovernanceFacade({ repository: new GovernanceRepository({ filePath }) });
  const cycle = restarted.read().document.plugCycles[reserved.cycle.plugCycleId];
  assert.equal(cycle.state, 'FAILED');
  assert.equal(cycle.checkpoints.lifecycleTransitioned, false);
  assert.equal(cycle.failure.code, 'LIFECYCLE_UNAVAILABLE');
  assert.throws(() => restarted.reserveAndCreatePendingProfile(reserveInput({ plugEventId: 'new-after-failure' })), { code: 'GOVERNANCE_ACTIVE_CYCLE_CONFLICT' });
  assert.throws(() => restarted.closeCorrelatedCycle({ ...exact(reserved), unplugEvidence: unplugEvidence() }), { code: 'GOVERNANCE_CYCLE_STATE_CONFLICT' });
}));

test('correlated Unplug closes exact cycle/profile, preserves APPROVED, and retry is NO_OP', () => isolated(({ facade }) => {
  const reserved = facade.reserveAndCreatePendingProfile(reserveInput());
  const active = facade.activateCycle({ ...exact(reserved), lifecycleEvidence: lifecycleEvidence() });
  const approved = facade.approveProfile({ ...exact(active), actor: human() });
  assert.equal(approved.profile.status, 'APPROVED');
  const revisionBeforeClose = facade.read().revision;
  const closed = facade.closeCorrelatedCycle({ ...exact(active), unplugEvidence: unplugEvidence() });
  assert.equal(closed.cycle.state, 'CLOSED');
  assert.equal(closed.cycle.checkpoints.closeRequested, true);
  assert.equal(closed.profile.plugCycleStatus, 'CLOSED');
  assert.equal(closed.profile.status, 'APPROVED');
  assert.equal(facade.read().revision, revisionBeforeClose + 1);
  const retryRevision = facade.read().revision;
  assert.equal(facade.closeCorrelatedCycle({ ...exact(active), unplugEvidence: unplugEvidence() }).idempotent, true);
  assert.equal(facade.read().revision, retryRevision);
}));

test('late Unplug cannot close replug cycle and CLOSED allows new pending profile', () => isolated(({ facade }) => {
  const first = facade.reserveAndCreatePendingProfile(reserveInput());
  const active = facade.activateCycle({ ...exact(first), lifecycleEvidence: lifecycleEvidence() });
  facade.closeCorrelatedCycle({ ...exact(active), unplugEvidence: unplugEvidence() });
  const second = facade.reserveAndCreatePendingProfile(reserveInput({ plugEventId: 'plug-event-b3-2', identity: identity('urn:test:cpslai1:aas:v2', '2') }));
  assert.notEqual(second.profile.profileId, first.profile.profileId);
  assert.equal(second.profile.status, 'PENDING_APPROVAL');
  assert.equal(facade.closeCorrelatedCycle({ ...exact(first), unplugEvidence: unplugEvidence() }).idempotent, true);
  assert.equal(facade.read().document.plugCycles[second.cycle.plugCycleId].state, 'RESERVED');
  assert.throws(() => facade.closeCorrelatedCycle({ ...exact(first), unplugEvidence: unplugEvidence('late-different') }), { code: 'GOVERNANCE_CLOSE_EVIDENCE_CONFLICT' });
}));

test('approval, rejection and policy update require the expected ACTIVE cycle', () => isolated(({ facade }) => {
  const first = facade.reserveAndCreatePendingProfile(reserveInput());
  assert.throws(() => facade.approveProfile({ ...exact(first), actor: human() }), { code: 'GOVERNANCE_PROFILE_NOT_ACTIVE' });
  const active = facade.activateCycle({ ...exact(first), lifecycleEvidence: lifecycleEvidence() });
  assert.throws(() => facade.updatePolicies({
    ...exact(active), profileId: 'obsolete', actor: human(),
    policies: { governableActions: [{ action: 'ADJUST_TRANSPORT_SPEED', autonomousLimit: 5, humanApprovalLimit: 15 }] },
  }), { code: 'GOVERNANCE_PROFILE_IDENTITY_CONFLICT' });
  const denied = facade.rejectProfile({ ...exact(active), actor: human('rejector') });
  assert.throws(() => facade.approveProfile({ ...exact(active), actor: human('approver') }), { code: 'GOVERNANCE_PROFILE_NOT_PENDING' });
  const closed = facade.closeCorrelatedCycle({ ...exact(active), unplugEvidence: unplugEvidence() });
  assert.equal(denied.profile.status, 'DENIED');
  assert.equal(closed.profile.status, 'DENIED');
}));

test('two processes retrying same event create one revision, history entry, profile and outbox event', () => isolated(async ({ root, filePath, facade }) => {
  const start = path.join(root, 'start');
  const input = reserveInput();
  const tasks = [worker(root, filePath, start, 'reserveCycle', input), worker(root, filePath, start, 'reserveCycle', input)];
  fs.writeFileSync(start, 'go');
  const results = await Promise.all(tasks);
  assert.equal(results.every((item) => item.ok), true);
  assert.equal(results.filter((item) => item.result.created).length, 1);
  assert.equal(results[0].result.cycle.plugCycleId, results[1].result.cycle.plugCycleId);
  const stored = facade.read();
  assert.equal(stored.revision, 1);
  assert.equal(Object.keys(stored.document.plugCycles).length, 1);
  assert.equal(stored.document.profileVersions.cpslai1.length, 2);
  assert.equal(stored.document.history.length, 2);
  assert.equal(Object.keys(stored.document.ppuOutbox).length, 1);
}));

test('two processes with different events cannot create competing cycles', () => isolated(async ({ root, filePath, facade }) => {
  const start = path.join(root, 'start');
  const tasks = [
    worker(root, filePath, start, 'reserveCycle', reserveInput({ plugEventId: 'event-process-a' })),
    worker(root, filePath, start, 'reserveCycle', reserveInput({ plugEventId: 'event-process-b' })),
  ];
  fs.writeFileSync(start, 'go');
  const results = await Promise.all(tasks);
  assert.equal(results.filter((item) => item.ok).length, 1);
  assert.equal(results.filter((item) => item.code === 'GOVERNANCE_ACTIVE_CYCLE_CONFLICT').length, 1);
  assert.equal(facade.read().revision, 1);
  assert.equal(Object.keys(facade.read().document.plugCycles).length, 1);
}));

test('persistence failure before commit leaves no cycle, profile, history or outbox addition', () => isolated(({ filePath }) => {
  const before = fs.readFileSync(filePath, 'utf8');
  const repository = new GovernanceRepository({ filePath, faultInjector(stage) { if (stage === 'beforeRename') throw new Error('simulated'); } });
  const facade = new TransactionalGovernanceFacade({ repository });
  assert.throws(() => facade.reserveAndCreatePendingProfile(reserveInput()), { code: 'GOVERNANCE_WRITE_FAILED' });
  assert.equal(fs.readFileSync(filePath, 'utf8'), before);
}));

test('legacy records remain byte-logically intact after transactional cycle lifecycle', () => isolated(({ facade }) => {
  const legacy = structuredClone(facade.read().document.profileVersions.cpslai1[0]);
  const reserved = facade.reserveAndCreatePendingProfile(reserveInput());
  const active = facade.activateCycle({ ...exact(reserved), lifecycleEvidence: lifecycleEvidence() });
  facade.closeCorrelatedCycle({ ...exact(active), unplugEvidence: unplugEvidence() });
  assert.deepEqual(facade.read().document.profileVersions.cpslai1[0], legacy);
}));
