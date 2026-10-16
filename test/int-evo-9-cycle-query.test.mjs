import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createEvolutionCycleQuery } from '../lib/evolution/evolutionCycleQuery.mjs';
import { createStack } from '../scripts/experiments/run-int-evo-8-dynamic-binding.mjs';

const roots = new Set();
function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'int-evo-9-'));
  roots.add(root);
  return root;
}
test.afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots.clear();
});

test('queries the exact accepted cycle AAS and preserves the projection after Unplug without writes', async () => {
  const root = tempRoot();
  const stack = createStack(root);
  const accepted = await stack.composition.acceptPlug({ cpsId: 'cpslai1', plugEventId: 'query-event-1', aasReferenceId: 'avm-v1' });
  const query = stack.composition.readService;
  const governancePath = path.join(root, 'governance.json');
  const evolutionPath = path.join(root, 'evolution-store.json');
  const beforeGovernance = fs.readFileSync(governancePath);
  const beforeEvolution = fs.readFileSync(evolutionPath);
  const beforeArchive = fs.readdirSync(path.join(root, 'aas-archive')).sort();

  const current = await query.query({ cpsId: 'cpslai1', plugCycleId: accepted.binding.plugCycleId });
  assert.equal(current.status, 'CORRELATED');
  assert.equal(current.correlationStatus, 'CORRELATED');
  assert.equal(current.bindingStatus, 'BOUND');
  assert.equal(current.evolutionStatus, 'BASELINE');
  assert.equal(current.identity.plugEventId, accepted.binding.plugEventId);
  assert.equal(current.identity.profileId, accepted.binding.profileId);
  assert.equal(current.aas.aasId, accepted.binding.aasId);
  assert.equal(current.aas.contentHash, accepted.binding.contentHash);
  assert.equal(current.aas.capabilities.length, 6);
  assert.equal(current.card.aas.services.length > 0, true);
  assert.deepEqual(fs.readFileSync(governancePath), beforeGovernance);
  assert.deepEqual(fs.readFileSync(evolutionPath), beforeEvolution);

  await stack.composition.unplug(accepted.binding);
  const afterUnplugGovernance = fs.readFileSync(governancePath);
  const historical = await query.query({ cpsId: 'cpslai1', plugCycleId: accepted.binding.plugCycleId });
  assert.equal(historical.correlationStatus, 'CORRELATED');
  assert.equal(historical.bindingStatus, 'BOUND');
  assert.equal(historical.cycle.state, 'CLOSED');
  assert.equal(historical.aas.contentHash, accepted.binding.contentHash);
  assert.deepEqual(fs.readFileSync(governancePath), afterUnplugGovernance);
  assert.deepEqual(fs.readFileSync(evolutionPath), beforeEvolution); // Unplug leaves Evolution unchanged.
  assert.deepEqual(fs.readdirSync(path.join(root, 'aas-archive')).sort(), beforeArchive);
});

test('bound AAS remains queryable when Evolution has not run or its provider is unavailable', async () => {
  const stack = createStack(tempRoot());
  const accepted = await stack.composition.acceptPlug({ cpsId: 'cpslai1', plugEventId: 'query-no-evolution', aasReferenceId: 'avm-v2' });
  const queryWithoutEvolution = createEvolutionCycleQuery({
    cycleProvider: { readCycle: ({ cpsId, plugCycleId }) => stack.composition.adapters.facade.read().document.plugCycles[plugCycleId]
      ? (() => {
        const document = stack.composition.adapters.facade.read().document;
        const cycle = document.plugCycles[plugCycleId];
        const profile = document.profileVersions[cpsId].find((item) => item.profileId === cycle.governanceProfileId);
        return { cycle, profile };
      })() : null },
    aasSource: stack.source,
    evolutionProvider: { inspect: async () => ({ snapshots: {}, comparisons: {} }) },
    allowExperimentalSources: true,
  });
  const notProcessed = await queryWithoutEvolution.query({ cpsId: 'cpslai1', plugCycleId: accepted.binding.plugCycleId });
  assert.equal(notProcessed.correlationStatus, 'CORRELATED');
  assert.equal(notProcessed.bindingStatus, 'BOUND');
  assert.equal(notProcessed.evolutionStatus, 'EVOLUTION_NOT_PROCESSED');
  assert.equal(notProcessed.aas.capabilities.length, 6);
  assert.equal(notProcessed.aas.capabilities.find((capability) => capability.name === 'PieceDetection').attributes.PieceAtMiddle.value, 'false');

  const unavailable = createEvolutionCycleQuery({
    cycleProvider: { readCycle: ({ cpsId, plugCycleId }) => {
      const document = stack.composition.adapters.facade.read().document;
      const cycle = document.plugCycles[plugCycleId];
      const profile = document.profileVersions[cpsId].find((item) => item.profileId === cycle.governanceProfileId);
      return { cycle, profile };
    } },
    aasSource: stack.source,
    evolutionProvider: { inspect: async () => { throw Object.assign(new Error('offline'), { code: 'FIXTURE_EVOLUTION_OFFLINE' }); } },
    allowExperimentalSources: true,
  });
  const sourceDown = await unavailable.query({ cpsId: 'cpslai1', plugCycleId: accepted.binding.plugCycleId });
  assert.equal(sourceDown.correlationStatus, 'CORRELATED');
  assert.equal(sourceDown.bindingStatus, 'BOUND');
  assert.equal(sourceDown.evolutionStatus, 'UNAVAILABLE');
  assert.equal(sourceDown.aas.aasId, accepted.binding.aasId);

  const aasDown = createEvolutionCycleQuery({
    cycleProvider: { readCycle: ({ cpsId, plugCycleId }) => {
      const document = stack.composition.adapters.facade.read().document;
      const cycle = document.plugCycles[plugCycleId];
      const profile = document.profileVersions[cpsId].find((item) => item.profileId === cycle.governanceProfileId);
      return { cycle, profile };
    } },
    aasSource: { resolve: async () => { throw Object.assign(new Error('offline'), { code: 'FIXTURE_AAS_OFFLINE' }); } },
    evolutionProvider: stack.evolutionStore,
    allowExperimentalSources: true,
  });
  const documentUnavailable = await aasDown.query({ cpsId: 'cpslai1', plugCycleId: accepted.binding.plugCycleId });
  assert.equal(documentUnavailable.correlationStatus, 'CORRELATED');
  assert.equal(documentUnavailable.bindingStatus, 'UNAVAILABLE');
  assert.equal(documentUnavailable.identity.profileId, accepted.binding.profileId);
  assert.equal(documentUnavailable.aas, null);
});

