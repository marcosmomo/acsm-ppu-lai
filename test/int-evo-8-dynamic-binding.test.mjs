import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { coordinateAcceptedPlugEvolution } from '../lib/evolution/evolutionCoordinator.mjs';
import { runIntEvo8DynamicBinding, createStack } from '../scripts/experiments/run-int-evo-8-dynamic-binding.mjs';
import { CPSLAI1_EXPERIMENTAL_AAS_CATALOG } from '../lib/evolution/experimentalAasCatalog.mjs';
import { createOfficialAasDocumentSource } from '../lib/evolution/officialAasCatalog.mjs';
import { AcceptedCycleAasComposition } from '../lib/evolution/acceptedCycleAasComposition.mjs';

const tempRoots = new Set();
function tempRoot(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `int-evo-8-${label}-`));
  tempRoots.add(root);
  return root;
}
test.afterEach(() => {
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
  tempRoots.clear();
});

test('offline sequence dynamically projects one verified AAS per accepted cycle', async () => {
  const { report } = await runIntEvo8DynamicBinding({ rootDir: tempRoot('sequence') });
  assert.deepEqual(report.checks.evolutionSequence, ['BASELINE', 'NO_CHANGE', 'CHANGED', 'CHANGED']);
  assert.equal(report.checks.distinctCycleIds, 4);
  assert.equal(report.checks.distinctProfileIds, 4);
  assert.equal(report.checks.oneAasPerCard, true);
  assert.equal(report.checks.allPlayGateTransitionsExplicit, true);
  assert.equal(report.checks.allRetriesIdempotent, true);
  assert.equal(report.checks.closedCycleHistoryReadable, true);
  assert.equal(report.checks.noEvolutionOnUnplug, true);
  assert.equal(report.checks.operatingModeIndependent, true);
  assert.equal(report.removalProbe.differences[0].type, 'REMOVED');
  assert.equal(report.cycles[2].card.capabilityCount, 6);
  assert.equal(report.cycles[3].card.capabilityCount, 7);
});

test('cycle authority freezes the verified reference with exact event/cycle/profile and retains it after Unplug', async () => {
  const stack = createStack(tempRoot('immutable-reference'));
  const accepted = await stack.composition.acceptPlug({ cpsId: 'cpslai1', plugEventId: 'immutable-reference-event', aasReferenceId: 'avm-v1' });
  const original = stack.repository.read().document.plugCycles[accepted.binding.plugCycleId];
  assert.deepEqual(original.aasReference, {
    schemaVersion: 'cycle-aas-reference/1.0',
    cpsId: accepted.binding.cpsId,
    plugEventId: accepted.binding.plugEventId,
    plugCycleId: accepted.binding.plugCycleId,
    profileId: accepted.binding.profileId,
    referenceId: 'avm-v1',
    aasId: accepted.binding.aasId,
    assetId: accepted.binding.assetId,
    contentHash: accepted.binding.contentHash,
    sourceId: accepted.binding.sourceId,
    sourceType: accepted.binding.sourceType,
    version: accepted.binding.aasVersion,
    revision: accepted.binding.aasRevision,
  });
  assert.equal(original.identityHash.length, 64);
  assert.equal(original.identity.functionalHash, accepted.binding.functionalHash);
  assert.equal(original.governanceProfileId, accepted.binding.profileId);
  assert.equal(original.state, 'ACTIVE');
  assert.equal(stack.repository.read().document.profileVersions.cpslai1.at(-1).status, 'PENDING_APPROVAL');

  await assert.rejects(stack.composition.acceptPlug({
    cpsId: 'cpslai1', plugEventId: accepted.binding.plugEventId, aasReferenceId: 'avm-v2',
  }), { code: 'GOVERNANCE_PLUG_IDENTITY_CONFLICT' });

  const beforeMode = structuredClone(original.aasReference);
  stack.repository.transact((draft) => {
    draft.plugCycles[accepted.binding.plugCycleId].observedOperatingMode = 'ABSTRACT_MODE_B';
  });
  assert.deepEqual(stack.repository.read().document.plugCycles[accepted.binding.plugCycleId].aasReference, beforeMode);
  const comparisonsBeforeUnplug = Object.keys((await stack.evolutionStore.inspect()).comparisons).length;
  await stack.composition.unplug(accepted.binding);
  assert.equal(Object.keys((await stack.evolutionStore.inspect()).comparisons).length, comparisonsBeforeUnplug);
  const historical = await stack.composition.readCycle(accepted.binding);
  assert.equal(historical.bindingStatus, 'BOUND');
  assert.deepEqual(historical.binding && stack.repository.read().document.plugCycles[accepted.binding.plugCycleId].aasReference, beforeMode);

  const replug = await stack.composition.acceptPlug({ cpsId: 'cpslai1', plugEventId: 'immutable-reference-replug', aasReferenceId: 'avm-v2' });
  assert.notEqual(replug.binding.plugCycleId, accepted.binding.plugCycleId);
  assert.equal(replug.plug.governanceStatus, 'PENDING_APPROVAL');
  assert.equal(replug.binding.aasVersion, 'v2');
  assert.equal(stack.repository.read().document.plugCycles[replug.binding.plugCycleId].aasReference.referenceId, 'avm-v2');
});

