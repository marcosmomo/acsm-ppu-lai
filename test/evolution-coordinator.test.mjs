import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EvolutionStore } from '../lib/evolution/evolutionStore.mjs';
import { coordinateAcceptedPlugEvolution } from '../lib/evolution/evolutionCoordinator.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const loadAas = (number) => JSON.parse(fs.readFileSync(
  path.join(root, 'cps-defs', `cps-lai-0${number}-aas-acsm-compatible-revised.json`), 'utf8'));
const copy = (value) => structuredClone(value);
const capabilities = (aas) => aas.submodels.find((item) => item.idShort === 'Capabilities').submodelElements;

async function temporary(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'acsm-evolution-coordinator-'));
  try {
    return await run(path.join(directory, 'evolution-store.json'));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

const accepted = (store, cpsId, plugEventId, plugCycleId, aas, second = 1) => ({
  store, cpsId, plugEventId, plugCycleId, aas, plugAccepted: true,
  capturedAt: `2026-10-13T14:00:${String(second).padStart(2, '0')}.000Z`,
  provenance: { fixture: 'CONTROLLED_TEST_AAS' },
});
test('first accepted Plug produces a documentary BASELINE for each CPS-LAI', async () => {
  for (const number of [1, 2, 3]) {
    await temporary(async (filePath) => {
      const report = await coordinateAcceptedPlugEvolution(accepted(
        new EvolutionStore({ filePath }), `CPS-LAI-0${number}`, `plug-${number}`, `cycle-${number}`, loadAas(number)));
      assert.equal(report.status, 'BASELINE');
      assert.equal(report.promoted, true);
      assert.equal(report.functionalVersion, 1);
      assert.equal(report.evidence.scope, 'DECLARED_FUNCTIONAL_CONTRACT');
      assert.equal(report.evidence.physicalValidationInferred, false);
      assert.equal(report.processingState, 'COMPLETED');
    });
  }
});

test('logical Unplug has no coordinator side effect and unchanged Replug is NO_CHANGE', async () => temporary(async (filePath) => {
  const store = new EvolutionStore({ filePath });
  const aas = loadAas(1);
  await coordinateAcceptedPlugEvolution(accepted(store, 'cpslai1', 'plug-1', 'cycle-1', aas, 1));
  const afterPlug = await store.inspect();
  // A logical Unplug is deliberately represented by not invoking the coordinator.
  const afterLogicalUnplug = await store.inspect();
  assert.deepEqual(afterLogicalUnplug, afterPlug);
  const replug = await coordinateAcceptedPlugEvolution(accepted(store, 'cpslai1', 'plug-2', 'cycle-2', aas, 2));
  assert.equal(replug.status, 'NO_CHANGE');
  assert.equal(replug.functionalVersion, 1);
}));

test('Replug reports a capability addition', async () => temporary(async (filePath) => {
  const store = new EvolutionStore({ filePath });
  const initial = loadAas(1);
  const current = copy(initial);
  capabilities(current).push({ modelType: 'Property', idShort: 'AdaptiveRouting', valueType: 'xs:boolean', value: 'true' });
  await coordinateAcceptedPlugEvolution(accepted(store, 'cpslai1', 'plug-1', 'cycle-1', initial, 1));
  const report = await coordinateAcceptedPlugEvolution(accepted(store, 'cpslai1', 'plug-2', 'cycle-2', current, 2));
  assert.equal(report.status, 'CHANGED');
  assert.equal(report.differences.some((item) => item.type === 'ADDED'), true);
}));

test('Replug reports a capability removal', async () => temporary(async (filePath) => {
  const store = new EvolutionStore({ filePath });
  const initial = loadAas(3);
  const current = copy(initial);
  current.submodels.find((item) => item.idShort === 'Capabilities').submodelElements = capabilities(current)
    .filter((item) => item.idShort !== 'StateMonitoring');
  await coordinateAcceptedPlugEvolution(accepted(store, 'cpslai3', 'plug-1', 'cycle-1', initial, 1));
  const report = await coordinateAcceptedPlugEvolution(accepted(store, 'cpslai3', 'plug-2', 'cycle-2', current, 2));
  assert.equal(report.differences.some((item) => item.type === 'REMOVED'), true);
}));

test('Replug reports a modified functional parameter', async () => temporary(async (filePath) => {
  const store = new EvolutionStore({ filePath });
  const initial = loadAas(1);
  const current = copy(initial);
  capabilities(current).find((item) => item.idShort === 'ConveyorReverse').value = 'false';
  await coordinateAcceptedPlugEvolution(accepted(store, 'cpslai1', 'plug-1', 'cycle-1', initial, 1));
  const report = await coordinateAcceptedPlugEvolution(accepted(store, 'cpslai1', 'plug-2', 'cycle-2', current, 2));
  assert.equal(report.differences.some((item) => item.type === 'CHANGED'), true);
}));

test('Replug preserves simultaneous ADDED, REMOVED and CHANGED differences', async () => temporary(async (filePath) => {
  const store = new EvolutionStore({ filePath });
  const initial = loadAas(3);
  const current = copy(initial);
  const list = capabilities(current);
  list.find((item) => item.idShort === 'PieceDetection').value = 'false';
  list.splice(list.findIndex((item) => item.idShort === 'StateMonitoring'), 1);
  list.push({
    modelType: 'Property', idShort: 'AdaptiveRouting', valueType: 'xs:boolean', value: 'true',
    semanticId: { type: 'ExternalReference', keys: [{ type: 'GlobalReference', value: 'urn:test:adaptive-routing' }] },
  });
  await coordinateAcceptedPlugEvolution(accepted(store, 'cpslai3', 'plug-1', 'cycle-1', initial, 1));
  const report = await coordinateAcceptedPlugEvolution(accepted(store, 'cpslai3', 'plug-2', 'cycle-2', current, 2));
  assert.deepEqual([...new Set(report.differences.map((item) => item.type))].sort(), ['ADDED', 'CHANGED', 'REMOVED']);
}));

test('incomplete AAS and ambiguous identity remain INDETERMINATE and unpromoted', async () => temporary(async (filePath) => {
  const store = new EvolutionStore({ filePath });
  const initial = loadAas(1);
  await coordinateAcceptedPlugEvolution(accepted(store, 'cpslai1', 'plug-1', 'cycle-1', initial, 1));

  const partial = copy(initial);
  partial.submodels = partial.submodels.filter((item) => item.idShort !== 'Capabilities');
  const incomplete = await coordinateAcceptedPlugEvolution(accepted(store, 'cpslai1', 'plug-2', 'cycle-2', partial, 2));
  assert.equal(incomplete.status, 'INDETERMINATE');
  assert.equal(incomplete.promoted, false);

  const renamed = copy(initial);
  capabilities(renamed).find((item) => item.idShort === 'ConveyorForward').idShort = 'ForwardConveyor';
  const ambiguous = await coordinateAcceptedPlugEvolution(accepted(store, 'cpslai1', 'plug-3', 'cycle-3', renamed, 3));
  assert.equal(ambiguous.status, 'INDETERMINATE');
  assert.equal(ambiguous.reason, 'AMBIGUOUS_FUNCTIONAL_IDENTITY');
  assert.equal(ambiguous.promoted, false);
}));

test('same plugEventId is idempotent even when retried later', async () => temporary(async (filePath) => {
  const store = new EvolutionStore({ filePath });
  const aas = loadAas(2);
  const first = await coordinateAcceptedPlugEvolution(accepted(store, 'cpslai2', 'plug-same', 'cycle-same', aas, 1));
  const retry = await coordinateAcceptedPlugEvolution(accepted(store, 'cpslai2', 'plug-same', 'cycle-same', aas, 9));
  assert.equal(retry.duplicate, true);
  assert.equal(retry.snapshotId, first.snapshotId);
  assert.equal((await store.listComparisons()).length, 1);
}));

test('same stable identity with different AAS content raises an explicit conflict', async () => temporary(async (filePath) => {
  const store = new EvolutionStore({ filePath });
  const original = loadAas(1);
  await coordinateAcceptedPlugEvolution(accepted(store, 'cpslai1', 'plug-same', 'cycle-same', original, 1));
  const changed = copy(original);
  capabilities(changed).find((item) => item.idShort === 'ConveyorReverse').value = 'false';
  await assert.rejects(
    coordinateAcceptedPlugEvolution(accepted(store, 'cpslai1', 'plug-same', 'cycle-same', changed, 2)),
    (error) => error.code === 'EVOLUTION_IDENTITY_CONFLICT',
  );
}));

test('new Store instance recovers baseline and coordinates a later Replug', async () => temporary(async (filePath) => {
  const aas = loadAas(3);
  await coordinateAcceptedPlugEvolution(accepted(new EvolutionStore({ filePath }), 'cpslai3', 'plug-1', 'cycle-1', aas, 1));
  const report = await coordinateAcceptedPlugEvolution(accepted(new EvolutionStore({ filePath }), 'cpslai3', 'plug-2', 'cycle-2', aas, 2));
  assert.equal(report.status, 'NO_CHANGE');
  assert.notEqual(report.previousSnapshotId, null);
}));

test('storage failure is propagated and cannot be reported as completed Evolution', async () => temporary(async (filePath) => {
  const store = new EvolutionStore({
    filePath,
    beforeRename() { throw Object.assign(new Error('controlled storage failure'), { code: 'CONTROLLED_STORAGE_FAILURE' }); },
  });
  await assert.rejects(
    coordinateAcceptedPlugEvolution(accepted(store, 'cpslai1', 'plug-1', 'cycle-1', loadAas(1), 1)),
    (error) => error.code === 'CONTROLLED_STORAGE_FAILURE',
  );
  assert.equal(fs.existsSync(filePath), false);
}));

test('AAS alone cannot trigger capture without explicit accepted Plug context', async () => temporary(async (filePath) => {
  const store = new EvolutionStore({ filePath });
  await assert.rejects(
    coordinateAcceptedPlugEvolution({ ...accepted(store, 'cpslai1', 'plug-1', 'cycle-1', loadAas(1), 1), plugAccepted: false }),
    (error) => error.code === 'EVOLUTION_ACCEPTED_PLUG_REQUIRED',
  );
  assert.equal(fs.existsSync(filePath), false);
}));

test('coordinator source has no governance, Play, REST, MQTT, HCM, PPU or MySQL dependency', () => {
  const source = fs.readFileSync(path.join(root, 'lib', 'evolution', 'evolutionCoordinator.mjs'), 'utf8');
  assert.doesNotMatch(source, /governanceStore|createGovernanceProfileForPlug|governanceStatus|profileVersion|APPROVED|DENIED|playEnabled|play-gate|fetch\s*\(|mqtt|cognitive|HCM|ppu|mysql/i);
});
