import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  GovernanceRepository,
  governanceTransactionNoOp,
  validateGovernanceDocument,
} from '../lib/governance/governanceRepository.mjs';

const fixtureRoot = path.resolve('test/fixtures/governance-repository');
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(fixtureRoot, name), 'utf8'));

async function isolated(run, fixtureName = 'current-valid.json') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acsm-governance-repository-'));
  const filePath = path.join(root, 'governance.json');
  if (fixtureName) fs.copyFileSync(path.join(fixtureRoot, fixtureName), filePath);
  try { return await run({ root, filePath, repository: new GovernanceRepository({ filePath }) }); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('requires an explicit absolute path and never initializes implicitly', () => {
  assert.throws(() => new GovernanceRepository({ filePath: 'data/governance.json' }), { code: 'GOVERNANCE_PATH_ABSOLUTE_REQUIRED' });
  return isolated(({ repository }) => assert.throws(() => repository.read(), { code: 'GOVERNANCE_STORE_NOT_FOUND' }), null);
});

test('reads a legacy-compatible document strictly without changing it', () => isolated(({ filePath, repository }) => {
  const before = fs.readFileSync(filePath, 'utf8');
  const result = repository.read();
  assert.equal(result.revision, 0);
  assert.equal(result.document.plugCycles, undefined);
  assert.equal(fs.readFileSync(filePath, 'utf8'), before);
  assert.equal(result.document.customLegacyField.preserve, true);
}));

test('commits a complete mutation, increments revision and prepares plugCycles', () => isolated(({ repository }) => {
  const committed = repository.transact((draft, context) => {
    assert.equal(context.baseRevision, 0);
    draft.history.push({ id: 'transactional-history', eventType: 'TEST_ONLY' });
    draft.pendingActions['GA-002'] = { actionId: 'GA-002', status: 'PENDING_HUMAN_APPROVAL' };
    return 'committed';
  }, { expectedRevision: 0 });
  assert.equal(committed.result, 'committed');
  assert.equal(committed.revision, 1);
  assert.deepEqual(committed.document.plugCycles, {});
  assert.equal(committed.document.repositorySchemaVersion, 1);
  assert.equal(committed.document.history.at(-1).id, 'transactional-history');
}));

test('recovers the confirmed revision after restart and rejects a stale revision', () => isolated(({ filePath, repository }) => {
  repository.transact((draft) => { draft.marker = 'first'; }, { expectedRevision: 0 });
  const restarted = new GovernanceRepository({ filePath });
  assert.equal(restarted.read().revision, 1);
  assert.equal(restarted.read().document.marker, 'first');
  assert.throws(() => restarted.transact((draft) => { draft.marker = 'stale'; }, { expectedRevision: 0 }), {
    code: 'GOVERNANCE_REVISION_CONFLICT',
  });
  assert.equal(restarted.read().document.marker, 'first');
  assert.equal(restarted.read().revision, 1);
}));

test('explicit NO_OP verifies under lock without revision or byte changes', () => isolated(({ filePath, repository }) => {
  const before = fs.readFileSync(filePath, 'utf8');
  const result = repository.transact((draft, { baseRevision }) => {
    assert.equal(draft.profiles.cpslai1.profileId, 'gov-cpslai1-v2');
    return governanceTransactionNoOp({ verified: true, baseRevision });
  });
  assert.equal(result.committed, false);
  assert.equal(result.revision, 0);
  assert.deepEqual(result.result, { verified: true, baseRevision: 0 });
  assert.equal(fs.readFileSync(filePath, 'utf8'), before);
}));

test('two processes modifying different fields preserve both updates', () => isolated(async ({ root, filePath, repository }) => {
  const startFile = path.join(root, 'start');
  const worker = path.resolve('test/fixtures/governance-repository-worker.mjs');
  const run = (field, value) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, filePath, startFile, field, value], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
  });
  const children = [run('profiles', 'profile-A'), run('ppuOutbox', 'event-B')];
  fs.writeFileSync(startFile, 'go');
  const results = await Promise.all(children);
  assert.equal(results.every((entry) => entry.ok), true);
  const confirmed = repository.read();
  assert.equal(confirmed.document.profiles.concurrentTest.profileId, 'profile-A');
  assert.equal(confirmed.document.ppuOutbox.concurrentTest.eventId, 'event-B');
  assert.equal(confirmed.revision, 2);
}));

test('failure before rename preserves the previous confirmed document', () => isolated(({ filePath }) => {
  const before = fs.readFileSync(filePath, 'utf8');
  const repository = new GovernanceRepository({
    filePath,
    faultInjector(stage) { if (stage === 'beforeRename') throw new Error('simulated storage failure'); },
  });
  assert.throws(() => repository.transact((draft) => { draft.shouldNotCommit = true; }), { code: 'GOVERNANCE_WRITE_FAILED' });
  assert.equal(fs.readFileSync(filePath, 'utf8'), before);
  assert.equal(fs.existsSync(`${filePath}.lock`), false);
  assert.equal(fs.readdirSync(path.dirname(filePath)).some((name) => name.endsWith('.tmp')), false);
}));

