import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { GovernanceRepository } from '../lib/governance/governanceRepository.mjs';
import { TransactionalGovernanceFacade } from '../lib/governance/transactionalGovernanceFacade.mjs';
import { TransactionalGovernanceAdapters, translateGovernanceAdapterError } from '../lib/governance/transactionalGovernanceAdapters.mjs';

const fixture = path.resolve('test/fixtures/governance-repository/current-valid.json');
const auth = (subject = 'operator-b4') => ({ authenticated: true, authorized: true, trusted: true, subject });
const request = (event = 'plug-b4-1') => ({
  cpsId: 'cpslai1', cps: { id: 'cpslai1' }, plugEventId: event,
  identity: { aasId: 'urn:test:b4:cpslai1', assetId: 'asset-b4', functionalVersion: '1' },
});
const ids = (value) => ({ cpsId: value.cycle.cpsId, plugEventId: value.cycle.plugEventId, plugCycleId: value.cycle.plugCycleId, profileId: value.profile.profileId });
const lifecycle = { accepted: true, transitionId: 'lifecycle-b4-1', source: 'ISOLATED_TEST' };
const unplug = { accepted: true, transitionId: 'unplug-b4-1', source: 'ISOLATED_TEST' };

async function isolated(run, repositoryOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acsm-governance-adapters-'));
  const filePath = path.join(root, 'governance.json');
  fs.copyFileSync(fixture, filePath);
  const repository = new GovernanceRepository({ filePath, ...repositoryOptions });
  const facade = new TransactionalGovernanceFacade({ repository, now: () => '2026-10-14T18:00:00.000Z' });
  const adapters = new TransactionalGovernanceAdapters({ facade });
  try { return await run({ root, filePath, repository, facade, adapters }); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function worker(filePath, startFile, operation, input) {
  const script = path.resolve('test/fixtures/transactional-governance-facade-worker.mjs');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, filePath, startFile, operation, JSON.stringify(input)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
  });
}

function active(adapters, input = request()) {
  const reserved = adapters.reservePlug(input);
  const activated = adapters.activatePlug({ ...ids(reserved), lifecycleEvidence: lifecycle });
  return activated;
}

test('Plug adapter reserves pending profile and retry is a write-free compatible response', () => isolated(({ adapters, facade, filePath }) => {
  const first = adapters.reservePlug(request());
  assert.equal(first.governanceStatus, 'PENDING_APPROVAL');
  assert.equal(first.lifecycleEffectRequired, true);
  assert.equal(first.plugEventId, request().plugEventId);
  assert.equal(first.plugCycleId, first.cycle.plugCycleId);
  assert.equal(first.profileId, first.profile.profileId);
  const revision = facade.read().revision;
  const bytes = fs.readFileSync(filePath, 'utf8');
  const retry = adapters.reservePlug(request());
  assert.equal(retry.idempotent, true);
  assert.equal(retry.lifecycleEffectRequired, false);
  assert.equal(facade.read().revision, revision);
  assert.equal(fs.readFileSync(filePath, 'utf8'), bytes);
  assert.throws(() => adapters.reservePlug(request('plug-b4-other')), { code: 'GOVERNANCE_ACTIVE_CYCLE_CONFLICT' });
}));

test('activation requires correlated accepted evidence and performs no external call', () => isolated(({ adapters }) => {
  let externalCalls = 0;
  const reserved = adapters.reservePlug(request());
  assert.throws(() => adapters.activatePlug({ ...ids(reserved), lifecycleEvidence: { accepted: false, transitionId: 'x' } }), { code: 'GOVERNANCE_LIFECYCLE_EVIDENCE_REQUIRED' });
  const result = adapters.activatePlug({ ...ids(reserved), lifecycleEvidence: lifecycle });
  assert.equal(result.cycle.state, 'ACTIVE');
  assert.equal(externalCalls, 0);
}));

test('human decisions require trusted server authorization and exact current identities', () => isolated(({ adapters }) => {
  const current = active(adapters);
  assert.throws(() => adapters.approveProfile({ ...ids(current), authorization: { actorType: 'HUMAN', subject: 'spoofed' } }), { code: 'GOVERNANCE_SERVER_AUTHORIZATION_REQUIRED' });
  assert.throws(() => adapters.approveProfile({ ...ids(current), profileId: 'obsolete', authorization: auth() }), { code: 'GOVERNANCE_PROFILE_IDENTITY_CONFLICT' });
  const approved = adapters.approveProfile({ ...ids(current), authorization: auth('alice') });
  assert.equal(approved.governanceStatus, 'APPROVED');
  assert.equal(approved.profile.approvedBy, 'alice');
  assert.throws(() => adapters.rejectProfile({ ...ids(current), authorization: auth('bob') }), { code: 'GOVERNANCE_PROFILE_NOT_PENDING' });
}));

