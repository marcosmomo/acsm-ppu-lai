import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildFunctionalSnapshot } from '../lib/evolution/functionalNormalizer.mjs';
import { EvolutionStore, EVOLUTION_STORE_SCHEMA_VERSION } from '../lib/evolution/evolutionStore.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const loadAas = (number) => JSON.parse(fs.readFileSync(
  path.join(root, 'cps-defs', `cps-lai-0${number}-aas-acsm-compatible-revised.json`), 'utf8'));
const clone = (value) => structuredClone(value);
const capabilities = (aas) => aas.submodels.find((item) => item.idShort === 'Capabilities').submodelElements;
const instant = (seconds) => `2026-10-13T12:00:${String(seconds).padStart(2, '0')}.000Z`;

async function temporary(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'acsm-evolution-store-'));
  try {
    return await run(path.join(directory, 'evolution-store.json'));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

const capture = (cpsId, plugEventId, snapshot, seconds, overrides = {}) => ({
  cpsId,
  plugEventId,
  plugCycleId: `${cpsId}-cycle-${plugEventId}`,
  snapshot,
  capturedAt: instant(seconds),
  provenance: { source: 'CONTROLLED_TEST_FIXTURE', aasFile: `${cpsId}.json` },
  pending: snapshot.issues.filter((item) => item.severity === 'WARNING'),
  ...overrides,
});

test('persists and recovers the first documentary baseline after store recreation', async () => temporary(async (filePath) => {
  const snapshot = buildFunctionalSnapshot(loadAas(1));
  const first = await new EvolutionStore({ filePath }).recordCapture(capture('cpslai1', 'plug-1', snapshot, 1));
  assert.equal(first.comparison.status, 'BASELINE');
  assert.equal(first.promoted, true);
  assert.equal(first.snapshot.functionalVersion, 1);

  const recovered = await new EvolutionStore({ filePath }).getAcceptedBaseline('CPS-LAI-01');
  assert.equal(recovered.pointer.snapshotId, first.snapshot.snapshotId);
  assert.equal(recovered.snapshot.functionalHash, snapshot.functionalHash);
  assert.equal((await new EvolutionStore({ filePath }).inspect()).schemaVersion, EVOLUTION_STORE_SCHEMA_VERSION);
}));

test('records NO_CHANGE and advances the accepted pointer without increasing functional version', async () => temporary(async (filePath) => {
  const store = new EvolutionStore({ filePath });
  const snapshot = buildFunctionalSnapshot(loadAas(1));
  const baseline = await store.recordCapture(capture('cpslai1', 'plug-1', snapshot, 1));
  const repeated = await store.recordCapture(capture('cpslai1', 'plug-2', snapshot, 2));
  assert.equal(repeated.comparison.status, 'NO_CHANGE');
  assert.equal(repeated.snapshot.previousSnapshotId, baseline.snapshot.snapshotId);
  assert.equal(repeated.snapshot.functionalVersion, 1);
  assert.equal((await store.getAcceptedBaseline('cpslai1')).pointer.snapshotId, repeated.snapshot.snapshotId);
}));

test('records added, removed and modified capabilities as immutable CHANGED comparisons', async () => temporary(async (filePath) => {
  const variants = [];
  const original = loadAas(3);

  const added = clone(original);
  capabilities(added).push({ modelType: 'Property', idShort: 'RejectRouting', valueType: 'xs:boolean', value: 'true' });
  variants.push(['ADDED', added]);

  const removed = clone(original);
  removed.submodels.find((item) => item.idShort === 'Capabilities').submodelElements = capabilities(removed)
    .filter((item) => item.idShort !== 'StateMonitoring');
  variants.push(['REMOVED', removed]);

  const modified = clone(original);
  capabilities(modified).find((item) => item.idShort === 'PieceRouting').value = 'false';
  variants.push(['CHANGED', modified]);

  for (const [type, aas] of variants) {
    const variantFile = `${filePath}.${type}`;
    const store = new EvolutionStore({ filePath: variantFile });
    await store.recordCapture(capture('cpslai3', 'plug-1', buildFunctionalSnapshot(original), 1));
    const result = await store.recordCapture(capture('cpslai3', 'plug-2', buildFunctionalSnapshot(aas), 2));
    assert.equal(result.comparison.status, 'CHANGED');
    assert.equal(result.comparison.differences.some((item) => item.type === type), true);
    assert.equal(result.promoted, true);
    assert.equal(result.snapshot.functionalVersion, 2);
  }
}));

test('preserves multiple differences in one comparison and history remains queryable', async () => temporary(async (filePath) => {
  const original = loadAas(1);
  const current = clone(original);
  const list = capabilities(current);
  list.find((item) => item.idShort === 'ConveyorReverse').value = 'false';
  list.splice(list.findIndex((item) => item.idShort === 'SlideActuation'), 1);
  list.push({
    modelType: 'Property', idShort: 'AdaptiveRouting', valueType: 'xs:boolean', value: 'true',
    semanticId: { type: 'ExternalReference', keys: [{ type: 'GlobalReference', value: 'urn:test:capability:adaptive-routing' }] },
  });
  const store = new EvolutionStore({ filePath });
  await store.recordCapture(capture('cpslai1', 'plug-1', buildFunctionalSnapshot(original), 1));
  const result = await store.recordCapture(capture('cpslai1', 'plug-2', buildFunctionalSnapshot(current), 2));
  assert.deepEqual([...new Set(result.comparison.differences.map((item) => item.type))].sort(), ['ADDED', 'CHANGED', 'REMOVED']);
  assert.equal((await store.listComparisons({ cpsId: 'cpslai1' })).length, 2);
}));

test('incomplete snapshot is stored as INDETERMINATE and cannot replace a valid baseline', async () => temporary(async (filePath) => {
  const store = new EvolutionStore({ filePath });
  const valid = buildFunctionalSnapshot(loadAas(2));
  const baseline = await store.recordCapture(capture('cpslai2', 'plug-1', valid, 1));
  const partial = loadAas(2);
  partial.submodels = partial.submodels.filter((item) => item.idShort !== 'Capabilities');
  const result = await store.recordCapture(capture('cpslai2', 'plug-2', buildFunctionalSnapshot(partial), 2));
  assert.equal(result.comparison.status, 'INDETERMINATE');
  assert.equal(result.promoted, false);
  assert.equal(result.snapshot.functionalVersion, null);
  assert.equal((await store.getAcceptedBaseline('cpslai2')).pointer.snapshotId, baseline.snapshot.snapshotId);
}));

test('ambiguous technical identity is INDETERMINATE and is not promoted', async () => temporary(async (filePath) => {
  const original = loadAas(1);
  const renamed = clone(original);
  capabilities(renamed).find((item) => item.idShort === 'ConveyorForward').idShort = 'ForwardConveyor';
  const store = new EvolutionStore({ filePath });
  const baseline = await store.recordCapture(capture('cpslai1', 'plug-1', buildFunctionalSnapshot(original), 1));
  const result = await store.recordCapture(capture('cpslai1', 'plug-2', buildFunctionalSnapshot(renamed), 2));
  assert.equal(result.comparison.status, 'INDETERMINATE');
  assert.equal(result.comparison.reason, 'AMBIGUOUS_FUNCTIONAL_IDENTITY');
  assert.equal(result.promoted, false);
  assert.equal((await store.getAcceptedBaseline('cpslai1')).pointer.snapshotId, baseline.snapshot.snapshotId);
}));

test('identical stable identity is idempotent and a different payload raises an explicit conflict', async () => temporary(async (filePath) => {
  const store = new EvolutionStore({ filePath });
  const input = capture('cpslai1', 'plug-same', buildFunctionalSnapshot(loadAas(1)), 1);
  const first = await store.recordCapture(input);
  const duplicate = await store.recordCapture(clone(input));
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.snapshot.snapshotId, first.snapshot.snapshotId);
  assert.equal((await store.listComparisons()).length, 1);
  await assert.rejects(
    store.recordCapture({ ...clone(input), provenance: { source: 'DIFFERENT_PAYLOAD' } }),
    (error) => error.code === 'EVOLUTION_IDENTITY_CONFLICT',
  );
}));

