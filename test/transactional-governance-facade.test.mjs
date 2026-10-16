import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { GovernanceRepository } from '../lib/governance/governanceRepository.mjs';
import { TransactionalGovernanceFacade } from '../lib/governance/transactionalGovernanceFacade.mjs';
import { buildPpuEvent } from '../lib/acsm/ppuEventBuilder.mjs';

const fixtures = path.resolve('test/fixtures/governance-repository');
const human = (id = 'operator-test') => ({ id, type: 'HUMAN' });
const profileIdentity = (profile) => ({ cpsId: profile.cpsId, profileId: profile.profileId, plugCycleId: profile.plugCycleId });
const ppuEvent = (eventId = 'ppu:cpslai1:plug:isolated:requested') => buildPpuEvent({
  eventId, correlationId: 'isolated-cycle', cpsId: 'cpslai1', operation: 'PLUG', result: 'REQUESTED',
  occurredAt: '2026-10-14T12:00:00.000Z', source: 'ACSM', evidence: { scope: 'ISOLATED_TEST' },
});

async function isolated(run, fixtureName = 'current-valid.json', repositoryOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acsm-governance-facade-'));
  const filePath = path.join(root, 'governance.json');
  fs.copyFileSync(path.join(fixtures, fixtureName), filePath);
  const repository = new GovernanceRepository({ filePath, ...repositoryOptions });
  const facade = new TransactionalGovernanceFacade({ repository, now: () => '2026-10-14T12:00:00.000Z' });
  try { return await run({ root, filePath, repository, facade }); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function createPending(facade, cpsId = 'cpslai1', suffix = 'new') {
  return facade.createPendingProfile({
    cpsId, cps: { id: cpsId }, plugEventId: `${cpsId}-event-${suffix}`, plugCycleId: `${cpsId}-cycle-${suffix}`,
  }).profile;
}

function worker(root, filePath, startFile, operation, input) {
  const script = path.resolve('test/fixtures/transactional-governance-facade-worker.mjs');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, filePath, startFile, operation, JSON.stringify(input)], {
      cwd: path.resolve('.'), stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(`${stderr}\n${root}`)));
  });
}

test('creates a new PENDING_APPROVAL profile without inheriting approval and preserves history', () => isolated(({ facade }) => {
  const profile = createPending(facade);
  assert.equal(profile.status, 'PENDING_APPROVAL');
  assert.equal(profile.approvedAt, null);
  assert.equal(profile.approvedBy, null);
  assert.equal(profile.previousProfileId, 'gov-cpslai1-v2');
  const stored = facade.read().document;
  assert.equal(stored.profileVersions.cpslai1.length, 2);
  assert.equal(stored.profileVersions.cpslai1[0].status, 'APPROVED');
  assert.equal(stored.history[0].eventType, 'GOVERNANCE_PLUG_CYCLE_OPENED');
}));

test('same Plug identity is idempotent and different identity cannot replace active profile', () => isolated(({ facade }) => {
  const first = createPending(facade);
  const retry = facade.createPendingProfile({ cpsId: 'cpslai1', cps: { id: 'cpslai1' }, plugEventId: first.plugEventId, plugCycleId: first.plugCycleId });
  assert.equal(retry.profile.profileId, first.profileId);
  assert.equal(retry.idempotent, true);
  assert.throws(() => createPending(facade, 'cpslai1', 'other'), { code: 'GOVERNANCE_ACTIVE_CYCLE_CONFLICT' });
}));

test('updates policies only on the exact pending active profile', () => isolated(({ facade }) => {
  const profile = createPending(facade);
  const updated = facade.updatePolicies({
    ...profileIdentity(profile), actor: human(),
    policies: { governableActions: [{ action: 'ADJUST_TRANSPORT_SPEED', autonomousLimit: 7, humanApprovalLimit: 17 }] },
  }).profile;
  assert.equal(updated.policies.governableActions[0].autonomousLimit, 7);
  assert.equal(updated.status, 'PENDING_APPROVAL');
  assert.throws(() => facade.updatePolicies({
    cpsId: profile.cpsId, profileId: 'wrong', plugCycleId: profile.plugCycleId, actor: human(),
    policies: { governableActions: [{ action: 'ADJUST_TRANSPORT_SPEED', autonomousLimit: 8, humanApprovalLimit: 18 }] },
  }), { code: 'GOVERNANCE_PROFILE_IDENTITY_CONFLICT' });
}));