test('orphan lock is fail-closed and requires explicit verified release', () => isolated(({ filePath }) => {
  fs.mkdirSync(`${filePath}.lock`);
  fs.writeFileSync(path.join(`${filePath}.lock`, 'owner.json'), JSON.stringify({ pid: 999999, acquiredAt: '2000-01-01T00:00:00.000Z' }));
  const repository = new GovernanceRepository({ filePath, lockTimeoutMs: 20, retryMs: 2 });
  assert.throws(() => repository.transact((draft) => { draft.invalid = true; }), { code: 'GOVERNANCE_REPOSITORY_BUSY' });
  assert.throws(() => repository.releaseOrphanedLock({ verified: false, reason: 'old lock' }), { code: 'GOVERNANCE_LOCK_VERIFICATION_REQUIRED' });
  assert.equal(repository.releaseOrphanedLock({ verified: true, reason: 'isolated test verified no owner process' }).released, true);
}));

test('invalid, truncated and structurally inconsistent stores fail closed', async () => {
  await isolated(({ repository }) => assert.throws(() => repository.read(), { code: 'GOVERNANCE_JSON_INVALID' }), 'invalid-truncated.json');
  await isolated(({ repository }) => assert.throws(() => repository.read(), { code: 'GOVERNANCE_SCHEMA_INVALID' }), 'structurally-inconsistent.json');
});

test('preserves historical profiles and missing identifiers without fabrication', () => isolated(({ repository }) => {
  const historicalBefore = fixture('historical-missing-ids.json').profileVersions;
  const committed = repository.transact((draft) => { draft.auditMarker = 'repository-only'; });
  assert.deepEqual(committed.document.profileVersions, historicalBefore);
  assert.equal('plugEventId' in committed.document.profileVersions.cps1[0], false);
  assert.equal('plugCycleId' in committed.document.profileVersions.cps1[0], false);
}, 'historical-missing-ids.json'));

test('preserves all historical collections and unknown fields through commit', () => isolated(({ repository }) => {
  const before = fixture('historical-profiles.json');
  const committed = repository.transact((draft) => { draft.unrelatedExtension = { retained: true }; });
  for (const field of ['profiles', 'profileVersions', 'pendingActions', 'history', 'ppuOutbox']) {
    assert.deepEqual(committed.document[field], before[field]);
  }
  assert.equal(committed.document.profiles.cpslai1.status, 'DENIED');
}, 'historical-profiles.json'));

test('accepts active cycles but rejects duplicate events and two non-closed cycles per CPS', () => isolated(({ repository }) => {
  assert.equal(repository.read().document.plugCycles['cycle-4'].state, 'ACTIVE');
  assert.throws(() => repository.transact((draft) => {
    draft.plugCycles['cycle-5'] = { plugCycleId: 'cycle-5', plugEventId: 'plug-5', cpsId: 'cpslai1', state: 'RESERVED' };
  }), { code: 'GOVERNANCE_INVARIANT_VIOLATION' });
  assert.equal(repository.read().revision, 7);
}, 'active-cycles.json'));

test('never changes profile approval state and forbids asynchronous mutators under lock', () => isolated(({ repository }) => {
  const status = repository.read().document.profiles.cpslai1.status;
  repository.transact((draft) => { draft.repositoryCheck = true; });
  assert.equal(repository.read().document.profiles.cpslai1.status, status);
  let asyncMutatorInvoked = false;
  assert.throws(() => repository.transact(async () => { asyncMutatorInvoked = true; }), { code: 'GOVERNANCE_ASYNC_MUTATOR_FORBIDDEN' });
  assert.equal(asyncMutatorInvoked, false);
  assert.equal(fs.existsSync(repository.lockPath), false);
}));

test('explicit initialize validates and writes a new non-operational store', () => isolated(({ repository }) => {
  const empty = { profiles: {}, profileVersions: {}, pendingActions: {}, history: [], ppuOutbox: {}, source: 'isolated-test' };
  const initialized = repository.initialize(empty);
  assert.equal(initialized.revision, 0);
  assert.deepEqual(initialized.document.plugCycles, {});
  assert.equal(repository.read().document.source, 'isolated-test');
  assert.throws(() => repository.initialize(empty), { code: 'GOVERNANCE_STORE_ALREADY_EXISTS' });
}, null));

test('schema validator is side-effect free', () => {
  const document = fixture('without-plug-cycles.json');
  const before = structuredClone(document);
  assert.equal(validateGovernanceDocument(document), true);
  assert.deepEqual(document, before);
});

test('repository source has no operational or external-effect dependency', () => {
  const source = fs.readFileSync(path.resolve('lib/governance/governanceRepository.mjs'), 'utf8');
  assert.doesNotMatch(source, /governanceStore|plugPostHandler|unplugLifecycle|evolutionStore|\bHCM\b|MQTT|OPC\s*UA|mysql|node-red|\bfetch\s*\(|child_process|executeGovernedAction/i);
});