test('pending and failed processing records are recoverable and separate from immutable history', async () => temporary(async (filePath) => {
  const snapshot = buildFunctionalSnapshot(loadAas(2));
  const store = new EvolutionStore({ filePath });
  await store.recordPending(capture('cpslai2', 'plug-pending', snapshot, 1));
  await store.recordFailure({ ...capture('cpslai2', 'plug-failed', snapshot, 2), error: new Error('controlled failure') });
  const outstanding = await new EvolutionStore({ filePath }).listProcessing();
  assert.deepEqual(outstanding.map((item) => item.state).sort(), ['FAILED', 'PENDING']);
  assert.equal((await store.listComparisons()).length, 0);
}));

test('normalizer incompatibility is recorded without inferring Evolution or promoting', async () => temporary(async (filePath) => {
  const store = new EvolutionStore({ filePath });
  const baseline = await store.recordCapture(capture('cpslai3', 'plug-1', buildFunctionalSnapshot(loadAas(3)), 1));
  const incompatible = buildFunctionalSnapshot(loadAas(3));
  incompatible.normalizationVersion = 'aas-functional-normalizer/99.0.0';
  const result = await store.recordCapture(capture('cpslai3', 'plug-2', incompatible, 2));
  assert.equal(result.comparison.status, 'INDETERMINATE');
  assert.equal(result.comparison.reason, 'ALGORITHM_VERSION_INCOMPATIBLE');
  assert.equal(result.comparison.differences.length, 0);
  assert.equal((await store.getAcceptedBaseline('cpslai3')).pointer.snapshotId, baseline.snapshot.snapshotId);
}));

