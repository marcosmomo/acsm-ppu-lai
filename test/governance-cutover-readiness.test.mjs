import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  assertGovernanceWriterPrincipal,
  buildExternalEffectIntent,
  buildHumanDecisionCommand,
  buildLifecycleCommitCommand,
  buildPlugIntegrationCommand,
  requireCycleIdentity,
} from '../lib/governance/cutoverIntegrationContracts.mjs';
import { CUTOVER_INTEGRATION_MATRIX, evaluateCutoverReadiness } from '../lib/governance/cutoverReadiness.mjs';
import { LEGACY_GOVERNANCE_ACCESS_INVENTORY } from '../lib/governance/legacyGovernanceInventory.mjs';

const root = path.resolve('.');
const cycle = {
  cpsId: 'cpslai1', plugEventId: 'event-1', plugCycleId: 'cycle-1', profileId: 'profile-1',
};
const authorization = {
  authenticated: true, authorized: true, trusted: true, provenance: 'SERVER_AUTHENTICATION',
  subject: 'operator-1', roles: ['GOVERNANCE_OPERATOR'], authenticationId: 'auth-1',
  authenticatedAt: '2026-10-14T18:00:00.000Z', permission: 'governance.profile.approve',
};
const activeProfiles = [
  { cpsId: 'cpslai1', profileId: 'GOV-CPSLAI1-215', plugCycleId: 'cpslai1-plug-v215', plugEventId: 'sanitized-event-1', profileVersion: 215 },
  { cpsId: 'cpslai2', profileId: 'GOV-CPSLAI2-103', plugCycleId: 'cpslai2-plug-v103', plugEventId: 'sanitized-event-2', profileVersion: 103 },
  { cpsId: 'cpslai3', profileId: 'GOV-CPSLAI3-113', plugCycleId: 'cpslai3-plug-v113', plugEventId: 'sanitized-event-3', profileVersion: 113 },
];
const validations = { historicalPreservation: true, retries: true, concurrency: true, corruption: true, rollback: true, migrationSimulation: true };
const dependencies = { writersSuspension: true, serverAuthentication: true, lifecycleEvidenceAuthority: true, effectDispatcher: true, localFilesystemTopology: true, verifiedOperationalBackup: true };

test('audit presentation uses governanceProfileId and labels documentary result without operational authorization', () => {
  const source = fs.readFileSync(path.join(root, 'scripts/audit-active-cycles.mjs'), 'utf8');
  assert.match(source, /Profile_ID:\s*c\.governanceProfileId/);
  assert.match(source, /PRE-VALIDACAO DOCUMENTAL CONCLUIDA/);
  assert.match(source, /nao executa migracao, cutover ou autorizacao operacional/);
});

test('cycle identity requires CPS, event, cycle and profile', () => {
  assert.deepEqual(requireCycleIdentity(cycle), cycle);
  assert.throws(() => requireCycleIdentity({ ...cycle, profileId: null }), { code: 'GOVERNANCE_INTEGRATION_FIELD_REQUIRED' });
});

test('Plug contract requires stable functional/AAS identity', () => {
  const command = buildPlugIntegrationCommand({ cpsId: 'cpslai1', plugEventId: 'event-1', identity: { aasId: 'urn:test:aas', assetId: 'asset-1' } });
  assert.equal(command.plugCycleId, null);
  assert.throws(() => buildPlugIntegrationCommand({ cpsId: 'cpslai1', plugEventId: 'event-1', identity: { aasId: 'urn:test:aas' } }), { code: 'GOVERNANCE_PLUG_FUNCTIONAL_IDENTITY_REQUIRED' });
});

test('human decision requires CAS and trusted server authentication rather than frontend actorType', () => {
  const command = buildHumanDecisionCommand({ ...cycle, decision: 'APPROVED', expectedRevision: 7, authorization });
  assert.equal(command.authorization.id, 'operator-1');
  assert.equal(command.expectedRevision, 7);
  assert.throws(() => buildHumanDecisionCommand({ ...cycle, decision: 'APPROVED', expectedRevision: 7, authorization: { actorType: 'HUMAN' } }), { code: 'GOVERNANCE_TRUSTED_SERVER_AUTHORIZATION_REQUIRED' });
  assert.throws(() => buildHumanDecisionCommand({ ...cycle, decision: 'APPROVED', authorization }), { code: 'GOVERNANCE_EXPECTED_REVISION_REQUIRED' });
});