test('approval and rejection require explicit HUMAN actor and exact profile/cycle', () => isolated(({ facade }) => {
  const approvedCandidate = createPending(facade, 'cpslai1', 'approve');
  assert.throws(() => facade.approveProfile({ ...profileIdentity(approvedCandidate), actor: { id: 'observer', type: 'SYSTEM' } }), { code: 'GOVERNANCE_HUMAN_ACTOR_REQUIRED' });
  const approved = facade.approveProfile({ ...profileIdentity(approvedCandidate), actor: human('alice') });
  assert.equal(approved.profile.status, 'APPROVED');
  assert.equal(approved.profile.approvedBy, 'alice');
  assert.equal(approved.outbox.entry.status, 'PENDING');
  facade.closeProfile({ ...profileIdentity(approved.profile), evidence: { transitionId: 'unplug-a' } });
  const rejectedCandidate = createPending(facade, 'cpslai1', 'reject');
  const rejected = facade.rejectProfile({ ...profileIdentity(rejectedCandidate), actor: human('bob') });
  assert.equal(rejected.profile.status, 'DENIED');
  assert.equal(rejected.profile.rejectedBy, 'bob');
  assert.throws(() => facade.approveProfile({ ...profileIdentity(rejected.profile), actor: human('alice') }), { code: 'GOVERNANCE_PROFILE_NOT_PENDING' });
}));

test('close targets the exact profile/cycle and never changes approval status', () => isolated(({ facade }) => {
  const pending = createPending(facade);
  assert.throws(() => facade.closeProfile({ ...profileIdentity(pending), plugCycleId: 'wrong', evidence: { verified: true } }), { code: 'GOVERNANCE_PROFILE_IDENTITY_CONFLICT' });
  const closed = facade.closeProfile({ ...profileIdentity(pending), evidence: { transitionId: 'unplug-1' } }).profile;
  assert.equal(closed.plugCycleStatus, 'CLOSED');
  assert.equal(closed.status, 'PENDING_APPROVAL');
}));

test('records history, prepares pending action and decision without executing external effect', () => isolated(({ facade }) => {
  const pending = createPending(facade);
  const approved = facade.approveProfile({ ...profileIdentity(pending), actor: human() }).profile;
  const action = facade.createPendingAction({
    ...profileIdentity(approved), action: 'ADJUST_TRANSPORT_SPEED', requestedValue: 12, variation: 12,
  }).action;
  assert.equal(action.status, 'PENDING_HUMAN_APPROVAL');
  const decision = facade.decideAction({ actionId: action.actionId, decision: 'APPROVED', actor: human('decision-maker') });
  assert.equal(decision.action.executionStatus, 'PENDING_EXECUTION');
  assert.equal(decision.effects[0].type, 'GOVERNED_ACTION_EXECUTION');
  assert.equal(decision.action.executionResult, null);
  const extra = facade.recordHistory({ eventType: 'ISOLATED_AUDIT', cpsId: 'cpslai1' });
  assert.equal(extra.entry.eventType, 'ISOLATED_AUDIT');
}));

test('enqueues and updates PPU outbox without publishing', () => isolated(({ facade }) => {
  const queued = facade.enqueueOutbox(ppuEvent());
  assert.equal(queued.entry.status, 'PENDING');
  const failed = facade.markOutboxFailed(queued.entry.eventId, new Error('simulated publish failure'), { retryDelayMs: 1000 });
  assert.equal(failed.entry.status, 'FAILED');
  const published = facade.markOutboxPublished(queued.entry.eventId);
  assert.equal(published.entry.status, 'PUBLISHED');
  assert.equal(published.entry.attempts, 2);
}));

test('revisions are monotonic and stale expected revision is rejected', () => isolated(({ facade }) => {
  assert.equal(facade.read().revision, 0);
  facade.recordHistory({ eventType: 'ONE' }, { expectedRevision: 0 });
  assert.equal(facade.read().revision, 1);
  assert.throws(() => facade.recordHistory({ eventType: 'STALE' }, { expectedRevision: 0 }), { code: 'GOVERNANCE_REVISION_CONFLICT' });
  assert.equal(facade.read().revision, 1);
}));

test('policy update concurrent with outbox preserves both writes', () => isolated(async ({ root, filePath, facade }) => {
  const profile = createPending(facade);
  const start = path.join(root, 'start');
  const tasks = [
    worker(root, filePath, start, 'updatePolicies', {
      ...profileIdentity(profile), actor: human('policy-writer'),
      policies: { governableActions: [{ action: 'ADJUST_TRANSPORT_SPEED', autonomousLimit: 6, humanApprovalLimit: 16 }] },
    }),
    worker(root, filePath, start, 'outbox', ppuEvent('ppu:cpslai1:plug:concurrent:requested')),
  ];
  fs.writeFileSync(start, 'go');
  const results = await Promise.all(tasks);
  assert.equal(results.every((item) => item.ok), true);
  const stored = facade.read().document;
  assert.equal(stored.profiles.cpslai1.policies.governableActions[0].autonomousLimit, 6);
  assert.equal(stored.ppuOutbox['ppu:cpslai1:plug:concurrent:requested'].status, 'PENDING');
}));

