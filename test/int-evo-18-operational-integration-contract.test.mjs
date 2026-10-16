import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AcceptedCycleAasComposition } from '../lib/evolution/acceptedCycleAasComposition.mjs';
import { createOfficialAasDocumentSource } from '../lib/evolution/officialAasCatalog.mjs';
import {
  buildAcceptedPlugAasEnvelope,
  buildAasCardQueryEnvelope,
  buildAasCardQueryRequest,
} from '../lib/evolution/operationalAasIntegrationContract.mjs';
import { createStack } from '../scripts/experiments/run-int-evo-8-dynamic-binding.mjs';

const roots = new Set();
function officialStack() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'int-evo-18-'));
  roots.add(root);
  const stack = createStack(root);
  stack.source = createOfficialAasDocumentSource({ rootDir: path.resolve('cps-defs'), archive: stack.archive });
  stack.composition = new AcceptedCycleAasComposition({
    adapters: stack.adapters,
    orchestrator: stack.orchestrator,
    aasSource: stack.source,
    evolutionStore: stack.evolutionStore,
  });
  return stack;
}
test.afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function legacyCompatibleResponse(result) {
  return {
    ok: true,
    cpsId: result.binding.cpsId,
    lifecyclePhase: 'plug',
    activeProfile: {
      profileId: result.binding.profileId,
      plugEventId: result.binding.plugEventId,
      plugCycleId: result.binding.plugCycleId,
      status: 'PENDING_APPROVAL',
    },
  };
}

test('initial accepted Plug adds the exact official AAS contract without replacing legacy response fields', async () => {
  const stack = officialStack();
  const accepted = await stack.composition.acceptPlug({
    cpsId: 'cpslai1', plugEventId: 'int-evo-18-initial',
    aasReferenceId: 'cpslai1-official-revised-aas',
  });
  const response = buildAcceptedPlugAasEnvelope({ operationalResponse: legacyCompatibleResponse(accepted), acceptedResult: accepted });
  assert.equal(response.ok, true);
  assert.equal(response.lifecyclePhase, 'plug');
  assert.deepEqual(response.aasIntegration.binding, {
    cpsId: accepted.binding.cpsId,
    plugEventId: accepted.binding.plugEventId,
    plugCycleId: accepted.binding.plugCycleId,
    profileId: accepted.binding.profileId,
    referenceId: accepted.binding.aasReferenceId,
    aasId: accepted.binding.aasId,
    assetId: accepted.binding.assetId,
    contentHash: accepted.binding.contentHash,
    sourceId: accepted.binding.sourceId,
    sourceType: accepted.binding.sourceType,
    version: '1', revision: '1',
  });
  assert.equal(response.aasIntegration.projection.evolutionStatus, 'BASELINE');
  assert.equal(accepted.plug.governanceStatus, 'PENDING_APPROVAL');
});

test('retry is idempotent and Replug creates a distinct PENDING_APPROVAL profile and cycle', async () => {
  const stack = officialStack();
  const request = { cpsId: 'cpslai1', plugEventId: 'int-evo-18-retry', aasReferenceId: 'cpslai1-official-revised-aas' };
  const first = await stack.composition.acceptPlug(request);
  const retry = await stack.composition.acceptPlug(request);
  assert.equal(retry.binding.plugCycleId, first.binding.plugCycleId);
  assert.equal(retry.binding.profileId, first.binding.profileId);
  assert.equal(retry.binding.contentHash, first.binding.contentHash);
  await stack.composition.unplug(first.binding);

  const replug = await stack.composition.acceptPlug({ ...request, plugEventId: 'int-evo-18-replug' });
  assert.notEqual(replug.binding.plugCycleId, first.binding.plugCycleId);
  assert.notEqual(replug.binding.profileId, first.binding.profileId);
  assert.equal(replug.plug.governanceStatus, 'PENDING_APPROVAL');
  assert.equal(replug.evolution.status, 'NO_CHANGE');
});