test('an AAS without administrative version remains versionless in its frozen historical reference', async () => {
  const root = tempRoot('missing-version');
  const sourceDocument = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'cps-defs', CPSLAI1_EXPERIMENTAL_AAS_CATALOG.cps.cpslai1.versions.v1.relativePath), 'utf8'));
  delete sourceDocument.assetAdministrationShells[0].administration;
  const bytes = Buffer.from(JSON.stringify(sourceDocument));
  const hash = createHash('sha256').update(bytes).digest('hex');
  const entry = {
    locator: 'versionless-aas-fixture.json', cpsId: 'cpslai1',
    aasId: sourceDocument.assetAdministrationShells[0].id,
    assetId: sourceDocument.assetAdministrationShells[0].assetInformation.globalAssetId,
    contentHash: hash, sourceId: 'int-evo-12-versionless-fixture',
    sourceType: 'EXPERIMENTAL_STATIC_DOCUMENT', operational: false,
  };
  const stack = createStack(root, {
    catalogOverride: { 'versionless-reference': entry },
    sourceOverride: { read: async () => bytes },
  });
  const accepted = await stack.composition.acceptPlug({ cpsId: 'cpslai1', plugEventId: 'versionless-event', aasReferenceId: 'versionless-reference' });
  const stored = stack.repository.read().document.plugCycles[accepted.binding.plugCycleId].aasReference;
  assert.equal(accepted.binding.aasVersion, null);
  assert.equal(stored.version, null);
  assert.equal(stored.revision, null);
  await stack.composition.unplug(accepted.binding);
  assert.equal((await stack.composition.readCycle(accepted.binding)).bindingStatus, 'BOUND');
});

test('official catalog AAS is verified and frozen with its declared administrative version and revision', async () => {
  const stack = createStack(tempRoot('official-catalog'));
  stack.source = createOfficialAasDocumentSource({
    rootDir: path.resolve('cps-defs'),
    archive: stack.archive,
  });
  stack.composition = new AcceptedCycleAasComposition({
    adapters: stack.adapters,
    orchestrator: stack.orchestrator,
    aasSource: stack.source,
    evolutionStore: stack.evolutionStore,
  });
  const accepted = await stack.composition.acceptPlug({
    cpsId: 'cpslai1', plugEventId: 'official-catalog-event',
    aasReferenceId: 'cpslai1-official-revised-aas',
  });
  const reference = stack.repository.read().document.plugCycles[accepted.binding.plugCycleId].aasReference;
  assert.equal(reference.sourceType, 'AUTHORIZED_OFFICIAL_AAS_DOCUMENT');
  assert.equal(reference.referenceId, 'cpslai1-official-revised-aas');
  assert.equal(reference.version, '1');
  assert.equal(reference.revision, '1');
  assert.equal(reference.contentHash, 'b5ca586f90662dbebf5d829d92c2e53d342301b1378fb4ed0223641091ade692');
});

