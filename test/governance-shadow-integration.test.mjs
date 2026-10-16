import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GovernanceRepository } from '../lib/governance/governanceRepository.mjs';
import {
  createGovernanceShadowComposition,
  prepareShadowUnplugCommand,
  projectSnapshotForGovernance,
  resolveGovernanceShadowConfig,
} from '../lib/governance/shadowGovernanceIntegration.mjs';
import { compareGovernanceShadows } from '../lib/governance/governanceShadowComparator.mjs';
import { auditGovernanceRuntimeInventory, GOVERNANCE_RUNTIME_INVENTORY } from '../lib/governance/governanceRuntimeInventory.mjs';

const root = path.resolve('.');
const activeProfile = (status = 'APPROVED') => ({
  profileId: 'GOV-CPSLAI1-215', profileVersion: 215, status,
  plugEventId: 'event-215', plugCycleId: 'cpslai1-plug-v215', plugCycleStatus: 'ACTIVE',
  policies: { governableActions: [{ action: 'ADJUST_TRANSPORT_SPEED', autonomousLimit: 5, humanApprovalLimit: 15 }] },
});
const document = (status = 'APPROVED') => ({
  profiles: { cpslai1: activeProfile(status) },
  profileVersions: { cpslai1: [activeProfile(status)] },
  pendingActions: {}, history: [{ id: 'h1', eventType: 'GOVERNANCE_PROFILE_APPROVED' }], ppuOutbox: {},
});
const candidate = (status = 'APPROVED') => ({
  ...document(status), repositorySchemaVersion: 1, revision: 0,
  plugCycles: {
    'cpslai1-plug-v215': {
      cpsId: 'cpslai1', plugEventId: 'event-215', plugCycleId: 'cpslai1-plug-v215',
      governanceProfileId: 'GOV-CPSLAI1-215', state: 'ACTIVE',
    },
  },
});
const identity = { cpsId: 'cpslai1', plugEventId: 'event-215', plugCycleId: 'cpslai1-plug-v215', profileId: 'GOV-CPSLAI1-215' };
const evidence = { ...identity, accepted: true, transitionId: 'unplug-transition-1', phase: 'unplug' };

test('feature configuration is default-off and never enables writes or Evolution', () => {
  assert.deepEqual(resolveGovernanceShadowConfig(), {
    mode: 'disabled', shadowEnabled: false, writesEnabled: false, writesRequested: false,
    evolutionEnabled: false, evolutionRequested: false, blocked: false, blockers: [],
  });
  const requested = resolveGovernanceShadowConfig({ TRANSACTIONAL_GOVERNANCE_SHADOW_ENABLED: 'true', TRANSACTIONAL_GOVERNANCE_WRITES_ENABLED: 'true', EVOLUTION_ENABLED: 'true' });
  assert.equal(requested.mode, 'shadow');
  assert.equal(requested.writesEnabled, false);
  assert.equal(requested.evolutionEnabled, false);
  assert.equal(requested.blocked, true);
});

test('disabled composition creates no Repository, facade, adapters, Store or comparison', () => {
  let constructions = 0;
  const composition = createGovernanceShadowComposition({
    repositoryFactory() { constructions += 1; throw new Error('must not run'); },
    facadeFactory() { constructions += 1; }, adaptersFactory() { constructions += 1; },
  });
  assert.equal(constructions, 0);
  assert.deepEqual({ mode: composition.mode, initialized: composition.initialized, comparisonStarted: composition.comparisonStarted }, { mode: 'disabled', initialized: false, comparisonStarted: false });
});

test('snapshot projection is observation-only and unplug never closes by cpsId', () => {
  const projection = projectSnapshotForGovernance({ assets: [
    { cps: { id: 'cpslai1', lifecyclePhase: 'unplugged' } },
    { cps: { id: 'cpslai2', lifecyclePhase: 'play' } },
  ] });
  assert.deepEqual(projection.effects, []);
  assert.equal(projection.observations[0].closureStatus, 'CORRELATED_UNPLUG_REQUIRED');
  assert.deepEqual(projection.observations[0].requiredIdentity, ['cpsId', 'plugEventId', 'plugCycleId', 'profileId']);
  assert.equal(projection.observations[0].governanceMutation, null);
  assert.equal(projection.observations[1].closureStatus, 'NO_CLOSE_REQUESTED');
});

