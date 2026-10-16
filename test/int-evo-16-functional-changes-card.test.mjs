import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import artifact from '../docs/experiments/int-evo-15-card-projections.json' with { type: 'json' };
import {
  buildAasFunctionalCardPresentationFromCycleQuery,
  buildFunctionalChangesPresentation,
} from '../lib/evolution/aasFunctionalCardPresentation.mjs';

const changedProjection = artifact.scenarios.find(({ id }) => id === 'changed').projection;
const difference = (type, before, current, identity = `functional:${type.toLowerCase()}`) => ({ type, identity, before, current });
const declaration = (name, attributes = {}, kind = 'CAPABILITY') => ({ name, kind, attributes });

test('BASELINE, NO_CHANGE and INDETERMINATE produce only their truthful state messages', () => {
  assert.deepEqual(buildFunctionalChangesPresentation({ status: 'BASELINE', differences: [] }), {
    status: 'BASELINE', message: 'First known functional configuration.', differences: [],
  });
  assert.deepEqual(buildFunctionalChangesPresentation({ status: 'NO_CHANGE', differences: [] }), {
    status: 'NO_CHANGE', message: 'No functional differences identified.', differences: [],
  });
  const indeterminate = buildFunctionalChangesPresentation({
    status: 'INDETERMINATE',
    differences: [difference('REMOVED', declaration('UnprovenRemoval'), null)],
  });
  assert.equal(indeterminate.message, 'Evidence does not allow a reliable functional comparison.');
  assert.deepEqual(indeterminate.differences, []);
});

test('CHANGED presents generic true-to-false functional attributes from comparator output', () => {
  const result = buildFunctionalChangesPresentation({
    status: 'CHANGED',
    differences: [difference('CHANGED',
      declaration('GenericCapability', { supportsFeature: { value: 'true', valueType: 'xs:boolean' } }),
      declaration('GenericCapability', { supportsFeature: { value: 'false', valueType: 'xs:boolean' } }))],
  });
  assert.equal(result.differences[0].type, 'CHANGED');
  assert.equal(result.differences[0].name, 'GenericCapability');
  assert.deepEqual(result.differences[0].attributes, [{ name: 'supportsFeature', before: 'true', current: 'false' }]);
});

test('ADDED, REMOVED and multiple simultaneous differences retain comparator order and declaration kind', () => {
  const result = buildFunctionalChangesPresentation({ status: 'CHANGED', differences: [
    difference('ADDED', null, declaration('AddedService', {}, 'SERVICE'), 'service:added'),
    difference('REMOVED', declaration('RemovedCapability'), null, 'capability:removed'),
    difference('CHANGED', declaration('ChangedCapability', { level: { value: '1' } }), declaration('ChangedCapability', { level: { value: '2' } }), 'capability:changed'),
  ] });
  assert.deepEqual(result.differences.map(({ type }) => type), ['ADDED', 'REMOVED', 'CHANGED']);
  assert.equal(result.differences[0].name, 'AddedService');
  assert.equal(result.differences[0].kind, 'SERVICE');
  assert.equal(result.differences[1].name, 'RemovedCapability');
  assert.deepEqual(result.differences[2].attributes, [{ name: 'level', before: '1', current: '2' }]);
});

test('absent, unavailable and conflicting Evolution never produce a changes section model', () => {
  for (const evolution of [null, { status: 'EVOLUTION_NOT_PROCESSED' }, { status: 'UNAVAILABLE' }, { status: 'CONFLICT' }]) {
    assert.equal(buildFunctionalChangesPresentation(evolution), null);
  }
});

test('comparison metadata divergent from the exact query cycle fails closed', () => {
  const otherComparison = structuredClone(changedProjection);
  otherComparison.evolution.comparisonId = 'comparison-from-another-cycle';
  const card = buildAasFunctionalCardPresentationFromCycleQuery({ cpsId: 'cpslai1', projection: otherComparison });
  assert.equal(card.state, 'CONFLICT');
  assert.equal(card.reason, 'EVOLUTION_QUERY_PROJECTION_CONFLICT');
  assert.equal(card.aas, null);
});

test('card renders one compact section and retains experimental, declaration and service boundaries', () => {
  const source = fs.readFileSync('components/AasFunctionalCapabilitiesPreview.js', 'utf8');
  assert.equal((source.match(/<section className="aas-functional-changes"/g) || []).length, 1);
  assert.match(source, /Functional Changes Detected/);
  assert.match(source, /EXPERIMENTAL PPU CYCLE/);
  assert.match(source, /DECLARED ONLY/);
  assert.match(source, /aas-functional-preview-services/);
  assert.doesNotMatch(source, /useCPSContext|OperatingMode|fetch\s*\(|EvolutionStore|governanceStore|mqtt|opcua|mysql/i);
});

test('presentation-only change leaves operational APIs and Stores outside its dependency graph', () => {
  const presenter = fs.readFileSync('lib/evolution/aasFunctionalCardPresentation.mjs', 'utf8');
  assert.doesNotMatch(presenter, /CPSContext|GovernanceRepository|EvolutionStore|governanceStore|app\/api|fetch\s*\(|mqtt|opcua|mysql/i);
  assert.doesNotMatch(presenter, /functionalComparator|compareFunctional/);
});