test('invalid AAS, changed authorized bytes and archive failure fail before cycle acceptance', async () => {
  const malformedBytes = Buffer.from('{bad json');
  const v1 = CPSLAI1_EXPERIMENTAL_AAS_CATALOG.cps.cpslai1.versions.v1;
  const malformed = createStack(tempRoot('invalid'), {
    catalogOverride: { 'avm-v1': { locator: 'memory-malformed', cpsId: 'cpslai1', aasId: v1.aasId, assetId: v1.assetId,
      contentHash: createHash('sha256').update(malformedBytes).digest('hex'), version: 'v1', sourceId: 'invalid-fixture', sourceType: 'EXPERIMENTAL_STATIC_DOCUMENT' } },
    sourceOverride: { read: async () => malformedBytes },
  });
  await assert.rejects(malformed.composition.acceptPlug({ cpsId: 'cpslai1', plugEventId: 'bad-json', aasReferenceId: 'avm-v1' }), { code: 'AAS_DOCUMENT_INVALID' });
  assert.equal(Object.keys(malformed.repository.read().document.plugCycles || {}).length, 0);

  const original = fs.readFileSync(path.join(process.cwd(), 'cps-defs', CPSLAI1_EXPERIMENTAL_AAS_CATALOG.cps.cpslai1.versions.v1.relativePath));
  const hashMismatch = createStack(tempRoot('hash'), { sourceOverride: { read: async () => Buffer.concat([original, Buffer.from(' ')]) } });
  await assert.rejects(hashMismatch.composition.acceptPlug({ cpsId: 'cpslai1', plugEventId: 'bad-hash', aasReferenceId: 'avm-v1' }), { code: 'AAS_CONTENT_HASH_MISMATCH' });
  assert.equal(Object.keys(hashMismatch.repository.read().document.plugCycles || {}).length, 0);

  const archiveFailure = createStack(tempRoot('archive'), { archiveOverride: { archive: async () => { throw Object.assign(new Error('fixture archive failure'), { code: 'FIXTURE_ARCHIVE_FAILURE' }); } } });
  await assert.rejects(archiveFailure.composition.acceptPlug({ cpsId: 'cpslai1', plugEventId: 'archive-failure', aasReferenceId: 'avm-v1' }), { code: 'FIXTURE_ARCHIVE_FAILURE' });
  assert.equal(Object.keys(archiveFailure.repository.read().document.plugCycles || {}).length, 0);
});

test('profile/event divergence is conflicted and an accepted event cannot switch AAS', async () => {
  const stack = createStack(tempRoot('conflict'));
  const accepted = await stack.composition.acceptPlug({ cpsId: 'cpslai1', plugEventId: 'fixed-event', aasReferenceId: 'avm-v1' });
  const wrongProfile = await stack.composition.readCycle({ ...accepted.binding, profileId: 'different-profile' });
  const wrongEvent = await stack.composition.readCycle({ ...accepted.binding, plugEventId: 'different-event' });
  assert.equal(wrongProfile.readModel.identityCorrelationStatus, 'CONFLICT');
  assert.equal(wrongProfile.card.state, 'CONFLICT');
  assert.equal(wrongProfile.binding, null);
  assert.equal(wrongEvent.readModel.identityCorrelationStatus, 'CONFLICT');
  await assert.rejects(stack.composition.acceptPlug({ cpsId: 'cpslai1', plugEventId: 'fixed-event', aasReferenceId: 'avm-v2' }), { code: 'GOVERNANCE_PLUG_IDENTITY_CONFLICT' });
  await stack.composition.unplug(accepted.binding);
});

test('accepted cycle recovers after an Evolution failure without creating another profile', async () => {
  let first = true;
  const stack = createStack(tempRoot('recovery'), {
    coordinate: async (input) => {
      if (first) { first = false; throw Object.assign(new Error('simulated interruption'), { code: 'SIMULATED_INTERRUPTION' }); }
      return coordinateAcceptedPlugEvolution(input);
    },
  });
  const request = { cpsId: 'cpslai1', plugEventId: 'recover-event', aasReferenceId: 'avm-v1' };
  await assert.rejects(stack.composition.acceptPlug(request), { code: 'SIMULATED_INTERRUPTION' });
  const before = stack.repository.read().document;
  const cycleIds = Object.keys(before.plugCycles);
  const profileIds = before.profileVersions.cpslai1.map((profile) => profile.profileId);
  const recovered = await stack.composition.acceptPlug(request);
  const after = stack.repository.read().document;
  assert.deepEqual(Object.keys(after.plugCycles), cycleIds);
  assert.deepEqual(after.profileVersions.cpslai1.map((profile) => profile.profileId), profileIds);
  assert.equal(recovered.projection.card.state, 'BOUND');
  await stack.composition.unplug(recovered.binding);
});