test('identity, governance, frozen hash and Evolution conflicts remain explicit', async () => {
  const stack = createStack(tempRoot());
  const accepted = await stack.composition.acceptPlug({ cpsId: 'cpslai1', plugEventId: 'query-conflict', aasReferenceId: 'avm-v1' });
  const document = stack.composition.adapters.facade.read().document;
  const cycle = document.plugCycles[accepted.binding.plugCycleId];
  const profile = document.profileVersions.cpslai1.find((item) => item.profileId === cycle.governanceProfileId);
  const provider = { readCycle: async () => ({ cycle, profile: { ...profile, plugEventId: 'divergent-event' } }) };
  const conflict = createEvolutionCycleQuery({ cycleProvider: provider, aasSource: stack.source, evolutionProvider: stack.evolutionStore, allowExperimentalSources: true });
  assert.equal((await conflict.query({ cpsId: 'cpslai1', plugCycleId: cycle.plugCycleId })).status, 'CONFLICT');
  const wrongProfile = createEvolutionCycleQuery({
    cycleProvider: { readCycle: async () => ({ cycle, profile: { ...profile, profileId: 'unrelated-profile' } }) },
    aasSource: stack.source, evolutionProvider: stack.evolutionStore, allowExperimentalSources: true,
  });
  assert.equal((await wrongProfile.query({ cpsId: 'cpslai1', plugCycleId: cycle.plugCycleId })).correlationStatus, 'CONFLICT');

  const wrongHashCycle = structuredClone(cycle);
  wrongHashCycle.identity.contentHash = 'f'.repeat(64);
  wrongHashCycle.aasReference.contentHash = 'f'.repeat(64);
  const wrongHash = createEvolutionCycleQuery({ cycleProvider: { readCycle: async () => ({ cycle: wrongHashCycle, profile }) }, aasSource: stack.source, evolutionProvider: stack.evolutionStore, allowExperimentalSources: true });
  const hashResult = await wrongHash.query({ cpsId: 'cpslai1', plugCycleId: cycle.plugCycleId });
  assert.equal(hashResult.status, 'CONFLICT');
  assert.equal(hashResult.aas, null);

  const badEvolutionDocument = await stack.evolutionStore.inspect();
  const snapshot = Object.values(badEvolutionDocument.snapshots)[0];
  snapshot.aasReference.contentHash = '0'.repeat(64);
  const corruptEvolution = createEvolutionCycleQuery({
    cycleProvider: { readCycle: async () => ({ cycle, profile }) }, aasSource: stack.source,
    evolutionProvider: { inspect: async () => badEvolutionDocument }, allowExperimentalSources: true,
  });
  const evolutionResult = await corruptEvolution.query({ cpsId: 'cpslai1', plugCycleId: cycle.plugCycleId });
  assert.equal(evolutionResult.correlationStatus, 'CORRELATED');
  assert.equal(evolutionResult.bindingStatus, 'BOUND');
  assert.equal(evolutionResult.evolutionStatus, 'CONFLICT');
  assert.equal(evolutionResult.aas.aasId, accepted.binding.aasId);
});

test('unbound, unavailable, and experimental-not-operational results are distinguished', async () => {
  const stack = createStack(tempRoot());
  const accepted = await stack.composition.acceptPlug({ cpsId: 'cpslai1', plugEventId: 'query-unbound', aasReferenceId: 'avm-v3' });
  const document = stack.composition.adapters.facade.read().document;
  const cycle = structuredClone(document.plugCycles[accepted.binding.plugCycleId]);
  const profile = document.profileVersions.cpslai1.find((item) => item.profileId === cycle.governanceProfileId);
  delete cycle.aasReference;
  delete cycle.identity.aasReferenceId;
  const unbound = createEvolutionCycleQuery({ cycleProvider: { readCycle: async () => ({ cycle, profile }) }, aasSource: stack.source, evolutionProvider: stack.evolutionStore, allowExperimentalSources: true });
  assert.equal((await unbound.query({ cpsId: 'cpslai1', plugCycleId: cycle.plugCycleId })).bindingStatus, 'UNBOUND');

  const missingCycle = await stack.composition.readService.query({ cpsId: 'cpslai1', plugCycleId: 'missing-cycle' });
  assert.equal(missingCycle.status, 'UNAVAILABLE');
  const deniedExperimental = createEvolutionCycleQuery({
    cycleProvider: { readCycle: async () => ({ cycle: document.plugCycles[accepted.binding.plugCycleId], profile }) },
    aasSource: stack.source, evolutionProvider: stack.evolutionStore,
  });
  assert.equal((await deniedExperimental.query({ cpsId: 'cpslai1', plugCycleId: accepted.binding.plugCycleId })).bindingStatus, 'UNBOUND');
});
