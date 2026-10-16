import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import artifact from '../docs/experiments/int-evo-7-cpslai1-official-aas-projection.json' with { type: 'json' };
import {
  buildAasFunctionalCardPresentation,
  buildAasFunctionalCardPresentationFromCycleQuery,
} from '../lib/evolution/aasFunctionalCardPresentation.mjs';
import { buildEvolutionCycleReadModel } from '../lib/evolution/evolutionCycleReadModel.mjs';

const official = { ...artifact.document, verifiedContentHash: artifact.verification.catalogContentHash };
const identity = { cpsId: 'cpslai1', plugEventId: 'event-14', plugCycleId: 'cycle-14', profileId: 'profile-14' };

function queryProjection({ evolution = null, identityOverride = {}, hash = official.contentHash } = {}) {
  const projectedIdentity = { ...identity, ...identityOverride };
  const aas = { ...official, contentHash: hash };
  const readModel = buildEvolutionCycleReadModel({
    cycleAuthority: { identity: projectedIdentity, lifecyclePhase: 'plug', cycleState: 'ACTIVE', governanceStatus: 'PENDING_APPROVAL' },
    aas: { ...aas, provenance: { sourceId: aas.sourceId, sourceType: aas.sourceType }, operational: false },
    evolution,
  });
  return {
    correlationStatus: readModel.identityCorrelationStatus,
    bindingStatus: 'BOUND',
    identity: projectedIdentity,
    aas,
    readModel,
  };
}

test('official document preview has five declared capabilities and no Evolution classification', () => {
  const card = buildAasFunctionalCardPresentation({ cpsId: 'cpslai1', document: official });
  assert.equal(card.state, 'DOCUMENT_PREVIEW');
  assert.equal(card.aas.capabilities.length, 5);
  assert.equal(card.aas.evidenceLevel, 'DECLARED_ONLY');
  assert.equal(card.evolution.status, 'NOT_AVAILABLE');
});

test('exact correlated query projection shows its single AAS and available Evolution', () => {
  const evolution = { ...identity, status: 'CHANGED', snapshotId: 'snapshot-14', comparisonId: 'comparison-14', differences: [] };
  const card = buildAasFunctionalCardPresentationFromCycleQuery({ cpsId: 'cpslai1', projection: queryProjection({ evolution }) });
  assert.equal(card.state, 'BOUND');
  assert.equal(card.binding.profileId, identity.profileId);
  assert.equal(card.aas.aasId, official.aasId);
  assert.equal(card.evolution.status, 'CHANGED');
});

test('unprocessed Evolution stays unavailable and hash/profile divergence is rejected', () => {
  const unprocessed = buildAasFunctionalCardPresentationFromCycleQuery({ cpsId: 'cpslai1', projection: queryProjection() });
  assert.equal(unprocessed.state, 'BOUND');
  assert.equal(unprocessed.evolution.status, 'NOT_AVAILABLE');

  const wrongHash = queryProjection({ hash: 'f'.repeat(64) });
  wrongHash.readModel.aas.contentHash = official.contentHash;
  assert.equal(buildAasFunctionalCardPresentationFromCycleQuery({ cpsId: 'cpslai1', projection: wrongHash }).state, 'CONFLICT');

  const wrongProfile = queryProjection({ identityOverride: { profileId: 'wrong-profile' } });
  wrongProfile.readModel.identity.profileId = identity.profileId;
  assert.equal(buildAasFunctionalCardPresentationFromCycleQuery({ cpsId: 'cpslai1', projection: wrongProfile }).state, 'CONFLICT');
});

test('card remains selection-free, mode-independent, read-only, and governance-neutral', () => {
  const component = fs.readFileSync('components/AasFunctionalCapabilitiesPreview.js', 'utf8');
  const plug = fs.readFileSync('components/PlugFase.js', 'utf8');
  const governance = fs.readFileSync('services/governance/governanceStore.js', 'utf8');
  assert.doesNotMatch(component, /<select|useState|OperatingMode|fetch\s*\(|plugCPS|Play-gate|EvolutionStore|governanceStore/i);
  assert.match(component, /EXPERIMENTAL PPU CYCLE/);
  assert.match(component, /Total/);
  assert.match(plug, /<ExperimentalAasCycleDemo cpsId=\{cps\.id\} \/>/);
  assert.match(governance, /human-operator/);
});