test('frozen association remains readable after Unplug and query uses exact cpsId plus plugCycleId', async () => {
  const stack = officialStack();
  const accepted = await stack.composition.acceptPlug({
    cpsId: 'cpslai1', plugEventId: 'int-evo-18-history', aasReferenceId: 'cpslai1-official-revised-aas',
  });
  const frozen = structuredClone(stack.repository.read().document.plugCycles[accepted.binding.plugCycleId].aasReference);
  await stack.composition.unplug(accepted.binding);
  const projection = await stack.composition.readCycle(accepted.binding);
  const request = buildAasCardQueryRequest({ cpsId: accepted.binding.cpsId, plugCycleId: accepted.binding.plugCycleId });
  const envelope = buildAasCardQueryEnvelope({ request, projection });
  assert.equal(envelope.status, 'CORRELATED');
  assert.equal(envelope.projection.cycle.state, 'CLOSED');
  assert.deepEqual(stack.repository.read().document.plugCycles[accepted.binding.plugCycleId].aasReference, frozen);
});

test('experimental AAS and frontend/profile/hash conflicts fail closed', async () => {
  const experimental = createStack(fs.mkdtempSync(path.join(os.tmpdir(), 'int-evo-18-experimental-')));
  roots.add(path.dirname(experimental.repository.filePath));
  const accepted = await experimental.composition.acceptPlug({ cpsId: 'cpslai1', plugEventId: 'int-evo-18-exp', aasReferenceId: 'avm-v1' });
  assert.throws(() => buildAcceptedPlugAasEnvelope({ operationalResponse: legacyCompatibleResponse(accepted), acceptedResult: accepted }), {
    code: 'EXPERIMENTAL_AAS_OPERATIONAL_BINDING_FORBIDDEN',
  });

  const stack = officialStack();
  const official = await stack.composition.acceptPlug({ cpsId: 'cpslai1', plugEventId: 'int-evo-18-conflict', aasReferenceId: 'cpslai1-official-revised-aas' });
  const wrongProfile = legacyCompatibleResponse(official);
  wrongProfile.activeProfile.profileId = 'untrusted-frontend-profile';
  assert.throws(() => buildAcceptedPlugAasEnvelope({ operationalResponse: wrongProfile, acceptedResult: official }), { code: 'OPERATIONAL_RESPONSE_PROFILE_CONFLICT' });
  const wrongHash = structuredClone(official);
  wrongHash.projection.aas.contentHash = 'f'.repeat(64);
  assert.throws(() => buildAcceptedPlugAasEnvelope({ operationalResponse: legacyCompatibleResponse(official), acceptedResult: wrongHash }), { code: 'ACCEPTED_PLUG_PROJECTION_CONFLICT' });
});

test('card query preserves unavailable and not-processed states without writes or inference', () => {
  const request = { cpsId: 'cpslai1', plugCycleId: 'exact-cycle' };
  const unavailable = buildAasCardQueryEnvelope({ request, projection: {
    correlationStatus: 'UNAVAILABLE', bindingStatus: 'UNAVAILABLE', evolutionStatus: 'EVOLUTION_NOT_PROCESSED',
  } });
  assert.equal(unavailable.status, 'UNAVAILABLE');
  assert.equal(unavailable.evolutionStatus, 'EVOLUTION_NOT_PROCESSED');
  assert.throws(() => buildAasCardQueryRequest({ cpsId: 'cpslai1' }), { code: 'AAS_CARD_QUERY_IDENTITY_REQUIRED' });
  assert.throws(() => buildAasCardQueryEnvelope({ request, projection: {
    correlationStatus: 'CORRELATED', bindingStatus: 'BOUND', evolutionStatus: 'BASELINE',
    identity: { cpsId: 'cpslai1', plugCycleId: 'another-cycle' },
  } }), { code: 'AAS_CARD_QUERY_CYCLE_CONFLICT' });
});

test('contract module is presentation/transport-only and leaves operational writers untouched', () => {
  const source = fs.readFileSync('lib/evolution/operationalAasIntegrationContract.mjs', 'utf8');
  assert.doesNotMatch(source, /governanceStore|GovernanceRepository|EvolutionStore|plugStore|CPSContext|fetch\s*\(|mqtt|opcua|mysql/i);
  assert.doesNotMatch(source, /OperatingMode|approve|playGate|functionalComparator/i);
});
