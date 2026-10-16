import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';

import artifact from '../docs/experiments/cpslai1-three-state-evolution.json' with { type: 'json' };
import { buildFunctionalSnapshot } from '../lib/evolution/functionalNormalizer.mjs';
import { compareFunctionalSnapshots } from '../lib/evolution/functionalComparator.mjs';

const load = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));
const bytes = (filePath) => fs.readFileSync(filePath);
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const capabilities = (document) => document.submodels.find(({ idShort }) => idShort === 'Capabilities').submodelElements;
const fixture = (id) => artifact.steps.find((step) => step.id === id);

test('S1, S2 and S3 are immutable verified AAS fixtures with preserved identity', () => {
  assert.deepEqual(artifact.sequence, ['s1', 's2', 's3']);
  assert.equal(artifact.boundary, 'EXPERIMENTAL AAS EVOLUTION — NOT OPERATIONAL PPU STATE');
  assert.deepEqual(artifact.steps.map(({ capabilityCount }) => capabilityCount), [5, 6, 5]);
  assert.equal(new Set(artifact.steps.map(({ documentHash }) => documentHash)).size, 3);

  for (const step of artifact.steps) {
    const document = load(step.fixture);
    const aas = document.assetAdministrationShells[0];
    assert.equal(step.immutable, true);
    assert.equal(sha256(bytes(step.fixture)), step.documentHash);
    assert.equal(aas.id, artifact.aasId);
    assert.equal(aas.assetInformation.globalAssetId, artifact.assetId);
    assert.equal(capabilities(document).length, step.capabilityCount);
    assert.equal(buildFunctionalSnapshot(document).functionalHash, step.functionalHash);
  }
});

test('S2 preserves the five official capabilities and adds only the complete V1 PieceDetection', () => {
  const official = load('cps-defs/cps-lai-01-aas-acsm-compatible-revised.json');
  const v1 = load('cps-defs/evolution-experiments/cpslai1/aas-v1.json');
  const s2 = load(fixture('s2').fixture);
  assert.deepEqual(capabilities(s2).slice(0, 5), capabilities(official));
  assert.deepEqual(
    capabilities(s2)[5],
    capabilities(v1).find(({ idShort }) => idShort === 'PieceDetection'),
  );
});

test('S3 removes only PieceDetection and is functionally equivalent to S1', () => {
  const s1 = load(fixture('s1').fixture);
  const s3 = load(fixture('s3').fixture);
  assert.deepEqual(capabilities(s3), capabilities(s1));
  assert.equal(fixture('s3').functionalHash, fixture('s1').functionalHash);
  assert.equal(compareFunctionalSnapshots(buildFunctionalSnapshot(s1), buildFunctionalSnapshot(s3)).status, 'NO_CHANGE');
});

test('the retained sequential comparisons are BASELINE, ADDED and REMOVED', () => {
  const [s1, s2, s3] = artifact.steps;
  assert.equal(s1.evolution.status, 'BASELINE');
  assert.deepEqual(s1.evolution.differences, []);
  assert.equal(s2.evolution.status, 'CHANGED');
  assert.deepEqual(s2.evolution.differences.map(({ type }) => type), ['ADDED']);
  assert.equal(s2.evolution.differences[0].current.name, 'PieceDetection');
  assert.equal(s3.evolution.status, 'CHANGED');
  assert.deepEqual(s3.evolution.differences.map(({ type }) => type), ['REMOVED']);
  assert.equal(s3.evolution.differences[0].before.name, 'PieceDetection');
  assert.equal(s3.evolution.previous.functionalHash, s2.functionalHash);
});

test('the existing card is fed one sequential AAS at a time without operational actions', () => {
  const demo = fs.readFileSync('components/ExperimentalAasCycleDemo.js', 'utf8');
  assert.equal((demo.match(/<AasFunctionalCapabilitiesPreview/g) || []).length, 1);
  assert.deepEqual(artifact.steps.map(({ label }) => label), [
    'S1 — Original AAS',
    'S2 — Add PieceDetection',
    'S3 — Remove PieceDetection',
  ]);
  assert.match(demo, /evolutionSteps\.map/);
  assert.match(demo, /index !== sequenceStep \+ 1/);
  assert.match(demo, /evolutionSteps\.slice\(0, sequenceStep \+ 1\)/);
  assert.match(demo, /EXPERIMENTAL AAS EVOLUTION — NOT OPERATIONAL PPU STATE/);
  assert.doesNotMatch(demo, /plugCPS|unplugCPS|approveGovernanceProfile|playPhaseCPS|GovernanceRepository|EvolutionStore/);
});

test('the generator uses existing extraction/comparison and never reads editable-aas.json', () => {
  const generator = fs.readFileSync('scripts/experiments/build-cpslai1-three-state-evolution.mjs', 'utf8');
  assert.match(generator, /readExperimentalEditableAas/);
  assert.doesNotMatch(generator, /editable-aas\.json/);
  assert.doesNotMatch(generator, /EvolutionStore|CPSContext|GovernanceRepository|mqtt|opcua|mysql/i);
});
