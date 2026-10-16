import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { GovernanceMigrationPlanner } from '../lib/governance/governanceMigration.mjs';
import { GovernanceCutoverSimulator } from '../lib/governance/governanceCutoverSimulator.mjs';
import { GovernanceRepository } from '../lib/governance/governanceRepository.mjs';
import { TransactionalGovernanceFacade } from '../lib/governance/transactionalGovernanceFacade.mjs';
import { TransactionalGovernanceAdapters } from '../lib/governance/transactionalGovernanceAdapters.mjs';
import { LEGACY_GOVERNANCE_ACCESS_INVENTORY } from '../lib/governance/legacyGovernanceInventory.mjs';

const baseLegacy = () => ({
  profiles: {
    cpslai1: {
      profileId: 'gov-cpslai1-v3', profileVersion: 3, status: 'APPROVED', plugCycleStatus: 'ACTIVE',
      plugEventId: 'legacy-plug-3', plugCycleId: 'legacy-cycle-3', plugStartedAt: '2026-10-10T10:00:00.000Z',
      approvedAt: '2026-10-10T10:10:00.000Z', approvedBy: 'operator-existing',
    },
  },
  profileVersions: {
    cpslai1: [
      { profileVersion: 1, status: 'DENIED', plugCycleStatus: 'CLOSED', rejectedBy: 'operator-old' },
      { profileId: 'gov-cpslai1-v2', profileVersion: 2, status: 'APPROVED', plugCycleStatus: 'CLOSED', plugCycleId: 'legacy-cycle-2' },
      {
        profileId: 'gov-cpslai1-v3', profileVersion: 3, status: 'APPROVED', plugCycleStatus: 'ACTIVE',
        plugEventId: 'legacy-plug-3', plugCycleId: 'legacy-cycle-3', plugStartedAt: '2026-10-10T10:00:00.000Z',
        approvedAt: '2026-10-10T10:10:00.000Z', approvedBy: 'operator-existing',
      },
    ],
  },
  pendingActions: { 'GA-009': { actionId: 'GA-009', status: 'PENDING_HUMAN_APPROVAL', cpsId: 'cpslai1' } },
  history: [{ id: 'legacy-history', eventType: 'GOVERNANCE_PROFILE_APPROVED', profileId: 'gov-cpslai1-v3' }],
  ppuOutbox: { 'legacy-event': { eventId: 'legacy-event', status: 'PENDING', payload: { preserve: true } } },
  customLegacy: { untouched: true },
});

const evidence = (overrides = {}) => ({
  cpslai1: {
    cpsId: 'cpslai1', plugEventId: 'legacy-plug-3', plugCycleId: 'legacy-cycle-3', profileId: 'gov-cpslai1-v3',
    identity: { aasId: 'urn:legacy:cpslai1:aas', assetId: 'asset-cpslai1' }, state: 'ACTIVE',
    lifecycleEvidence: { accepted: true, transitionId: 'verified-legacy-transition', source: 'SANITIZED_FIXTURE' },
    reservedAt: '2026-10-10T10:00:00.000Z', activatedAt: '2026-10-10T10:00:00.000Z',
    ...overrides,
  },
});

async function isolated(run, document = baseLegacy()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acsm-governance-cutover-'));
  const sourcePath = path.join(root, 'legacy-source.json');
  const destinationPath = path.join(root, 'candidate.json');
  fs.writeFileSync(sourcePath, `${JSON.stringify(document, null, 2)}\n`);
  const planner = new GovernanceMigrationPlanner();
  try { return await run({ root, sourcePath, destinationPath, planner, document }); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function execute(root, sourcePath, destinationPath, planner, options = {}) {
  return new GovernanceCutoverSimulator({ workspaceRoot: root, planner, ...options }).execute({
    sourcePath, destinationPath, activeCycleEvidence: evidence(), writerSuspended: true,
  });
}

function worker(root, sourcePath, destinationPath, startPath) {
  const script = path.resolve('test/fixtures/governance-cutover-worker.mjs');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, root, sourcePath, destinationPath, startPath, JSON.stringify(evidence())], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
  });
}