test('shadow Unplug preparation requires complete current identity, CAS and correlated evidence', () => {
  const observation = projectSnapshotForGovernance({ assets: [{ cps: { id: 'cpslai1', lifecyclePhase: 'unplug' } }] }).observations[0];
  const command = prepareShadowUnplugCommand({ observation, identity, evidence, expectedRevision: 4 });
  assert.equal(command.preparedOnly, true);
  assert.deepEqual(command.effects, []);
  assert.throws(() => prepareShadowUnplugCommand({ observation, identity, evidence: { ...evidence, plugCycleId: 'obsolete' }, expectedRevision: 4 }), { code: 'GOVERNANCE_LIFECYCLE_EVIDENCE_IDENTITY_CONFLICT' });
  assert.throws(() => prepareShadowUnplugCommand({ observation, identity, expectedRevision: 4 }), { code: 'GOVERNANCE_CORRELATED_LIFECYCLE_EVIDENCE_REQUIRED' });
  assert.throws(() => prepareShadowUnplugCommand({ observation, identity: { ...identity, cpsId: 'cpslai2' }, evidence, expectedRevision: 4 }), { code: 'GOVERNANCE_UNPLUG_OBSERVATION_CONFLICT' });
});

test('shadow composition is explicitly injected, read-only and does not initialize absent candidate', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'governance-shadow-root-'));
  const filePath = path.join(temporary, 'absent-candidate.json');
  try {
    const config = resolveGovernanceShadowConfig({ TRANSACTIONAL_GOVERNANCE_SHADOW_ENABLED: 'true' });
    const composition = createGovernanceShadowComposition({ config, filePath });
    assert.equal(composition.mode, 'shadow');
    assert.equal(composition.initialized, false);
    assert.equal(composition.comparisonStarted, false);
    assert.equal(fs.existsSync(filePath), false);
    assert.throws(() => composition.reader.read(), { code: 'GOVERNANCE_STORE_NOT_FOUND' });
    assert.throws(() => composition.writers.reservePlug({}), { code: 'GOVERNANCE_SHADOW_WRITE_FORBIDDEN' });
    assert.equal(fs.existsSync(filePath), false);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test('blocked flags prevent composition before any factory or filesystem action', () => {
  let constructions = 0;
  const config = resolveGovernanceShadowConfig({ TRANSACTIONAL_GOVERNANCE_SHADOW_ENABLED: 'true', TRANSACTIONAL_GOVERNANCE_WRITES_ENABLED: 'true' });
  assert.throws(() => createGovernanceShadowComposition({ config, filePath: path.resolve('never-created.json'), repositoryFactory() { constructions += 1; } }), { code: 'GOVERNANCE_SHADOW_CONFIGURATION_BLOCKED' });
  assert.equal(constructions, 0);
});

test('explicit shadow reader recovers candidate after restart without writes', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'governance-shadow-restart-'));
  const filePath = path.join(temporary, 'candidate.json');
  try {
    new GovernanceRepository({ filePath }).initialize(candidate());
    const before = fs.readFileSync(filePath, 'utf8');
    const config = resolveGovernanceShadowConfig({ TRANSACTIONAL_GOVERNANCE_SHADOW_ENABLED: 'true' });
    const first = createGovernanceShadowComposition({ config, filePath });
    const second = createGovernanceShadowComposition({ config, filePath });
    assert.equal(first.reader.getProfile('cpslai1').governanceStatus, 'APPROVED');
    assert.equal(second.reader.projectPlayGate({ ...identity, lifecyclePhase: 'play' }).ok, true);
    assert.equal(fs.readFileSync(filePath, 'utf8'), before);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test('shadow comparison treats correlated plugCycles as expected schema enrichment', () => {
  const legacy = document(); const transactional = candidate();
  const legacyBefore = structuredClone(legacy); const candidateBefore = structuredClone(transactional);
  const result = compareGovernanceShadows({
    legacyDocument: legacy, candidateDocument: transactional,
    legacyPlayGates: { cpslai1: { ok: true, governanceStatus: 'APPROVED' } },
    candidatePlayGates: { cpslai1: { ok: true, governanceStatus: 'APPROVED' } },
  });
  assert.equal(result.compatible, true);
  assert.deepEqual(result.summary, { expected: 1, incompatible: 0 });
  assert.equal(result.differences[0].category, 'plugCycles');
  assert.deepEqual(legacy, legacyBefore);
  assert.deepEqual(transactional, candidateBefore);
});

test('shadow comparison detects approval, policy, history, outbox and Play-gate divergence', () => {
  const transactional = candidate('PENDING_APPROVAL');
  transactional.profiles.cpslai1.policies.governableActions[0].autonomousLimit = 9;
  transactional.history = [];
  transactional.ppuOutbox = { unexpected: { eventId: 'unexpected' } };
  const result = compareGovernanceShadows({
    legacyDocument: document('APPROVED'), candidateDocument: transactional,
    legacyPlayGates: { cpslai1: { ok: true, governanceStatus: 'APPROVED' } },
    candidatePlayGates: { cpslai1: { ok: false, governanceStatus: 'PENDING_APPROVAL' } },
  });
  assert.equal(result.compatible, false);
  for (const category of ['activeProfiles', 'policies', 'profileVersions', 'history', 'ppuOutbox', 'playGate']) {
    assert.equal(result.differences.some((item) => item.category === category && item.severity === 'INCOMPATIBLE'), true, category);
  }
});

test('APPROVED and PENDING_APPROVAL compare compatibly when both representations agree', () => {
  for (const status of ['APPROVED', 'PENDING_APPROVAL']) {
    const result = compareGovernanceShadows({ legacyDocument: document(status), candidateDocument: candidate(status) });
    assert.equal(result.compatible, true, status);
  }
});

test('runtime inventory classifies every governanceStore import and blocks unknown paths', () => {
  const result = auditGovernanceRuntimeInventory({ projectRoot: root });
  assert.equal(result.status, 'PASS');
  assert.deepEqual(result.unclassified, []);
  assert.deepEqual(result.missing, []);
  assert.equal(result.inventory.some((item) => item.classifications.includes('IMPLICIT_CLOSE')), true);
  assert.equal(result.inventory.some((item) => item.classifications.includes('HCM_EFFECT')), true);
  assert.equal(result.inventory.some((item) => item.classifications.includes('PLAY_GATE')), true);
});

test('runtime inventory returns BLOCKED for an unclassified legacy import', () => {
  const fake = path.join(root, 'unknown-writer.mjs');
  const files = [fake];
  const result = auditGovernanceRuntimeInventory({
    projectRoot: root,
    discoverFiles: () => files,
    readFileSync: () => "import { approveGovernanceProfile } from './services/governance/governanceStore.js';",
  });
  assert.equal(result.status, 'BLOCKED');
  assert.deepEqual(result.unclassified, ['unknown-writer.mjs']);
});

test('inventory includes writers, readers, action execution, outbox, HCM, implicit close and Play-gate', () => {
  const classes = new Set(GOVERNANCE_RUNTIME_INVENTORY.flatMap((item) => item.classifications));
  for (const value of ['WRITER', 'READER', 'ACTION_EXECUTION', 'OUTBOX', 'HCM_EFFECT', 'IMPLICIT_CLOSE', 'PLAY_GATE']) assert.equal(classes.has(value), true, value);
});

test('shadow modules contain no operational Store import, transport or automatic comparison side effect', () => {
  for (const file of ['lib/governance/shadowGovernanceIntegration.mjs', 'lib/governance/governanceShadowComparator.mjs']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8').toLowerCase();
    for (const forbidden of ['governancestore', 'mqtt', 'opcua', 'mysql', 'fetch(', 'axios', 'comparegovernanceshadows(']) {
      if (forbidden === 'comparegovernanceshadows(' && file.endsWith('governanceShadowComparator.mjs')) continue;
      assert.equal(source.includes(forbidden), false, `${file}: ${forbidden}`);
    }
  }
});
