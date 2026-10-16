import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildEvolutionCycleReadModel } from '../lib/evolution/evolutionCycleReadModel.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const identity = { cpsId: 'cpslai1', plugEventId: 'event-1', plugCycleId: 'cycle-1', profileId: 'profile-1' };
const authority = { identity, lifecyclePhase: 'plug', cycleState: 'ACTIVE', governanceStatus: 'PENDING_APPROVAL' };
const evolution = { ...identity, status: 'CHANGED', snapshotId: 'snap-1', comparisonId: 'cmp-1', differences: [{ type: 'ADDED', identity: 'cap:new' }] };
const experimentalAas = { aasId: 'aas-1', assetId: 'asset-1', version: 'v3', sha256: 'a'.repeat(64), sourceType: 'EXPERIMENTAL_STATIC_DOCUMENT', operational: true, capabilities: [{ kind: 'CAPABILITY', name: 'Cap', identity: 'cap:1', evidenceLevel: 'DECLARED_ONLY' }], services: [{ kind: 'SERVICE', name: 'play', identity: 'svc:1' }] };

test('fully correlated cycle preserves sanitized lifecycle, governance, AAS and Evolution', () => {
  const result = buildEvolutionCycleReadModel({ cycleAuthority: authority, governance: { ...identity, governanceStatus: 'PENDING_APPROVAL' }, lifecycle: { ...identity, lifecyclePhase: 'plug', cycleState: 'ACTIVE' }, evolution, aas: experimentalAas });
  assert.equal(result.identityCorrelationStatus, 'CORRELATED');
  assert.deepEqual(result.identity, identity);
  assert.equal(result.evolution.status, 'CHANGED');
  assert.equal(result.evolution.differences[0].type, 'ADDED');
  assert.equal(result.aas.operational, false);
  assert.equal(result.aas.capabilities[0].evidenceLevel, 'DECLARED_ONLY');
});

test('wrong profile, wrong event and stale Play snapshot are conflicts, never silently selected', () => {
  for (const source of [
    { governance: { ...identity, profileId: 'other-profile', governanceStatus: 'PENDING_APPROVAL' } },
    { evolution: { ...evolution, plugEventId: 'other-event' } },
    { play: { ...identity, lifecyclePhase: 'play', cycleState: 'ACTIVE', governanceStatus: 'APPROVED' } },
  ]) {
    const result = buildEvolutionCycleReadModel({ cycleAuthority: authority, ...source });
    assert.equal(result.identityCorrelationStatus, 'CONFLICT');
    assert.equal(result.issues.some((item) => item.severity === 'ERROR'), true);
  }
});

test('missing profile or missing authority is uncorrelated and cpsId alone is insufficient', () => {
  const missingProfile = buildEvolutionCycleReadModel({ cycleAuthority: { ...authority, identity: { ...identity, profileId: null } }, evolution });
  assert.equal(missingProfile.identityCorrelationStatus, 'UNCORRELATED');
  const cpsOnly = buildEvolutionCycleReadModel({ governance: { cpsId: 'cpslai1', governanceStatus: 'APPROVED' } });
  assert.equal(cpsOnly.identityCorrelationStatus, 'UNCORRELATED');
  assert.equal(buildEvolutionCycleReadModel().identityCorrelationStatus, 'UNAVAILABLE');
});

test('missing Evolution is NOT_AVAILABLE and does not invent baseline or no-change', () => {
  const result = buildEvolutionCycleReadModel({ cycleAuthority: authority });
  assert.equal(result.evolution.status, 'NOT_AVAILABLE');
  assert.equal(result.visualState.evolution, 'EVOLUTION_NOT_PROCESSED');
});

test('insufficient operational AAS provenance is not accepted as operational', () => {
  const result = buildEvolutionCycleReadModel({ cycleAuthority: authority, aas: { aasId: 'aas', operational: true, sourceType: 'OPERATIONAL_AAS' } });
  assert.equal(result.aas.operational, false);
  assert.equal(result.aas.provenanceStatus, 'INSUFFICIENT');
  assert.equal(result.issues.some((item) => item.code === 'AAS_PROVENANCE_INSUFFICIENT'), true);
});

test('PENDING versus APPROVED conflict is exposed and original inputs remain unchanged', () => {
  const input = { cycleAuthority: authority, governance: { ...identity, governanceStatus: 'PENDING_APPROVAL' }, play: { ...identity, governanceStatus: 'APPROVED', lifecyclePhase: 'plug', cycleState: 'ACTIVE' } };
  const before = structuredClone(input);
  const result = buildEvolutionCycleReadModel(input);
  assert.equal(result.identityCorrelationStatus, 'CONFLICT');
  assert.equal(result.governanceStatus, 'CONFLICT');
  assert.deepEqual(input, before);
  result.sourceEvidence.governance.governanceStatus = 'MUTATED_COPY';
  assert.deepEqual(input, before);
});

test('module has no operational imports and read-model execution performs no workspace writes', () => {
  const modulePath = path.join(root, 'lib', 'evolution', 'evolutionCycleReadModel.mjs');
  const source = fs.readFileSync(modulePath, 'utf8');
  assert.doesNotMatch(source, /node:fs|governanceStore|GovernanceRepository|EvolutionStore|CPSContext|fetch\s*\(/);
  const before = fs.statSync(modulePath).mtimeMs;
  buildEvolutionCycleReadModel({ cycleAuthority: authority, evolution, aas: experimentalAas });
  assert.equal(fs.statSync(modulePath).mtimeMs, before);
});
