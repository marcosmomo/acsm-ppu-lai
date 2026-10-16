import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { AasArchive } from '../lib/evolution/aasArchive.mjs';
import {
  CPSLAI1_EXPERIMENTAL_AAS_CATALOG, listExperimentalAasVersions,
} from '../lib/evolution/experimentalAasCatalog.mjs';
import { createExperimentalAasResolver } from '../lib/evolution/experimentalAasResolver.mjs';
import { ExperimentalAasSelectionStore } from '../lib/evolution/experimentalAasSelectionStore.mjs';
import { EvolutionStore } from '../lib/evolution/evolutionStore.mjs';
import { buildFunctionalSnapshot } from '../lib/evolution/functionalNormalizer.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const aasRoot = path.join(projectRoot, 'cps-defs');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const resolver = () => createExperimentalAasResolver({ rootDir: aasRoot });

const temporary = async (run) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avm2-aas-selection-'));
  try { return await run(root); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
};

function catalogFor(relativePath, bytes, overrides = {}) {
  const base = CPSLAI1_EXPERIMENTAL_AAS_CATALOG.cps.cpslai1.versions.v1;
  return {
    cps: { cpslai1: { versions: { v1: {
      ...base, relativePath, sha256: sha256(bytes), ...overrides,
    } } } },
  };
}

const request = (entry, overrides = {}) => ({
  cpsId: 'cpslai1', plugEventId: 'simulated-plug-1', plugCycleId: 'simulated-cycle-1',
  profileId: 'simulated-profile-1', aasVersion: entry.version, aasSha256: entry.sha256,
  ...overrides,
});

test('catalog contains exactly cpslai1 v1/v2/v3 and hashes match current bytes', () => {
  assert.deepEqual(Object.keys(CPSLAI1_EXPERIMENTAL_AAS_CATALOG.cps), ['cpslai1']);
  assert.deepEqual(Object.keys(CPSLAI1_EXPERIMENTAL_AAS_CATALOG.cps.cpslai1.versions), ['v1', 'v2', 'v3']);
  for (const entry of listExperimentalAasVersions()) {
    const bytes = fs.readFileSync(path.join(aasRoot, entry.relativePath));
    assert.equal(sha256(bytes), entry.sha256);
    assert.equal(entry.sourceClassification, 'EXPERIMENTAL_STATIC_DOCUMENT');
    assert.equal('evolutionStatus' in entry, false);
  }
});

test('module use and dependency construction have no filesystem side effects', () => temporary(async (root) => {
  const absentRoot = path.join(root, 'not-created');
  createExperimentalAasResolver({ rootDir: absentRoot });
  new ExperimentalAasSelectionStore({ filePath: path.join(absentRoot, 'selection.json') });
  listExperimentalAasVersions();
  assert.equal(fs.existsSync(absentRoot), false);
}));

test('resolver accepts each allowlisted version without choosing a latest version', async () => {
  for (const version of ['v1', 'v2', 'v3']) {
    const resolved = await resolver().resolve({ cpsId: 'CPS-LAI-01', aasVersion: version });
    const entry = CPSLAI1_EXPERIMENTAL_AAS_CATALOG.cps.cpslai1.versions[version];
    assert.equal(resolved.provenance.aasVersion, version);
    assert.equal(resolved.integrity.contentHash, entry.sha256);
    assert.deepEqual(resolved.rawBytes, fs.readFileSync(path.join(aasRoot, entry.relativePath)));
    assert.equal(resolved.provenance.operational, false);
  }
  await assert.rejects(resolver().resolve({ cpsId: 'cpslai1' }),
    (error) => error.code === 'EXPERIMENTAL_AAS_VERSION_NOT_ALLOWED');
});

test('resolver rejects unknown CPS and version', async () => {
  await assert.rejects(resolver().resolve({ cpsId: 'cpslai2', aasVersion: 'v1' }),
    (error) => error.code === 'EXPERIMENTAL_AAS_CPS_NOT_ALLOWED');
  await assert.rejects(resolver().resolve({ cpsId: 'cpslai1', aasVersion: 'v4' }),
    (error) => error.code === 'EXPERIMENTAL_AAS_VERSION_NOT_ALLOWED');
});