test('prevalidation creates one correlated active cycle and preserves every legacy collection', () => isolated(({ sourcePath, planner, document }) => {
  const result = planner.prevalidate({ sourcePath, activeCycleEvidence: evidence() });
  assert.deepEqual(result.candidate.profiles, document.profiles);
  assert.deepEqual(result.candidate.profileVersions, document.profileVersions);
  assert.deepEqual(result.candidate.pendingActions, document.pendingActions);
  assert.deepEqual(result.candidate.history, document.history);
  assert.deepEqual(result.candidate.ppuOutbox, document.ppuOutbox);
  assert.deepEqual(result.candidate.customLegacy, document.customLegacy);
  assert.equal(result.candidate.plugCycles['legacy-cycle-3'].state, 'ACTIVE');
  assert.equal(result.candidate.profiles.cpslai1.status, 'APPROVED');
  assert.equal(result.report.createdCycles.length, 1);
  assert.equal(result.report.warnings[0].code, 'LEGACY_PROFILE_WITHOUT_ID_PRESERVED');
}));

test('source is never overwritten while candidate receives repository metadata', () => isolated(({ sourcePath, planner }) => {
  const before = fs.readFileSync(sourcePath, 'utf8');
  const result = planner.prevalidate({ sourcePath, activeCycleEvidence: evidence() });
  assert.equal(fs.readFileSync(sourcePath, 'utf8'), before);
  assert.equal(result.candidate.repositorySchemaVersion, 1);
  assert.equal(result.candidate.revision, 0);
}));

test('closed cycles and legacy records without IDs are preserved without fabricated plugCycles', () => isolated(({ sourcePath, planner, document }) => {
  document.profiles.cpslai1 = document.profileVersions.cpslai1[1];
  document.profileVersions.cpslai1[2].plugCycleStatus = 'CLOSED';
  fs.writeFileSync(sourcePath, JSON.stringify(document));
  const result = planner.prevalidate({ sourcePath });
  assert.equal(Object.keys(result.candidate.plugCycles).length, 0);
  assert.equal(result.candidate.profileVersions.cpslai1[0].profileId, undefined);
}));

test('invalid JSON and structurally invalid data fail closed', () => isolated(({ sourcePath, planner }) => {
  fs.writeFileSync(sourcePath, '{"profiles":');
  assert.throws(() => planner.prevalidate({ sourcePath }), { code: 'GOVERNANCE_MIGRATION_JSON_INVALID' });
  fs.writeFileSync(sourcePath, JSON.stringify({ profiles: {}, profileVersions: [] }));
  assert.throws(() => planner.prevalidate({ sourcePath }), { code: 'GOVERNANCE_SCHEMA_INVALID' });
}));

test('multiple active profiles for one CPS abort migration', () => isolated(({ sourcePath, planner, document }) => {
  document.profileVersions.cpslai1[1].plugCycleStatus = 'ACTIVE';
  fs.writeFileSync(sourcePath, JSON.stringify(document));
  assert.throws(() => planner.prevalidate({ sourcePath, activeCycleEvidence: evidence() }), { code: 'GOVERNANCE_MIGRATION_MULTIPLE_ACTIVE_CYCLES' });
}));

test('missing or conflicting active identity and missing lifecycle evidence abort migration', () => isolated(({ sourcePath, planner }) => {
  assert.throws(() => planner.prevalidate({ sourcePath }), { code: 'GOVERNANCE_MIGRATION_ACTIVE_IDENTITY_INCOMPLETE' });
  assert.throws(() => planner.prevalidate({ sourcePath, activeCycleEvidence: evidence({ profileId: 'wrong' }) }), { code: 'GOVERNANCE_MIGRATION_ACTIVE_IDENTITY_CONFLICT' });
  assert.throws(() => planner.prevalidate({ sourcePath, activeCycleEvidence: evidence({ lifecycleEvidence: null }) }), { code: 'GOVERNANCE_MIGRATION_LIFECYCLE_EVIDENCE_REQUIRED' });
}));

test('simulation backs up with SHA-256, initializes Repository and verifies integrity', () => isolated(({ root, sourcePath, destinationPath, planner }) => {
  const manifest = execute(root, sourcePath, destinationPath, planner);
  assert.equal(manifest.sourceHash, manifest.backupHash);
  assert.equal(manifest.repository.read().document.plugCycles['legacy-cycle-3'].state, 'ACTIVE');
  const verified = new GovernanceCutoverSimulator({ workspaceRoot: root, planner }).verify(manifest);
  assert.deepEqual({ ok: verified.ok, sourceUnchanged: verified.sourceUnchanged, backupVerified: verified.backupVerified }, { ok: true, sourceUnchanged: true, backupVerified: true });
}));

