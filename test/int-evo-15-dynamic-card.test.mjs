import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import artifact from '../docs/experiments/int-evo-15-card-projections.json' with { type: 'json' };
import { buildAasFunctionalCardPresentationFromCycleQuery } from '../lib/evolution/aasFunctionalCardPresentation.mjs';

const byId = Object.fromEntries(artifact.scenarios.map((scenario) => [scenario.id, scenario]));

test('pre-generated artifact is explicitly experimental, read-only and covers required sequence', () => {
  assert.equal(artifact.scope, 'PREGENERATED_EXPERIMENTAL_READ_ONLY_DEMONSTRATION');
  assert.equal(artifact.simulation, true);
  assert.equal(artifact.operational, false);
  assert.equal(artifact.physicalExecution, false);
  assert.deepEqual(artifact.scenarios.map(({ id }) => id), ['baseline', 'unplug-history', 'no-change', 'changed', 'conflict']);
});

test('BASELINE, NO_CHANGE and CHANGED are correlated to distinct immutable cycles and one AAS each', () => {
  const expected = { baseline: 'BASELINE', 'no-change': 'NO_CHANGE', changed: 'CHANGED' };
  const cycleIds = new Set();
  const profileIds = new Set();
  for (const [id, evolutionStatus] of Object.entries(expected)) {
    const projection = byId[id].projection;
    const card = buildAasFunctionalCardPresentationFromCycleQuery({ cpsId: 'cpslai1', projection });
    assert.equal(projection.correlationStatus, 'CORRELATED');
    assert.equal(projection.bindingStatus, 'BOUND');
    assert.equal(projection.evolutionStatus, evolutionStatus);
    assert.equal(card.state, 'BOUND');
    assert.equal(card.evolution.status, evolutionStatus);
    assert.match(card.aas.sourceType, /EXPERIMENTAL/);
    assert.equal(card.aas.contentHash, projection.readModel.aas.contentHash);
    cycleIds.add(card.binding.plugCycleId);
    profileIds.add(card.binding.profileId);
  }
  assert.equal(cycleIds.size, 3);
  assert.equal(profileIds.size, 3);
});

test('Unplug preserves the exact historical AAS without creating new Evolution', () => {
  const active = byId.baseline.projection;
  const closed = byId['unplug-history'].projection;
  assert.deepEqual(closed.identity, active.identity);
  assert.equal(closed.aas.contentHash, active.aas.contentHash);
  assert.equal(closed.evolution.comparisonId, active.evolution.comparisonId);
  assert.equal(closed.evolutionStatus, 'BASELINE');
  assert.equal(closed.cycle.state, 'CLOSED');
});

test('divergent profile and hash fail closed while absence falls back to document preview', () => {
  const conflict = buildAasFunctionalCardPresentationFromCycleQuery({ cpsId: 'cpslai1', projection: byId.conflict.projection });
  assert.equal(conflict.state, 'CONFLICT');

  const hashConflict = structuredClone(byId.changed.projection);
  hashConflict.aas.contentHash = 'f'.repeat(64);
  assert.equal(buildAasFunctionalCardPresentationFromCycleQuery({ cpsId: 'cpslai1', projection: hashConflict }).state, 'CONFLICT');

  assert.equal(buildAasFunctionalCardPresentationFromCycleQuery({ cpsId: 'cpslai1', projection: null }), null);
});

test('main UI has one card, local-only controls and no operational or physical dependency', () => {
  const plug = fs.readFileSync('components/PlugFase.js', 'utf8');
  const demo = fs.readFileSync('components/ExperimentalAasCycleDemo.js', 'utf8');
  assert.equal((demo.match(/<AasFunctionalCapabilitiesPreview/g) || []).length, 1);
  assert.equal((plug.match(/<ExperimentalAasCycleDemo/g) || []).length, 1);
  assert.match(demo, /useState\('document'\)/);
  assert.match(demo, /NO OPERATIONAL EFFECT/);
  assert.match(demo, /fetch\('\/api\/experiments\/aas\/cpslai1', \{ method: 'GET'/);
  assert.doesNotMatch(demo, /useCPSContext|XMLHttpRequest|WebSocket|EventSource|plugCPS|unplugCPS|approveGovernanceProfile|GovernanceRepository|EvolutionStore|MQTT|OPC|MySQL/i);
  assert.doesNotMatch(demo, /<select/);
});

test('artifact builder uses isolated INT-EVO composition and no operational Store or route', () => {
  const builder = fs.readFileSync('scripts/experiments/build-int-evo-15-card-projections.mjs', 'utf8');
  assert.match(builder, /createStack/);
  assert.match(builder, /composition\.acceptPlug/);
  assert.match(builder, /composition\.unplug/);
  assert.match(builder, /composition\.readCycle/);
  assert.match(builder, /mkdtempSync/);
  assert.doesNotMatch(builder, /governanceStore|CPSContext|app\/api|mqtt|opcua|mysql/i);
});
