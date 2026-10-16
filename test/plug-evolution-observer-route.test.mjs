import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPlugPostHandler } from '../lib/acsm/plugPostHandler.mjs';
import { createPlugEvolutionObserver, createConfiguredPlugEvolutionObserver, readEvolutionObserverEnabled } from '../lib/evolution/plugEvolutionObserver.mjs';
import { EvolutionStore } from '../lib/evolution/evolutionStore.mjs';
import { AasArchive } from '../lib/evolution/aasArchive.mjs';
import { createStaticAasFileSource } from '../lib/evolution/staticAasFileSource.mjs';
import { closeGovernancePlugCycle, createGovernanceProfileForPlug, approveGovernanceProfile, getActiveGovernanceProfile } from '../services/governance/governanceStore.js';
import { evaluateLifecyclePlayGate } from '../lib/governance/lifecycleGate.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const definitions = path.join(projectRoot, 'cps-defs');
const CPS_ID = 'cpslai1';
const AAS_ID = 'urn:ufsc:lai:ppu:cps-lai-01:aas';
const loadAas = (number = 1) => JSON.parse(fs.readFileSync(
  path.join(definitions, `cps-lai-0${number}-aas-acsm-compatible-revised.json`), 'utf8'));

async function isolated(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acsm-plug-evolution-route-'));
  const previous = { governance: process.env.GOVERNANCE_STORE_PATH, hcm: process.env.HCM_STORE_PATH };
  process.env.GOVERNANCE_STORE_PATH = path.join(root, 'governance', 'store.json');
  process.env.HCM_STORE_PATH = path.join(root, 'hcm', 'store.json');
  try { await run(root); }
  finally {
    if (previous.governance === undefined) delete process.env.GOVERNANCE_STORE_PATH;
    else process.env.GOVERNANCE_STORE_PATH = previous.governance;
    if (previous.hcm === undefined) delete process.env.HCM_STORE_PATH;
    else process.env.HCM_STORE_PATH = previous.hcm;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function routeHarness({ observer = null, assets = null, transitionOk = true, observerFactory = null } = {}) {
  const state = { assets: assets || [{ cps: { cpsId: CPS_ID, lifecyclePhase: 'registered' }, aas: { id: AAS_ID } }] };
  const calls = { transition: 0, update: 0, ppu: 0 };
  const handler = createPlugPostHandler({
    jsonResponse: (body, options = {}) => ({ body, status: options.status || 200, headers: options.headers || {} }),
    getPlugState: () => structuredClone(state),
    updatePlugSnapshot: (value) => { calls.update += 1; state.assets = value.assets || state.assets; return structuredClone(state); },
    transitionPlugAssetLifecycle: () => { calls.transition += 1; return transitionOk
      ? { ok: true, state: structuredClone(state) } : { ok: false, reason: 'CONTROLLED_TRANSITION_FAILURE' }; },
    executeAcsmUnplug: () => ({ ok: true }),
    closeGovernancePlugCycle,
    createGovernanceProfileForPlug,
    enqueuePpuOutboxEvent: () => ({ stored: true }),
    buildPlugRequestedPpuEvent: (event) => ({ eventId: event.plugEventId, operation: 'PLUG' }),
    sanitizeOutboxError: (error) => ({ code: error.code || 'ERROR' }),
    getEvolutionObserver: observerFactory || (() => observer),
    isEvolutionRequested: () => Boolean(observer || observerFactory),
    getActiveGovernanceProfile,
    logger: { warn() {}, error() {} },
  });
  return { handler, state, calls };
}

function request(plugEventId, cpsId = CPS_ID, asset = { cps: { cpsId, lifecyclePhase: 'registered' }, aas: { id: AAS_ID } }) {
  return { json: async () => ({ lifecycleTransition: { cpsId, phase: 'plug', plugEventId }, asset }) };
}

async function makeObserver(root, aas = loadAas(1), { archive = null, store = null, cpsId = CPS_ID } = {}) {
  const aasRoot = path.join(root, `aas-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(aasRoot, { recursive: true });
  fs.writeFileSync(path.join(aasRoot, 'current.json'), JSON.stringify(aas));
  const source = createStaticAasFileSource({
    rootDir: aasRoot,
    entries: { [cpsId]: { file: 'current.json', revision: 'isolated-fixture' } },
    sourceId: 'isolated-test-fixture',
  });
  return createPlugEvolutionObserver({
    source,
    archive: archive || new AasArchive({ rootDir: path.join(root, 'archive') }),
    store: store || new EvolutionStore({ filePath: path.join(root, 'evolution', 'store.json') }),
  });
}

async function readEvolutionStore(root) {
  return new EvolutionStore({ filePath: path.join(root, 'evolution', 'store.json') });
}

test('feature flag defaults off; disabled route preserves response and performs no Evolution preparation', async () => isolated(async (root) => {
  assert.equal(readEvolutionObserverEnabled({}), false);
  assert.equal(createConfiguredPlugEvolutionObserver({}), null);
  assert.throws(() => readEvolutionObserverEnabled({ ACSM_EVOLUTION_OBSERVER_ENABLED: 'yes' }),
    (error) => error.code === 'EVOLUTION_FLAG_INVALID');
  const { handler, calls } = routeHarness();
  const response = await handler(request('disabled-event'));
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(Object.hasOwn(response.body, 'evolution'), false);
  assert.equal(response.body.activeProfile.status, 'PENDING_APPROVAL');
  assert.equal(calls.transition, 1);
  assert.equal(fs.existsSync(path.join(root, 'evolution')), false);
  const gate = evaluateLifecyclePlayGate({ cpsId: CPS_ID, profile: response.body.activeProfile, plugState: { assets: [{ cps: { cpsId: CPS_ID, lifecyclePhase: 'plug' }, aas: { id: AAS_ID } }] } });
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, 'GOVERNANCE_APPROVAL_REQUIRED');
}));

test('explicit static configuration requires separate absolute archive and store paths', async () => isolated(async (root) => {
  const env = {
    ACSM_EVOLUTION_OBSERVER_ENABLED: 'true',
    ACSM_EVOLUTION_AAS_SOURCE_TYPE: 'STATIC_FILE',
    ACSM_EVOLUTION_ALLOW_STATIC_AAS: 'true',
    ACSM_EVOLUTION_SINGLE_PROCESS_CONFIRMED: 'true',
    ACSM_EVOLUTION_AAS_ROOT: definitions,
    ACSM_EVOLUTION_AAS_ARCHIVE_DIR: path.join(root, 'archive'),
    ACSM_EVOLUTION_STORE_PATH: path.join(root, 'evolution', 'store.json'),
  };
  assert.ok(createConfiguredPlugEvolutionObserver(env));
  assert.throws(() => createConfiguredPlugEvolutionObserver({ ...env, ACSM_EVOLUTION_AAS_ARCHIVE_DIR: undefined }),
    (error) => error.code === 'EVOLUTION_CONFIGURATION_INVALID');
  assert.throws(() => createConfiguredPlugEvolutionObserver({ ...env, ACSM_EVOLUTION_ALLOW_STATIC_AAS: 'false' }),
    (error) => error.code === 'EVOLUTION_STATIC_SOURCE_NOT_EXPLICIT');
  assert.throws(() => createConfiguredPlugEvolutionObserver({ ...env, ACSM_EVOLUTION_SINGLE_PROCESS_CONFIRMED: undefined }),
    (error) => error.code === 'EVOLUTION_CONCURRENCY_TOPOLOGY_UNCONFIRMED');
  assert.throws(() => createConfiguredPlugEvolutionObserver({ ...env, NODE_ENV: 'production' }),
    (error) => error.code === 'EVOLUTION_STATIC_SOURCE_PRODUCTION_DENIED');
  assert.equal(fs.existsSync(path.join(root, 'archive')), false);
}));

test('invalid explicit flag configuration is reported without being mistaken for a successful observation', async () => isolated(async () => {
  const { handler } = routeHarness({ observerFactory: () => {
    throw Object.assign(new Error('invalid feature flag'), { code: 'EVOLUTION_FLAG_INVALID' });
  } });
  const response = await handler(request('invalid-flag'));
  assert.equal(response.status, 200);
  assert.equal(response.body.activeProfile.status, 'PENDING_APPROVAL');
  assert.equal(response.body.evolution.status, 'FAILED');
  assert.equal(response.body.evolution.stage, 'CONFIGURATION');
  assert.equal(response.body.evolution.comparisonCompleted, false);
}));

test('first accepted Plug reports documentary BASELINE and leaves governance pending / Play blocked', async () => isolated(async (root) => {
  const observer = await makeObserver(root);
  const { handler } = routeHarness({ observer });
  const response = await handler(request('baseline-event'));
  assert.equal(response.status, 200);
  assert.equal(response.body.evolution.status, 'BASELINE');
  assert.equal(response.body.evolution.sourceType, 'STATIC_FILE');
  assert.equal(response.body.evolution.operationalSource, false);
  assert.equal(response.body.evolution.evidenceScope, 'STATIC_DOCUMENT_DECLARATION');
  assert.equal(response.body.evolution.physicalValidationInferred, false);
  assert.equal(response.body.activeProfile.status, 'PENDING_APPROVAL');
  assert.equal(response.body.activeProfile.profileVersion, 1);
  assert.equal(response.body.activeProfile.approvedAt, null);
  assert.equal(response.body.activeProfile.approvedBy, null);
  assert.equal(evaluateLifecyclePlayGate({ cpsId: CPS_ID, profile: response.body.activeProfile, plugState: { assets: [{ cps: { cpsId: CPS_ID, lifecyclePhase: 'plug' } }] } }).ok, false);
  const comparisons = await (await readEvolutionStore(root)).listComparisons({ cpsId: CPS_ID });
  assert.equal(comparisons.length, 1);
}));

test('Replug changes are observed as NO_CHANGE, ADDED, REMOVED and CHANGED without affecting approval', async () => isolated(async (root) => {
  const variants = [
    { name: 'unchanged', mutate: (aas) => aas, expected: 'NO_CHANGE' },
    { name: 'added', mutate: (aas) => { aas.submodels.find((s) => s.idShort === 'Capabilities').submodelElements.push({ modelType: 'Property', idShort: 'ObserverAdded', valueType: 'xs:boolean', value: 'true' }); return aas; }, expected: 'CHANGED', diff: 'ADDED' },
    { name: 'removed', mutate: (aas) => { const sm = aas.submodels.find((s) => s.idShort === 'Capabilities'); sm.submodelElements = sm.submodelElements.filter((e) => e.idShort !== 'ConveyorReverse'); return aas; }, expected: 'CHANGED', diff: 'REMOVED' },
    { name: 'changed', mutate: (aas) => { aas.submodels.find((s) => s.idShort === 'Capabilities').submodelElements.find((e) => e.idShort === 'ConveyorForward').value = 'false'; return aas; }, expected: 'CHANGED', diff: 'CHANGED' },
  ];
  let previousProfileVersion = 0;
  for (const [index, variant] of variants.entries()) {
    const currentAas = variant.mutate(structuredClone(loadAas(1)));
    const observer = await makeObserver(root, currentAas);
    const { handler } = routeHarness({ observer });
    if (index > 0) closeGovernancePlugCycle(CPS_ID, 'isolated-logical-replug');
    const response = await handler(request(`replug-${variant.name}`));
    assert.equal(response.body.evolution.status, index === 0 ? 'BASELINE' : variant.expected);
    if (variant.diff) assert.equal(response.body.evolution.differences.some((difference) => difference.type === variant.diff), true, `${variant.name}: ${JSON.stringify(response.body.evolution.differences)}`);
    assert.equal(response.body.activeProfile.status, 'PENDING_APPROVAL');
    assert.equal(response.body.activeProfile.approvedAt, null);
    assert.ok(response.body.activeProfile.profileVersion > previousProfileVersion, 'each explicit new event advances the governance profile version');
    previousProfileVersion = response.body.activeProfile.profileVersion;
  }
  assert.equal((await (await readEvolutionStore(root)).listComparisons({ cpsId: CPS_ID })).length, 4);
}));

test('incomplete AAS is INDETERMINATE and never prevents the accepted Plug', async () => isolated(async (root) => {
  const incomplete = loadAas(1);
  incomplete.submodels = incomplete.submodels.filter((submodel) => submodel.idShort !== 'Capabilities');
  const observer = await makeObserver(root, incomplete);
  const { handler } = routeHarness({ observer });
  const response = await handler(request('incomplete-event'));
  assert.equal(response.status, 200);
  assert.equal(response.body.evolution.status, 'INDETERMINATE');
  assert.equal(response.body.evolution.promoted, false);
  assert.equal(response.body.activeProfile.status, 'PENDING_APPROVAL');
}));

test('AAS identity mismatch fails observationally and records failure after Plug acceptance', async () => isolated(async (root) => {
  const observer = await makeObserver(root, loadAas(2));
  const { handler } = routeHarness({ observer });
  const response = await handler(request('identity-mismatch'));
  assert.equal(response.status, 200);
  assert.equal(response.body.evolution.status, 'FAILED');
  assert.equal(response.body.evolution.stage, 'RESOLUTION');
  assert.equal(response.body.activeProfile.status, 'PENDING_APPROVAL');
  const failures = await (await readEvolutionStore(root)).listObserverFailures({ cpsId: CPS_ID });
  assert.equal(failures.length, 1);
  assert.equal(failures[0].plugEventId, 'identity-mismatch');
}));

test('same-event retry is idempotent and concurrent retries do not create duplicate profiles or snapshots', async () => isolated(async (root) => {
  const observer = await makeObserver(root);
  const { handler } = routeHarness({ observer });
  const [first, retry] = await Promise.all([handler(request('same-event')), handler(request('same-event'))]);
  assert.equal(first.status, 200);
  assert.equal(retry.status, 200);
  assert.equal(first.body.activeProfile.profileId, retry.body.activeProfile.profileId);
  assert.equal(retry.body.evolution.duplicate, true);
  const governance = JSON.parse(fs.readFileSync(process.env.GOVERNANCE_STORE_PATH, 'utf8'));
  assert.equal(governance.profileVersions[CPS_ID].length, 1);
  assert.equal((await (await readEvolutionStore(root)).listComparisons({ cpsId: CPS_ID })).length, 1);
}));

test('same plugEventId with changed AAS is an explicit Evolution conflict, not a second profile', async () => isolated(async (root) => {
  const aasRoot = path.join(root, 'mutable-static-source');
  fs.mkdirSync(aasRoot);
  const aasFile = path.join(aasRoot, 'current.json');
  fs.writeFileSync(aasFile, JSON.stringify(loadAas(1)));
  const observer = createPlugEvolutionObserver({
    source: createStaticAasFileSource({ rootDir: aasRoot, entries: { [CPS_ID]: { file: 'current.json', revision: 'fixture' } } }),
    archive: new AasArchive({ rootDir: path.join(root, 'archive') }),
    store: new EvolutionStore({ filePath: path.join(root, 'evolution', 'store.json') }),
  });
  const { handler } = routeHarness({ observer });
  const first = await handler(request('stable-event'));
  const changed = loadAas(1);
  changed.submodels.find((item) => item.idShort === 'Capabilities').submodelElements
    .find((item) => item.idShort === 'ConveyorReverse').value = 'false';
  fs.writeFileSync(aasFile, JSON.stringify(changed));
  const retry = await handler(request('stable-event'));
  assert.equal(first.body.activeProfile.plugCycleId, retry.body.activeProfile.plugCycleId);
  assert.equal(retry.body.evolution.status, 'FAILED');
  assert.equal(retry.body.evolution.error.code, 'EVOLUTION_IDENTITY_CONFLICT');
  const governance = JSON.parse(fs.readFileSync(process.env.GOVERNANCE_STORE_PATH, 'utf8'));
  assert.equal(governance.profileVersions[CPS_ID].length, 1);
  const evolution = await new EvolutionStore({ filePath: path.join(root, 'evolution', 'store.json') }).inspect();
  assert.equal(Object.keys(evolution.snapshots).length, 1);
  assert.equal(Object.keys(evolution.comparisons).length, 1);
}));

test('enabled observer rejects a different Plug event while a cycle is active instead of opening a duplicate cycle', async () => isolated(async (root) => {
  const observer = await makeObserver(root);
  const { handler } = routeHarness({ observer });
  const first = await handler(request('active-cycle-event'));
  const second = await handler(request('unexpected-second-event'));
  assert.equal(first.status, 200);
  assert.equal(second.status, 409);
  assert.equal(second.body.reason, 'ACTIVE_PLUG_CYCLE_CONFLICT');
  const governance = JSON.parse(fs.readFileSync(process.env.GOVERNANCE_STORE_PATH, 'utf8'));
  assert.equal(governance.profileVersions[CPS_ID].length, 1);
  assert.equal((await (await readEvolutionStore(root)).listComparisons({ cpsId: CPS_ID })).length, 1);
}));

test('historical approval is not reused: new Plug cycle is pending and Play stays blocked', async () => isolated(async (root) => {
  const old = createGovernanceProfileForPlug(CPS_ID, { id: CPS_ID }, { plugEventId: 'old-event' }).profile;
  approveGovernanceProfile(CPS_ID, 'isolated-human');
  closeGovernancePlugCycle(CPS_ID, 'isolated-logical-unplug');
  const observer = await makeObserver(root);
  const { handler } = routeHarness({ observer });
  const response = await handler(request('new-event'));
  assert.equal(response.body.activeProfile.profileVersion, old.profileVersion + 1);
  assert.equal(response.body.activeProfile.status, 'PENDING_APPROVAL');
  assert.equal(response.body.activeProfile.approvedAt, null);
  assert.equal(evaluateLifecyclePlayGate({ cpsId: CPS_ID, profile: response.body.activeProfile, plugState: { assets: [{ cps: { cpsId: CPS_ID, lifecyclePhase: 'plug' } }] } }).ok, false);
}));

test('archive and Evolution Store failures do not roll back Plug or manufacture a comparison', async () => isolated(async (root) => {
  const archiveFailureObserver = await makeObserver(root, loadAas(1), {
    archive: { archive: async () => { throw Object.assign(new Error('archive unavailable'), { code: 'TEST_ARCHIVE_FAILURE' }); } },
  });
  const firstRoute = routeHarness({ observer: archiveFailureObserver });
  const archiveResponse = await firstRoute.handler(request('archive-failure'));
  assert.equal(archiveResponse.status, 200);
  assert.equal(archiveResponse.body.evolution.status, 'FAILED');
  assert.equal(archiveResponse.body.activeProfile.status, 'PENDING_APPROVAL');
  assert.equal((await (await readEvolutionStore(root)).listComparisons({ cpsId: CPS_ID })).length, 0);
  assert.equal((await (await readEvolutionStore(root)).listObserverFailures({ cpsId: CPS_ID })).length, 1);

  closeGovernancePlugCycle(CPS_ID, 'isolated-logical-unplug');
  const storeFailure = new EvolutionStore({
    filePath: path.join(root, 'failing-evolution', 'store.json'),
    beforeRename() { throw Object.assign(new Error('store unavailable'), { code: 'TEST_STORE_FAILURE' }); },
  });
  const storeFailureObserver = await makeObserver(root, loadAas(1), { store: storeFailure });
  const secondRoute = routeHarness({ observer: storeFailureObserver });
  const storeResponse = await secondRoute.handler(request('store-failure'));
  assert.equal(storeResponse.status, 200);
  assert.equal(storeResponse.body.evolution.status, 'FAILED');
  assert.equal(storeResponse.body.activeProfile.status, 'PENDING_APPROVAL');
  assert.equal(storeResponse.body.evolution.comparisonCompleted, false);
}));
