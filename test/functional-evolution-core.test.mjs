import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractFunctionalDeclarations, FUNCTIONAL_EXTRACTION_VERSION } from '../lib/evolution/functionalExtractor.mjs';
import { buildFunctionalSnapshot, FUNCTIONAL_NORMALIZATION_VERSION } from '../lib/evolution/functionalNormalizer.mjs';
import { compareFunctionalSnapshots, FUNCTIONAL_COMPARISON_VERSION } from '../lib/evolution/functionalComparator.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const aasFiles = [1, 2, 3].map((number) =>
  path.join(root, 'cps-defs', `cps-lai-0${number}-aas-acsm-compatible-revised.json`));
const load = (index) => JSON.parse(fs.readFileSync(aasFiles[index - 1], 'utf8'));
const clone = (value) => structuredClone(value);
const submodel = (aas, idShort) => aas.submodels.find((item) => item.idShort === idShort);

test('builds a valid deterministic baseline for all three heterogeneous CPS AAS documents', () => {
  for (const index of [1, 2, 3]) {
    const snapshot = buildFunctionalSnapshot(load(index));
    const comparison = compareFunctionalSnapshots(null, snapshot);
    assert.equal(snapshot.extractionVersion, FUNCTIONAL_EXTRACTION_VERSION);
    assert.equal(snapshot.normalizationVersion, FUNCTIONAL_NORMALIZATION_VERSION);
    assert.equal(comparison.comparisonVersion, FUNCTIONAL_COMPARISON_VERSION);
    assert.equal(snapshot.completeness, 'COMPLETE_WITH_WARNINGS');
    assert.equal(snapshot.declarations.some((item) => item.kind === 'CAPABILITY'), true);
    assert.equal(snapshot.declarations.some((item) => item.kind === 'SERVICE'), true);
    assert.equal(comparison.status, 'BASELINE');
    assert.equal(buildFunctionalSnapshot(load(index)).functionalHash, snapshot.functionalHash);
  }
});
test('same declaration, reordered JSON and operational timestamp changes are NO_CHANGE', () => {
  const original = load(1);
  const changed = clone(original);
  changed.submodels.reverse();
  submodel(changed, 'Capabilities').submodelElements.reverse();
  const lifecycle = submodel(changed, 'LifecycleIntegration');
  lifecycle.submodelElements.find((item) => item.idShort === 'LastEvolutionTimestamp').value = '2099-01-01T00:00:00.000Z';
  assert.equal(compareFunctionalSnapshots(buildFunctionalSnapshot(original), buildFunctionalSnapshot(changed)).status, 'NO_CHANGE');
});

test('detects an added capability', () => {
  const before = load(1);
  const current = clone(before);
  submodel(current, 'Capabilities').submodelElements.push({
    modelType: 'Property', idShort: 'AdaptiveRouting', valueType: 'xs:boolean', value: 'true',
  });
  const result = compareFunctionalSnapshots(buildFunctionalSnapshot(before), buildFunctionalSnapshot(current));
  assert.equal(result.status, 'CHANGED');
  assert.equal(result.differences.filter((item) => item.type === 'ADDED').length, 1);
});

test('detects a removed capability only from a complete current declaration', () => {
  const before = load(3);
  const current = clone(before);
  const capabilities = submodel(current, 'Capabilities');
  capabilities.submodelElements = capabilities.submodelElements.filter((item) => item.idShort !== 'PieceRouting');
  const result = compareFunctionalSnapshots(buildFunctionalSnapshot(before), buildFunctionalSnapshot(current));
  assert.equal(result.status, 'CHANGED');
  assert.equal(result.differences.some((item) => item.type === 'REMOVED' && /PieceRouting/i.test(item.before.source.path)), true);
});

test('detects a modified functional parameter as CHANGED', () => {
  const before = load(1);
  const current = clone(before);
  submodel(current, 'Capabilities').submodelElements.find((item) => item.idShort === 'ConveyorReverse').value = 'false';
  const result = compareFunctionalSnapshots(buildFunctionalSnapshot(before), buildFunctionalSnapshot(current));
  assert.equal(result.status, 'CHANGED');
  assert.equal(result.differences.some((item) => item.type === 'CHANGED'), true);
});

test('returns multiple simultaneous changes deterministically', () => {
  const before = load(3);
  const current = clone(before);
  const capabilities = submodel(current, 'Capabilities');
  capabilities.submodelElements = capabilities.submodelElements.filter((item) => item.idShort !== 'StateMonitoring');
  capabilities.submodelElements.find((item) => item.idShort === 'PieceDetection').value = 'false';
  capabilities.submodelElements.push({ modelType: 'Property', idShort: 'RejectRouting', valueType: 'xs:boolean', value: 'true' });
  const first = compareFunctionalSnapshots(buildFunctionalSnapshot(before), buildFunctionalSnapshot(current));
  const second = compareFunctionalSnapshots(buildFunctionalSnapshot(before), buildFunctionalSnapshot(current));
  assert.equal(first.status, 'CHANGED');
  assert.deepEqual(first, second);
  assert.deepEqual([...new Set(first.differences.map((item) => item.type))].sort(), ['ADDED', 'CHANGED', 'REMOVED']);
});

test('preserves pending binding evidence without interpreting communication as removal', () => {
  const extraction = extractFunctionalDeclarations(load(2));
  const joining = extraction.declarations.find((item) => item.kind === 'CAPABILITY');
  assert.equal(joining.evidence.level, 'DECLARED_ONLY');
  assert.equal(joining.evidence.bindingStatus, 'PENDING');
  assert.equal(joining.evidence.physicallyValidated, false);
  assert.equal(extraction.completeness, 'COMPLETE_WITH_WARNINGS');
});

test('missing ECLASS is an optional warning and does not invalidate a documented baseline', () => {
  const snapshot = buildFunctionalSnapshot(load(2));
  assert.equal(snapshot.issues.some((item) => item.code === 'OPTIONAL_SEMANTIC_ID_MISSING'), true);
  assert.equal(snapshot.completeness, 'COMPLETE_WITH_WARNINGS');
  assert.equal(compareFunctionalSnapshots(null, snapshot).status, 'BASELINE');
});

test('partial or inconsistent AAS makes comparison INDETERMINATE and never REMOVED', () => {
  const before = buildFunctionalSnapshot(load(1));
  const partial = load(1);
  partial.submodels = partial.submodels.filter((item) => item.idShort !== 'Capabilities');
  const current = buildFunctionalSnapshot(partial);
  const result = compareFunctionalSnapshots(before, current);
  assert.equal(current.completeness, 'INCOMPLETE');
  assert.equal(result.status, 'INDETERMINATE');
  assert.equal(result.differences.length, 0);
});

test('idShort-only rename without semantic identity is reported as ambiguous', () => {
  const before = load(1);
  const current = clone(before);
  submodel(current, 'Capabilities').submodelElements.find((item) => item.idShort === 'ConveyorForward').idShort = 'ForwardConveyor';
  const result = compareFunctionalSnapshots(buildFunctionalSnapshot(before), buildFunctionalSnapshot(current));
  assert.equal(result.status, 'INDETERMINATE');
  assert.equal(result.reason, 'AMBIGUOUS_FUNCTIONAL_IDENTITY');
  assert.equal(result.ambiguities.length, 1);
  assert.equal(result.differences.some((item) => ['ADDED', 'REMOVED'].includes(item.type)), false);
});
