import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import artifact from '../docs/experiments/avm7-cpslai1-functional-projection.json' with { type: 'json' };
import { buildExperimentalAasCyclePresentation } from '../lib/evolution/experimentalAasPreview.mjs';
import { buildEvolutionCycleReadModel } from '../lib/evolution/evolutionCycleReadModel.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const identity = { cpsId: 'cpslai1', plugEventId: 'event-1', plugCycleId: 'cycle-1', profileId: 'profile-1' };

function fixture(version, overrides = {}) {
  const source = artifact.versions.find((item) => item.version === version);
  const binding = {
    ...identity, aasId: source.aasId, aasHash: source.sha256, aasVersion: version,
    sourceType: source.sourceClassification, correlationStatus: 'CORRELATED',
    ...(overrides.binding || {}),
  };
  const authorityIdentity = { ...identity, ...(overrides.authorityIdentity || {}) };
  const cycleReadModel = buildEvolutionCycleReadModel({
    cycleAuthority: { identity: authorityIdentity, lifecyclePhase: 'plug', cycleState: 'ACTIVE', governanceStatus: 'PENDING_APPROVAL' },
    aas: {
      aasId: source.aasId, assetId: source.assetId, version, contentHash: source.sha256,
      sourceType: source.sourceClassification, capabilities: source.capabilities, services: source.services,
    },
    evolution: overrides.evolution,
  });
  return { binding, cycleReadModel };
}

test('missing binding is UNBOUND and missing CPS data is UNAVAILABLE', () => {
  const unbound = buildExperimentalAasCyclePresentation({ cpsId: 'cpslai1' });
  assert.equal(unbound.state, 'UNBOUND');
  assert.equal(unbound.aas, null);
  assert.equal(unbound.evolution.status, 'NOT_AVAILABLE');
  const unavailable = buildExperimentalAasCyclePresentation();
  assert.equal(unavailable.state, 'UNAVAILABLE');
  assert.equal(unavailable.aas, null);
});

test('complete V1, V2 and V3 fixtures bind exactly one matching AAS', () => {
  for (const [version, count] of [['v1', 6], ['v2', 6], ['v3', 7]]) {
    const presentation = buildExperimentalAasCyclePresentation({ cpsId: 'cpslai1', ...fixture(version) });
    assert.equal(presentation.state, 'BOUND');
    assert.equal(presentation.aas.version, version);
    assert.equal(presentation.aas.capabilities.length, count);
    assert.equal(presentation.binding.plugCycleId, 'cycle-1');
    assert.equal(presentation.boundToOperationalPlugCycle, true);
    assert.equal(presentation.evolution.status, 'NOT_AVAILABLE');
  }
});

test('event, profile and hash divergence reject the binding', () => {
  const cases = [
    fixture('v1', { authorityIdentity: { plugEventId: 'other-event' } }),
    fixture('v2', { authorityIdentity: { profileId: 'other-profile' } }),
    fixture('v3', { binding: { aasHash: 'f'.repeat(64) } }),
  ];
  for (const candidate of cases) {
    const presentation = buildExperimentalAasCyclePresentation({ cpsId: 'cpslai1', ...candidate });
    assert.equal(presentation.state, 'UNBOUND');
    assert.equal(presentation.reason, 'AAS_BINDING_REJECTED');
    assert.equal(presentation.aas, null);
  }
});

test('Evolution is shown only when supplied by the correlated read model', () => {
  const absent = buildExperimentalAasCyclePresentation({ cpsId: 'cpslai1', ...fixture('v1') });
  assert.equal(absent.evolution.status, 'NOT_AVAILABLE');
  const available = buildExperimentalAasCyclePresentation({ cpsId: 'cpslai1', ...fixture('v2', { evolution: { ...identity, status: 'CHANGED', snapshotId: 'snap', comparisonId: 'cmp', differences: [] } }) });
  assert.equal(available.evolution.status, 'CHANGED');
});

test('experimental preview projector retains correlation rules without operational access', () => {
  const source = read('components/AasFunctionalCapabilitiesPreview.js');
  assert.doesNotMatch(source, /<select|useState|initialVersion|setSelectedVersion/);
  assert.doesNotMatch(source, /fetch\s*\(|XMLHttpRequest|WebSocket|EventSource|useCPSContext|plugCPS|addCPS|unplugCPS|GovernanceRepository|EvolutionStore|OPC|MQTT/i);
  const projection = read('lib/evolution/experimentalAasPreview.mjs');
  assert.match(projection, /IDENTITY_CORRELATION_STATUS/);
  assert.doesNotMatch(projection, /governanceStore|GovernanceRepository|EvolutionStore|FunctionalExtractor|EvolutionCoordinator|node:fs|fetch\s*\(/i);
  assert.doesNotMatch(source, /experimentalAasPreview/);
});

test('PlugFase supplies only CPS identity to the isolated demo and leaves existing controls unchanged', () => {
  const source = read('components/PlugFase.js');
  const discovered = source.indexOf('Discovered Capabilities');
  const card = source.indexOf('<ExperimentalAasCycleDemo cpsId={cps.id} />');
  const evidence = source.indexOf('Lifecycle Evidence', card);
  assert.ok(discovered >= 0 && card > discovered && evidence > card);
  assert.match(source, /onClick=\{\(\) => handlePlug\(cps\)\}/);
  assert.match(source, /const ok = await addCPS\(name\)/);
  assert.match(source, /const ok = await unplugCPS\(cps\?\.id \|\| cps\?\.cpsId\)/);
});