test('lifecycle evidence must carry and match every cycle identifier', () => {
  const evidence = { ...cycle, accepted: true, transitionId: 'transition-1', phase: 'plug' };
  const command = buildLifecycleCommitCommand({ ...cycle, expectedRevision: 8, evidence }, 'plug');
  assert.equal(command.evidence.transitionId, 'transition-1');
  assert.throws(() => buildLifecycleCommitCommand({ ...cycle, expectedRevision: 8, evidence: { ...evidence, plugCycleId: 'other' } }, 'plug'), { code: 'GOVERNANCE_LIFECYCLE_EVIDENCE_IDENTITY_CONFLICT' });
  assert.throws(() => buildLifecycleCommitCommand({ ...cycle, expectedRevision: 8, evidence: { ...evidence, accepted: false } }, 'plug'), { code: 'GOVERNANCE_CORRELATED_LIFECYCLE_EVIDENCE_REQUIRED' });
});

test('external effects are represented as pending intent and never executed by contract creation', () => {
  let calls = 0;
  const intent = buildExternalEffectIntent({ ...cycle, intentId: 'intent-1', effectType: 'GOVERNED_ACTION_EXECUTION', payload: { value: 1 } });
  assert.equal(intent.status, 'PENDING');
  assert.equal(calls, 0);
});

test('Evolution is explicitly forbidden as governance writer', () => {
  assert.throws(() => assertGovernanceWriterPrincipal({ subsystem: 'EVOLUTION' }), { code: 'GOVERNANCE_EVOLUTION_WRITE_FORBIDDEN' });
  assert.deepEqual(assertGovernanceWriterPrincipal({ subsystem: 'GOVERNANCE_API' }), { subsystem: 'GOVERNANCE_API' });
});

test('integration matrix covers every known writer path and all required concerns', () => {
  const matrixModules = new Set(CUTOVER_INTEGRATION_MATRIX.flatMap((item) => item.modules));
  for (const writer of LEGACY_GOVERNANCE_ACCESS_INVENTORY.filter((item) => item.kind === 'writer')) {
    for (const file of writer.paths) assert.equal(matrixModules.has(file), true, `${writer.concern}: ${file}`);
  }
  for (const id of ['plug', 'unplug', 'snapshot-close', 'profile-decisions', 'policies', 'governed-actions', 'ppu-outbox', 'profile-queries', 'play-gate']) {
    assert.equal(CUTOVER_INTEGRATION_MATRIX.some((item) => item.id === id), true, id);
  }
});

test('current codebase readiness is FAIL and separately reports missing operational dependencies as BLOCKED', () => {
  const result = evaluateCutoverReadiness({ projectRoot: root, activeProfiles, validations, dependencies: {} });
  assert.equal(result.status, 'FAIL');
  assert.equal(result.findings.find((item) => item.id === 'cps-only-close').status, 'FAIL');
  assert.equal(result.findings.find((item) => item.id === 'active-profile-correlation').status, 'PASS');
  assert.equal(result.findings.find((item) => item.id === 'dependency-serverAuthentication').status, 'BLOCKED');
  assert.ok(result.counts.BLOCKED > 0);
});

test('readiness becomes PASS only when unsafe close is absent and every validation/dependency is evidenced', () => {
  const readFileSync = (file, encoding) => {
    const source = fs.readFileSync(file, encoding);
    return file.endsWith(path.join('lib', 'acsm', 'plugPostHandler.mjs'))
      ? source.replaceAll('closeGovernancePlugCycle(cpsId)', 'closeCorrelatedCycle(identity)')
      : source;
  };
  const result = evaluateCutoverReadiness({ projectRoot: root, activeProfiles, validations, dependencies, readFileSync });
  assert.equal(result.status, 'PASS');
  assert.deepEqual(result.counts, { PASS: 16, FAIL: 0, BLOCKED: 0 });
});

test('correlation divergence or incomplete integration matrix is a hard FAIL', () => {
  const correlation = evaluateCutoverReadiness({ projectRoot: root, activeProfiles: activeProfiles.slice(0, 2), validations, dependencies });
  assert.equal(correlation.findings.find((item) => item.id === 'active-profile-correlation').status, 'FAIL');
  const readFileSync = (file, encoding) => {
    if (file.endsWith(path.join('app', 'api', 'governance', 'check', 'route.js'))) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return fs.readFileSync(file, encoding);
  };
  const inventory = evaluateCutoverReadiness({ projectRoot: root, activeProfiles, validations, dependencies, readFileSync });
  assert.equal(inventory.findings.find((item) => item.id === 'integration-inventory').status, 'FAIL');
});

test('B6.1 isolated modules do not import operational Store or external transports', () => {
  for (const file of ['lib/governance/cutoverIntegrationContracts.mjs', 'lib/governance/cutoverReadiness.mjs']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8').toLowerCase();
    assert.equal(/(?:import|from)\s+['"][^'"]*services\/governance\/governancestore/.test(source), false, `${file}: operational Store import`);
    for (const forbidden of ['mqtt', 'opcua', 'mysql', 'fetch(', 'axios']) assert.equal(source.includes(forbidden), false, `${file}: ${forbidden}`);
  }
});