test('concurrent approval and rejection yield exactly one decision', () => isolated(async ({ root, filePath, facade }) => {
  const profile = createPending(facade);
  const start = path.join(root, 'start');
  const input = profileIdentity(profile);
  const tasks = [
    worker(root, filePath, start, 'approve', { ...input, actor: human('approver') }),
    worker(root, filePath, start, 'reject', { ...input, actor: human('rejector') }),
  ];
  fs.writeFileSync(start, 'go');
  const results = await Promise.all(tasks);
  assert.equal(results.filter((item) => item.ok).length, 1);
  assert.equal(results.filter((item) => item.code === 'GOVERNANCE_PROFILE_NOT_PENDING').length, 1);
  assert.ok(['APPROVED', 'DENIED'].includes(facade.read().document.profiles.cpslai1.status));
}));

test('history write concurrent with action decision preserves both', () => isolated(async ({ root, filePath, facade }) => {
  const pending = createPending(facade);
  const approved = facade.approveProfile({ ...profileIdentity(pending), actor: human() }).profile;
  const action = facade.createPendingAction({ ...profileIdentity(approved), action: 'ADJUST_TRANSPORT_SPEED', requestedValue: 12, variation: 12 }).action;
  const start = path.join(root, 'start');
  const tasks = [
    worker(root, filePath, start, 'history', { eventType: 'CONCURRENT_AUDIT', cpsId: 'cpslai1' }),
    worker(root, filePath, start, 'decideAction', { actionId: action.actionId, decision: 'REJECTED', actor: human('reviewer') }),
  ];
  fs.writeFileSync(start, 'go');
  assert.equal((await Promise.all(tasks)).every((item) => item.ok), true);
  const stored = facade.read().document;
  assert.equal(stored.pendingActions[action.actionId].status, 'REJECTED');
  assert.equal(stored.history.some((entry) => entry.eventType === 'CONCURRENT_AUDIT'), true);
}));

test('two distinct outbox events and CPS writers are preserved across processes', () => isolated(async ({ root, filePath, facade }) => {
  const start = path.join(root, 'start');
  const eventA = ppuEvent('ppu:cpslai1:plug:outbox-a:requested');
  const eventB = ppuEvent('ppu:cpslai1:plug:outbox-b:requested');
  const tasks = [
    worker(root, filePath, start, 'outbox', eventA),
    worker(root, filePath, start, 'outbox', eventB),
    worker(root, filePath, start, 'createProfile', { cpsId: 'cpslai2', cps: { id: 'cpslai2' }, plugEventId: 'cpslai2-event', plugCycleId: 'cpslai2-cycle' }),
    worker(root, filePath, start, 'createProfile', { cpsId: 'cpslai3', cps: { id: 'cpslai3' }, plugEventId: 'cpslai3-event', plugCycleId: 'cpslai3-cycle' }),
  ];
  fs.writeFileSync(start, 'go');
  assert.equal((await Promise.all(tasks)).every((item) => item.ok), true);
  const stored = facade.read().document;
  assert.equal(Boolean(stored.ppuOutbox[eventA.eventId] && stored.ppuOutbox[eventB.eventId]), true);
  assert.equal(stored.profiles.cpslai2.status, 'PENDING_APPROVAL');
  assert.equal(stored.profiles.cpslai3.status, 'PENDING_APPROVAL');
}));

test('failure before commit preserves the confirmed store', () => isolated(({ filePath }) => {
  const before = fs.readFileSync(filePath, 'utf8');
  const repository = new GovernanceRepository({ filePath, faultInjector(stage) { if (stage === 'beforeRename') throw new Error('injected'); } });
  const facade = new TransactionalGovernanceFacade({ repository });
  assert.throws(() => facade.recordHistory({ eventType: 'MUST_NOT_COMMIT' }), { code: 'GOVERNANCE_WRITE_FAILED' });
  assert.equal(fs.readFileSync(filePath, 'utf8'), before);
}));

test('invalid JSON fails closed through the facade', () => isolated(({ facade }) => {
  assert.throws(() => facade.read(), { code: 'GOVERNANCE_JSON_INVALID' });
}, 'invalid-truncated.json'));

test('preserves legacy versions without IDs and does not fabricate them', () => isolated(({ facade }) => {
  const before = clone(facade.read().document.profileVersions);
  facade.recordHistory({ eventType: 'ISOLATED_ONLY' });
  const after = facade.read().document.profileVersions;
  assert.deepEqual(after, before);
  assert.equal('plugEventId' in after.cps1[0], false);
  assert.equal('plugCycleId' in after.cps1[0], false);
}, 'historical-missing-ids.json'));

test('facade has no filesystem, operational store, Evolution or external-effect dependency', () => {
  const source = fs.readFileSync(path.resolve('lib/governance/transactionalGovernanceFacade.mjs'), 'utf8');
  assert.doesNotMatch(source, /node:fs|writeFile|rename|governanceStore|evolutionStore|plugEvolution|\bfetch\s*\(|MQTT|OPC\s*UA|mysql|node-red|executeGovernedAction|child_process/i);
});

function clone(value) { return structuredClone(value); }