test('simulated adapters operate on candidate and leave source and Evolution sentinel unchanged', () => isolated(({ root, sourcePath, destinationPath, planner }) => {
  const evolutionPath = path.join(root, 'evolution-sentinel.json');
  fs.writeFileSync(evolutionPath, '{"disabled":true}\n');
  const sourceBefore = fs.readFileSync(sourcePath, 'utf8');
  const evolutionBefore = fs.readFileSync(evolutionPath, 'utf8');
  const manifest = execute(root, sourcePath, destinationPath, planner);
  const adapters = new TransactionalGovernanceAdapters({ facade: new TransactionalGovernanceFacade({ repository: manifest.repository }) });
  assert.equal(adapters.projectPlayGate({ cpsId: 'cpslai1', profileId: 'gov-cpslai1-v3', plugCycleId: 'legacy-cycle-3', lifecyclePhase: 'play' }).ok, true);
  assert.equal(fs.readFileSync(sourcePath, 'utf8'), sourceBefore);
  assert.equal(fs.readFileSync(evolutionPath, 'utf8'), evolutionBefore);
}));

test('rollback restores verified legacy copy when no new write exists', () => isolated(({ root, sourcePath, destinationPath, planner }) => {
  const simulator = new GovernanceCutoverSimulator({ workspaceRoot: root, planner });
  const manifest = simulator.execute({ sourcePath, destinationPath, activeCycleEvidence: evidence(), writerSuspended: true });
  const rolled = simulator.rollback(manifest);
  assert.equal(rolled.rolledBack, true);
  assert.equal(rolled.restoredHash, manifest.sourceHash);
  assert.equal(fs.existsSync(rolled.archivedCandidatePath), true);
}));

test('destructive rollback is blocked after any new Repository write', () => isolated(({ root, sourcePath, destinationPath, planner }) => {
  const simulator = new GovernanceCutoverSimulator({ workspaceRoot: root, planner });
  const manifest = simulator.execute({ sourcePath, destinationPath, activeCycleEvidence: evidence(), writerSuspended: true });
  manifest.repository.transact((draft) => { draft.history.unshift({ id: 'post-cutover', eventType: 'SIMULATED_WRITE' }); });
  assert.throws(() => simulator.rollback(manifest), { code: 'GOVERNANCE_DESTRUCTIVE_ROLLBACK_BLOCKED' });
  assert.equal(fs.existsSync(destinationPath), true);
}));

test('two processes cannot initialize the same destination', () => isolated(async ({ root, sourcePath, destinationPath }) => {
  const start = path.join(root, 'start');
  const jobs = [worker(root, sourcePath, destinationPath, start), worker(root, sourcePath, destinationPath, start)];
  fs.writeFileSync(start, 'go');
  const results = await Promise.all(jobs);
  assert.equal(results.filter((item) => item.ok).length, 1);
  assert.equal(results.filter((item) => ['GOVERNANCE_CUTOVER_BUSY', 'GOVERNANCE_CUTOVER_DESTINATION_EXISTS'].includes(item.code)).length, 1);
  assert.equal(new GovernanceRepository({ filePath: destinationPath }).read().revision, 0);
}));

test('a concurrent legacy writer changes the source hash and blocks publication', () => isolated(({ root, sourcePath, destinationPath, planner }) => {
  const simulator = new GovernanceCutoverSimulator({
    workspaceRoot: root, planner,
    faultInjector(stage) { if (stage === 'beforePublish') fs.appendFileSync(sourcePath, ' '); },
  });
  assert.throws(() => simulator.execute({ sourcePath, destinationPath, activeCycleEvidence: evidence(), writerSuspended: true }), { code: 'GOVERNANCE_SOURCE_CHANGED' });
  assert.equal(fs.existsSync(destinationPath), false);
}));

test('failure before publication leaves no candidate and failure after publication is recoverable', () => isolated(({ root, sourcePath, destinationPath, planner }) => {
  const before = new GovernanceCutoverSimulator({ workspaceRoot: root, planner, faultInjector(stage) { if (stage === 'beforePublish') throw new Error('before'); } });
  assert.throws(() => before.execute({ sourcePath, destinationPath, activeCycleEvidence: evidence(), writerSuspended: true }), /before/);
  assert.equal(fs.existsSync(destinationPath), false);
  fs.rmSync(`${destinationPath}.legacy-backup.json`);
  const after = new GovernanceCutoverSimulator({ workspaceRoot: root, planner, faultInjector(stage) { if (stage === 'afterPublish') throw new Error('after'); } });
  let failure;
  try { after.execute({ sourcePath, destinationPath, activeCycleEvidence: evidence(), writerSuspended: true }); } catch (error) { failure = error; }
  assert.equal(failure.published, true);
  assert.equal(new GovernanceRepository({ filePath: destinationPath }).read().document.plugCycles['legacy-cycle-3'].state, 'ACTIVE');
}));