test('rejection and policies preserve pending-only and active-cycle constraints', () => isolated(({ adapters }) => {
  const current = active(adapters);
  const changed = adapters.updatePolicies({
    ...ids(current), authorization: auth(),
    policies: { governableActions: [{ action: 'ADJUST_TRANSPORT_SPEED', autonomousLimit: 5, humanApprovalLimit: 15 }] },
  });
  assert.equal(changed.profile.status, 'PENDING_APPROVAL');
  const denied = adapters.rejectProfile({ ...ids(current), authorization: auth('reviewer') });
  assert.equal(denied.profile.status, 'DENIED');
  assert.throws(() => adapters.updatePolicies({
    ...ids(current), authorization: auth(),
    policies: { governableActions: [{ action: 'ADJUST_TRANSPORT_SPEED', autonomousLimit: 6, humanApprovalLimit: 16 }] },
  }), { code: 'GOVERNANCE_PROFILE_NOT_EDITABLE' });
}));

test('governed action persists decision and effect intent but executes nothing', () => isolated(({ adapters }) => {
  let executions = 0;
  const current = active(adapters);
  adapters.approveProfile({ ...ids(current), authorization: auth() });
  const created = adapters.createGovernedAction({
    ...ids(current), actionId: 'GA-B4-1', action: 'ADJUST_TRANSPORT_SPEED', requestedValue: 12, variation: 12,
  });
  const decision = adapters.decideGovernedAction({
    actionId: created.action.actionId, ...ids(current), decision: 'APPROVED', authorization: auth('action-reviewer'),
  });
  assert.equal(decision.action.executionStatus, 'PENDING_EXECUTION');
  assert.equal(decision.effects[0].type, 'GOVERNED_ACTION_EXECUTION');
  assert.equal(executions, 0);
  assert.throws(() => adapters.decideGovernedAction({
    actionId: created.action.actionId, ...ids(current), plugCycleId: 'old-cycle', decision: 'REJECTED', authorization: auth(),
  }), { code: 'GOVERNANCE_ACTION_IDENTITY_CONFLICT' });
}));

test('outbox acknowledgements are correlated and idempotent without publishing', () => isolated(({ adapters, facade }) => {
  const reserved = adapters.reservePlug(request());
  const eventId = reserved.outbox.entry.eventId;
  const failed = adapters.markOutboxFailed(eventId, new Error('broker unavailable'), { attemptId: 'attempt-1', retryDelayMs: 1 });
  const revision = facade.read().revision;
  const repeatedFailure = adapters.markOutboxFailed(eventId, new Error('broker unavailable'), { attemptId: 'attempt-1', retryDelayMs: 1 });
  assert.equal(repeatedFailure.idempotent, true);
  assert.equal(facade.read().revision, revision);
  const published = adapters.markOutboxPublished(eventId, { publicationId: 'publication-1' });
  assert.equal(published.entry.status, 'PUBLISHED');
  const publishedRevision = facade.read().revision;
  assert.equal(adapters.markOutboxPublished(eventId, { publicationId: 'publication-1' }).idempotent, true);
  assert.equal(facade.read().revision, publishedRevision);
  assert.throws(() => adapters.markOutboxFailed(eventId, new Error('late'), { attemptId: 'attempt-2' }), { code: 'PPU_OUTBOX_ALREADY_PUBLISHED' });
  assert.equal(failed.entry.lastFailureAttemptId, 'attempt-1');
}));

test('Unplug preparation and close require complete correlated identity and accepted evidence', () => isolated(({ adapters }) => {
  const current = active(adapters);
  const prepared = adapters.prepareUnplug(ids(current));
  assert.equal(prepared.validated, true);
  assert.deepEqual(prepared.effects, []);
  assert.throws(() => adapters.prepareUnplug({ ...ids(current), profileId: 'stale' }), { code: 'GOVERNANCE_UNPLUG_IDENTITY_CONFLICT' });
  assert.throws(() => adapters.closeUnplug({ ...ids(current), unplugEvidence: { accepted: false, transitionId: 'no' } }), { code: 'GOVERNANCE_UNPLUG_EVIDENCE_REQUIRED' });
  const closed = adapters.closeUnplug({ ...ids(current), unplugEvidence: unplug });
  assert.equal(closed.cycle.state, 'CLOSED');
  const replug = adapters.reservePlug({ ...request('plug-b4-2'), identity: { ...request().identity, functionalVersion: '2' } });
  assert.equal(replug.profile.status, 'PENDING_APPROVAL');
  assert.throws(() => adapters.closeUnplug({ ...ids(current), unplugEvidence: { ...unplug, transitionId: 'late' } }), { code: 'GOVERNANCE_CLOSE_EVIDENCE_CONFLICT' });
}));