test('failed temporary write preserves the previously committed history', async () => temporary(async (filePath) => {
  const seedStore = new EvolutionStore({ filePath });
  const snapshot = buildFunctionalSnapshot(loadAas(1));
  await seedStore.recordCapture(capture('cpslai1', 'plug-1', snapshot, 1));
  const before = fs.readFileSync(filePath, 'utf8');
  const failingStore = new EvolutionStore({
    filePath,
    beforeRename() { throw Object.assign(new Error('injected before rename'), { code: 'INJECTED_WRITE_FAILURE' }); },
  });
  await assert.rejects(failingStore.recordCapture(capture('cpslai1', 'plug-2', snapshot, 2)), /injected before rename/);
  assert.equal(fs.readFileSync(filePath, 'utf8'), before);
  assert.equal((await seedStore.listComparisons()).length, 1);
  assert.equal(fs.readdirSync(path.dirname(filePath)).some((name) => name.endsWith('.tmp')), false);
}));

test('concurrent attempts on separate instances are serialized without lost updates', async () => temporary(async (filePath) => {
  const snapshot = buildFunctionalSnapshot(loadAas(1));
  const stores = [new EvolutionStore({ filePath }), new EvolutionStore({ filePath }), new EvolutionStore({ filePath })];
  const results = await Promise.all(stores.map((store, index) =>
    store.recordCapture(capture('cpslai1', `plug-${index + 1}`, snapshot, index + 1))));
  assert.equal(results.filter((item) => item.comparison.status === 'BASELINE').length, 1);
  assert.equal(results.filter((item) => item.comparison.status === 'NO_CHANGE').length, 2);
  const document = await stores[0].inspect();
  assert.equal(Object.keys(document.snapshots).length, 3);
  assert.equal(Object.keys(document.comparisons).length, 3);
  assert.equal(document.revision, 3);
}));

test('corrupt history is detected and preserved instead of silently reset', async () => temporary(async (filePath) => {
  fs.writeFileSync(filePath, '{broken-json', 'utf8');
  const before = fs.readFileSync(filePath, 'utf8');
  await assert.rejects(new EvolutionStore({ filePath }).inspect(), (error) => error.code === 'EVOLUTION_STORE_CORRUPT');
  assert.equal(fs.readFileSync(filePath, 'utf8'), before);
}));

test('store implementation is isolated from governance, Plug, HCM, PPU and MySQL', () => {
  const source = fs.readFileSync(path.join(root, 'lib', 'evolution', 'evolutionStore.mjs'), 'utf8');
  assert.doesNotMatch(source, /governanceStore|governance-store|plug-phase-log|CPSContext|play-gate|cognitive|HCM|ppuOutbox|mysql/i);
});