test('resolver rejects modified bytes and divergent AAS identity', async () => temporary(async (root) => {
  const original = fs.readFileSync(path.join(aasRoot, 'evolution-experiments/cpslai1/aas-v1.json'));
  const modifiedDocument = JSON.parse(original);
  modifiedDocument.assetAdministrationShells[0].id = 'urn:divergent:aas';
  const modified = Buffer.from(`${JSON.stringify(modifiedDocument, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'modified.json'), modified);

  const wrongHashCatalog = catalogFor('modified.json', original);
  await assert.rejects(createExperimentalAasResolver({ rootDir: root, catalog: wrongHashCatalog })
    .resolve({ cpsId: 'cpslai1', aasVersion: 'v1' }),
  (error) => error.code === 'EXPERIMENTAL_AAS_HASH_MISMATCH');

  const identityCatalog = catalogFor('modified.json', modified);
  await assert.rejects(createExperimentalAasResolver({ rootDir: root, catalog: identityCatalog })
    .resolve({ cpsId: 'cpslai1', aasVersion: 'v1' }),
  (error) => error.code === 'EXPERIMENTAL_AAS_IDENTITY_MISMATCH');
}));

test('resolver rejects traversal and a directory symlink/junction escaping the root', async () => temporary(async (root) => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'avm2-outside-'));
  try {
    const bytes = fs.readFileSync(path.join(aasRoot, 'evolution-experiments/cpslai1/aas-v1.json'));
    fs.writeFileSync(path.join(outside, 'aas.json'), bytes);
    const traversal = catalogFor('../avm2-outside-does-not-matter/aas.json', bytes);
    await assert.rejects(createExperimentalAasResolver({ rootDir: root, catalog: traversal })
      .resolve({ cpsId: 'cpslai1', aasVersion: 'v1' }),
    (error) => error.code === 'EXPERIMENTAL_AAS_PATH_INVALID');

    const linked = path.join(root, 'linked');
    fs.symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
    const symlinkCatalog = catalogFor('linked/aas.json', bytes);
    await assert.rejects(createExperimentalAasResolver({ rootDir: root, catalog: symlinkCatalog })
      .resolve({ cpsId: 'cpslai1', aasVersion: 'v1' }),
    (error) => error.code === 'EXPERIMENTAL_AAS_SYMLINK_ESCAPE');
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
}));

test('selection remains pending without lifecycle identities, then freezes and retries as NO_OP', async () => temporary(async (root) => {
  const entry = CPSLAI1_EXPERIMENTAL_AAS_CATALOG.cps.cpslai1.versions.v1;
  const filePath = path.join(root, 'experimental-selection-store.json');
  const store = new ExperimentalAasSelectionStore({ filePath });
  const pendingInput = request(entry, { plugCycleId: null, profileId: null });
  const pending = await store.requestSelection(pendingInput);
  assert.equal(pending.outcome, 'PENDING');
  assert.equal(pending.selection.selectionId, null);
  assert.equal((await store.requestSelection(pendingInput)).outcome, 'NO_OP');

  const selectedInput = request(entry);
  const selected = await store.requestSelection(selectedInput);
  assert.equal(selected.outcome, 'SELECTED');
  assert.match(selected.selection.selectionId, /^avm_sel_[a-f0-9]{32}$/);
  assert.equal((await store.requestSelection(selectedInput)).outcome, 'NO_OP');
  assert.equal((await new ExperimentalAasSelectionStore({ filePath }).getSelection(selectedInput)).selectionId,
    selected.selection.selectionId);
  assert.equal((await store.inspect()).history.length, 2);
}));

test('same event rejects version, hash or lifecycle identity changes', async () => temporary(async (root) => {
  const entries = CPSLAI1_EXPERIMENTAL_AAS_CATALOG.cps.cpslai1.versions;
  const store = new ExperimentalAasSelectionStore({ filePath: path.join(root, 'store.json') });
  await store.requestSelection(request(entries.v1));
  for (const divergent of [
    request(entries.v2, { plugEventId: 'simulated-plug-1' }),
    request(entries.v1, { aasSha256: 'a'.repeat(64) }),
    request(entries.v1, { plugCycleId: 'different-cycle' }),
    request(entries.v1, { profileId: 'different-profile' }),
  ]) {
    await assert.rejects(store.requestSelection(divergent),
      (error) => error.code === 'EXPERIMENTAL_SELECTION_CONFLICT');
  }
  assert.equal((await store.inspect()).history.length, 1);
}));

test('selection is independent from Evolution classification', async () => temporary(async (root) => {
  const entries = CPSLAI1_EXPERIMENTAL_AAS_CATALOG.cps.cpslai1.versions;
  const selectionStore = new ExperimentalAasSelectionStore({ filePath: path.join(root, 'selection.json') });
  const selected = await selectionStore.requestSelection(request(entries.v1));
  assert.equal('status' in selected.selection, true);
  assert.equal('evolutionStatus' in selected.selection, false);
  assert.equal('differences' in selected.selection, false);
  assert.equal('comparison' in selected, false);
}));

test('offline archive and Evolution history produce BASELINE, CHANGED and ADDED', async () => temporary(async (root) => {
  const entries = CPSLAI1_EXPERIMENTAL_AAS_CATALOG.cps.cpslai1.versions;
  const source = resolver();
  const archive = new AasArchive({ rootDir: path.join(root, 'archive') });
  const evolution = new EvolutionStore({ filePath: path.join(root, 'evolution.json') });
  const results = [];
  for (const [index, version] of ['v1', 'v2', 'v3'].entries()) {
    const resolved = await source.resolve({ cpsId: 'cpslai1', aasVersion: version });
    const archived = await archive.archive({ bytes: resolved.rawBytes, expectedHash: resolved.integrity.contentHash });
    assert.deepEqual(await archive.getByHash(archived.contentHash), resolved.rawBytes);
    results.push(await evolution.recordCapture({
      cpsId: 'cpslai1', plugEventId: `avm2-${version}`, plugCycleId: `avm2-cycle-${version}`,
      snapshot: buildFunctionalSnapshot(resolved.document),
      capturedAt: new Date(`2026-10-14T1${index + 1}:00:00.000Z`),
      provenance: { source: 'AVM-2_OFFLINE', operational: false },
      aasReference: { contentHash: archived.contentHash, archiveReference: archived.reference,
        sourceType: 'EXPERIMENTAL_STATIC_DOCUMENT', physicalStateInferred: false },
    }));
  }
  assert.deepEqual(results.map((item) => item.comparison.status), ['BASELINE', 'CHANGED', 'CHANGED']);
  assert.deepEqual(results[1].comparison.differences.map((item) => item.type), ['CHANGED']);
  assert.deepEqual(results[2].comparison.differences.map((item) => item.type), ['ADDED']);
  assert.equal((await evolution.recordCapture({
    cpsId: 'cpslai1', plugEventId: 'avm2-v3', plugCycleId: 'avm2-cycle-v3',
    snapshot: buildFunctionalSnapshot((await source.resolve({ cpsId: 'cpslai1', aasVersion: 'v3' })).document),
    capturedAt: new Date('2026-10-14T19:00:00.000Z'),
    provenance: { source: 'AVM-2_OFFLINE', operational: false },
    aasReference: { contentHash: entries.v3.sha256, archiveReference: `sha256:${entries.v3.sha256}`,
      sourceType: 'EXPERIMENTAL_STATIC_DOCUMENT', physicalStateInferred: false },
  })).duplicate, true);
  assert.equal(Object.keys((await new EvolutionStore({ filePath: path.join(root, 'evolution.json') }).inspect()).snapshots).length, 3);
}));

test('AVM-2 operations do not alter official, experimental AAS or governance files', async () => temporary(async (root) => {
  const protectedPaths = [
    path.join(aasRoot, 'cps-lai-01-aas-acsm-compatible-revised.json'),
    ...listExperimentalAasVersions().map((entry) => path.join(aasRoot, entry.relativePath)),
    path.join(projectRoot, 'services', 'governance', 'governanceStore.js'),
  ];
  const before = protectedPaths.map((item) => sha256(fs.readFileSync(item)));
  const resolved = await resolver().resolve({ cpsId: 'cpslai1', aasVersion: 'v2' });
  const store = new ExperimentalAasSelectionStore({ filePath: path.join(root, 'selection.json') });
  await store.requestSelection(request(resolved.catalogEntry, { plugEventId: 'read-only-check' }));
  assert.deepEqual(protectedPaths.map((item) => sha256(fs.readFileSync(item))), before);
}));
