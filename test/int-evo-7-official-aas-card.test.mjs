import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import projectionArtifact from '../docs/experiments/int-evo-7-cpslai1-official-aas-projection.json' with { type: 'json' };
import { buildAasFunctionalCardPresentation } from '../lib/evolution/aasFunctionalCardPresentation.mjs';
import { buildEvolutionCycleReadModel } from '../lib/evolution/evolutionCycleReadModel.mjs';
import { CPSLAI1_OFFICIAL_AAS_REFERENCE } from '../lib/evolution/officialAasCatalog.mjs';

const document = { ...projectionArtifact.document, verifiedContentHash: projectionArtifact.verification.catalogContentHash };
const projectRoot = path.resolve('.');
const identity = { cpsId: 'cpslai1', plugEventId: 'plug-event-1', plugCycleId: 'cycle-1', profileId: 'profile-1' };

function cycleReadModel(overrides = {}) {
  return buildEvolutionCycleReadModel({
    cycleAuthority: { identity, lifecyclePhase: 'plug', cycleState: 'ACTIVE', governanceStatus: 'PENDING_APPROVAL' },
    lifecycle: { ...identity, lifecyclePhase: 'plug', cycleState: 'ACTIVE' },
    governance: { ...identity, governanceStatus: 'PENDING_APPROVAL' },
    aas: {
      aasId: document.aasId, assetId: document.assetId, version: document.version,
      contentHash: document.contentHash, sourceType: document.sourceType,
      provenance: { sourceId: document.sourceId, sourceType: document.sourceType, operational: false },
      capabilities: document.capabilities, services: document.services,
    },
    ...overrides,
  });
}

test('official AAS source artifact is hash-valid and contains extracted functional declarations', () => {
  const documentPath = path.join(projectRoot, 'cps-defs', CPSLAI1_OFFICIAL_AAS_REFERENCE.locator);
  const bytes = fs.readFileSync(documentPath);
  const actualHash = createHash('sha256').update(bytes).digest('hex');
  assert.equal(actualHash, CPSLAI1_OFFICIAL_AAS_REFERENCE.contentHash);
  assert.equal(document.contentHash, actualHash);
  assert.equal(document.sourceType, 'OFFICIAL_STATIC_DOCUMENT');
  assert.equal(document.operational, false);
  assert.equal(document.capabilities.length, 5);
  assert.equal(document.services.length, 13);
  assert.equal(document.capabilities.some((item) => item.name.includes('Experimental')), false);
});

test('verified official document is shown as preview and Evolution remains unavailable', () => {
  const presentation = buildAasFunctionalCardPresentation({ cpsId: 'cpslai1', document });
  assert.equal(presentation.state, 'DOCUMENT_PREVIEW');
  assert.equal(presentation.aas.aasId, document.aasId);
  assert.equal(presentation.aas.capabilities.length, 5);
  assert.equal(presentation.evolution.status, 'NOT_AVAILABLE');
});

test('only full correlated cycle identity and matching AAS reference produce BOUND', () => {
  const binding = {
    ...identity, aasId: document.aasId, assetId: document.assetId, aasHash: document.contentHash,
    aasVersion: document.administration.version, sourceType: document.sourceType,
  };
  const bound = buildAasFunctionalCardPresentation({ cpsId: 'cpslai1', document, binding, cycleReadModel: cycleReadModel() });
  assert.equal(bound.state, 'BOUND');
  assert.equal(bound.binding.plugCycleId, identity.plugCycleId);
  assert.equal(bound.aas.capabilities.length, 5);
  assert.equal(bound.evolution.status, 'NOT_AVAILABLE');

  const uncorrelated = buildAasFunctionalCardPresentation({
    cpsId: 'cpslai1', document, binding,
    cycleReadModel: buildEvolutionCycleReadModel({ lifecycle: { cpsId: 'cpslai1', lifecyclePhase: 'plug' } }),
  });
  assert.equal(uncorrelated.state, 'DOCUMENT_PREVIEW');
});

test('bad document hash, wrong CPS and conflicting cycle data are never displayed', () => {
  assert.equal(buildAasFunctionalCardPresentation({ cpsId: 'cpslai1', document: { ...document, contentHash: 'f'.repeat(64) } }).state, 'CONFLICT');
  assert.equal(buildAasFunctionalCardPresentation({ cpsId: 'cpslai2', document }).state, 'CONFLICT');
  const binding = {
    ...identity, aasId: document.aasId, assetId: document.assetId, aasHash: document.contentHash,
    aasVersion: document.administration.version, sourceType: document.sourceType,
  };
  const conflict = buildAasFunctionalCardPresentation({
    cpsId: 'cpslai1', document, binding,
    cycleReadModel: { ...cycleReadModel(), identityCorrelationStatus: 'CONFLICT' },
  });
  assert.equal(conflict.state, 'CONFLICT');
  assert.equal(conflict.aas, null);
});

test('OperatingMode data has no effect on declared capability projection', () => {
  const first = buildAasFunctionalCardPresentation({ cpsId: 'cpslai1', document });
  const secondReadModel = cycleReadModel({ lifecycle: { ...identity, lifecyclePhase: 'plug', cycleState: 'ACTIVE', operatingMode: 'ABSTRACT_MODE_B' } });
  const second = buildAasFunctionalCardPresentation({ cpsId: 'cpslai1', document, cycleReadModel: secondReadModel });
  assert.deepEqual(second.aas.capabilities, first.aas.capabilities);
  assert.equal(second.evolution.status, 'NOT_AVAILABLE');
});

test('Plug Phase card imports only sanitized static projection and no operational action', () => {
  const component = fs.readFileSync(path.resolve('components/AasFunctionalCapabilitiesPreview.js'), 'utf8');
  const plug = fs.readFileSync(path.resolve('components/PlugFase.js'), 'utf8');
  assert.match(component, /int-evo-7-cpslai1-official-aas-projection\.json/);
  assert.match(component, /AAS DOCUMENT AVAILABLE — NOT BOUND TO PPU CYCLE/);
  assert.match(component, /DOCUMENT PREVIEW ONLY/);
  assert.match(component, /AAS BOUND TO PPU CYCLE/);
  assert.doesNotMatch(component, /node:fs|node:crypto|experimentalAasPreview|fetch\s*\(|EvolutionStore|governanceStore/i);
  assert.match(plug, /<ExperimentalAasCycleDemo cpsId=\{cps\.id\} \/>/);
});