test('orphan cutover lock is fail-closed and never removed by time', () => isolated(({ root, sourcePath, destinationPath, planner }) => {
  const lockPath = `${destinationPath}.cutover.lock`;
  fs.mkdirSync(lockPath);
  const simulator = new GovernanceCutoverSimulator({ workspaceRoot: root, planner });
  assert.throws(() => simulator.execute({ sourcePath, destinationPath, activeCycleEvidence: evidence(), writerSuspended: true }), { code: 'GOVERNANCE_CUTOVER_BUSY' });
  assert.equal(fs.existsSync(lockPath), true);
}));

test('RESERVED and FAILED migrated cycles survive restart and remain blocking', () => isolated(({ sourcePath, planner }) => {
  const reserved = planner.prevalidate({ sourcePath, activeCycleEvidence: evidence({ state: 'RESERVED', lifecycleEvidence: null }) }).candidate;
  assert.equal(reserved.plugCycles['legacy-cycle-3'].state, 'RESERVED');
  const failed = planner.prevalidate({ sourcePath, activeCycleEvidence: evidence({ state: 'FAILED', lifecycleEvidence: null, failure: { code: 'LEGACY_FAILURE', message: 'verify' } }) }).candidate;
  assert.equal(failed.plugCycles['legacy-cycle-3'].state, 'FAILED');
  assert.equal(failed.plugCycles['legacy-cycle-3'].failure.code, 'LEGACY_FAILURE');
}));

test('failure between reservation and activation remains recoverable and blocking after Repository restart', () => isolated(({ root, sourcePath, destinationPath, planner }) => {
  const simulator = new GovernanceCutoverSimulator({ workspaceRoot: root, planner });
  const manifest = simulator.execute({
    sourcePath, destinationPath,
    activeCycleEvidence: evidence({ state: 'RESERVED', lifecycleEvidence: null }), writerSuspended: true,
  });
  const restartedRepository = new GovernanceRepository({ filePath: destinationPath });
  const adapters = new TransactionalGovernanceAdapters({ facade: new TransactionalGovernanceFacade({ repository: restartedRepository }) });
  const projection = adapters.projectPlayGate({ cpsId: 'cpslai1', profileId: 'gov-cpslai1-v3', plugCycleId: 'legacy-cycle-3', lifecyclePhase: 'play' });
  assert.equal(projection.cycleState, 'RESERVED');
  assert.equal(projection.ok, false);
  const failed = adapters.recordPlugFailure({
    cpsId: 'cpslai1', plugEventId: 'legacy-plug-3', plugCycleId: 'legacy-cycle-3', profileId: 'gov-cpslai1-v3',
    stage: 'BETWEEN_RESERVATION_AND_ACTIVATION', error: Object.assign(new Error('simulated interruption'), { code: 'SIMULATED_INTERRUPTION' }),
  });
  assert.equal(failed.cycle.state, 'FAILED');
  assert.equal(new GovernanceRepository({ filePath: destinationPath }).read().document.plugCycles['legacy-cycle-3'].state, 'FAILED');
  assert.equal(manifest.repository.read().revision, 1);
}));

test('writer suspension and temporary workspace boundaries are mandatory', () => isolated(({ root, sourcePath, destinationPath, planner }) => {
  const simulator = new GovernanceCutoverSimulator({ workspaceRoot: root, planner });
  assert.throws(() => simulator.execute({ sourcePath, destinationPath, activeCycleEvidence: evidence() }), { code: 'GOVERNANCE_WRITERS_NOT_SUSPENDED' });
  assert.throws(() => simulator.execute({ sourcePath, destinationPath: path.resolve(root, '..', 'outside.json'), activeCycleEvidence: evidence(), writerSuspended: true }), { code: 'GOVERNANCE_SIMULATION_PATH_OUTSIDE_WORKSPACE' });
}));

test('legacy access inventory covers every operational governance concern without importing it', () => {
  const concerns = new Set(LEGACY_GOVERNANCE_ACCESS_INVENTORY.map((item) => item.concern));
  for (const expected of ['Plug/profile/history', 'Unplug/close', 'Snapshot import closes Unplug profiles', 'Human approval', 'Human rejection', 'Policy update', 'Governance check/action/history', 'Action decision/execution intent/history', 'PPU enqueue', 'PPU publication/failure', 'Profile ensure compatibility', 'Profile and versions', 'Active profile projection', 'Governance UI/API consumers']) {
    assert.equal(concerns.has(expected), true, expected);
  }
  const source = fs.readFileSync(path.resolve('lib/governance/governanceMigration.mjs'), 'utf8');
  assert.equal(source.includes('services/governance/governanceStore'), false);
});