test('Play projection requires correlated ACTIVE cycle, APPROVED profile and compatible phase', () => isolated(({ adapters }) => {
  const current = active(adapters);
  assert.equal(adapters.projectPlayGate({ ...ids(current), lifecyclePhase: 'play' }).reason, 'GOVERNANCE_APPROVAL_REQUIRED');
  adapters.approveProfile({ ...ids(current), authorization: auth() });
  assert.equal(adapters.projectPlayGate({ ...ids(current), lifecyclePhase: 'plug' }).reason, 'LIFECYCLE_PHASE_INCOMPATIBLE');
  const passed = adapters.projectPlayGate({ ...ids(current), lifecyclePhase: 'play' });
  assert.equal(passed.ok, true);
  assert.equal(passed.cycleActive, true);
  assert.equal(adapters.projectPlayGate({ ...ids(current), profileId: 'old', lifecyclePhase: 'play' }).reason, 'GOVERNANCE_IDENTITY_CONFLICT');
}));

test('reservation survives restart between commits and can be activated later', () => isolated(({ filePath, adapters }) => {
  const reserved = adapters.reservePlug(request());
  const restartedFacade = new TransactionalGovernanceFacade({ repository: new GovernanceRepository({ filePath }) });
  const restarted = new TransactionalGovernanceAdapters({ facade: restartedFacade });
  assert.equal(restarted.projectPlayGate({ ...ids(reserved), lifecyclePhase: 'play' }).cycleState, 'RESERVED');
  assert.equal(restarted.activatePlug({ ...ids(reserved), lifecycleEvidence: lifecycle }).cycle.state, 'ACTIVE');
}));

test('two adapter processes preserve one cycle for same event', () => isolated(async ({ root, filePath, facade }) => {
  const start = path.join(root, 'start');
  const jobs = [worker(filePath, start, 'adapterReserve', request()), worker(filePath, start, 'adapterReserve', request())];
  fs.writeFileSync(start, 'go');
  const results = await Promise.all(jobs);
  assert.equal(results.every((item) => item.ok), true);
  assert.equal(results.filter((item) => item.result.created).length, 1);
  assert.equal(facade.read().revision, 1);
  assert.equal(Object.keys(facade.read().document.plugCycles).length, 1);
}));

test('persistence failure is exposed without partial adapter state', () => isolated(({ filePath }) => {
  const before = fs.readFileSync(filePath, 'utf8');
  const repository = new GovernanceRepository({ filePath, faultInjector(stage) { if (stage === 'beforeRename') throw new Error('simulated'); } });
  const adapters = new TransactionalGovernanceAdapters({ facade: new TransactionalGovernanceFacade({ repository }) });
  assert.throws(() => adapters.reservePlug(request()), { code: 'GOVERNANCE_WRITE_FAILED' });
  assert.equal(fs.readFileSync(filePath, 'utf8'), before);
}));

test('legacy-shaped reads and error translation remain available without fabricating identities', () => isolated(({ adapters }) => {
  const legacy = adapters.getProfile('cpslai1');
  assert.equal(Array.isArray(legacy.profiles), true);
  assert.equal(legacy.profiles[0].status, 'APPROVED');
  const translated = translateGovernanceAdapterError(Object.assign(new Error('conflict'), { code: 'GOVERNANCE_ACTIVE_CYCLE_CONFLICT' }));
  assert.equal(translated.status, 409);
  assert.equal(translated.details.code, 'GOVERNANCE_ACTIVE_CYCLE_CONFLICT');
}));

test('adapter source has no operational Store, filesystem or external-effect dependency', () => {
  const source = fs.readFileSync(path.resolve('lib/governance/transactionalGovernanceAdapters.mjs'), 'utf8');
  for (const forbidden of ['governanceStore', 'node:fs', 'mqtt', 'axios', 'fetch(', 'executeAcsmUnplug', 'transitionPlugAssetLifecycle', 'evolution']) {
    assert.equal(source.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
  }
});
