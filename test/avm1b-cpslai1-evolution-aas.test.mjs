import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { AasArchive } from '../lib/evolution/aasArchive.mjs';
import { compareFunctionalSnapshots } from '../lib/evolution/functionalComparator.mjs';
import { extractFunctionalDeclarations } from '../lib/evolution/functionalExtractor.mjs';
import { buildFunctionalSnapshot } from '../lib/evolution/functionalNormalizer.mjs';
import { EvolutionStore } from '../lib/evolution/evolutionStore.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const officialPath = path.join(root, 'cps-defs', 'cps-lai-01-aas-acsm-compatible-revised.json');
const experimentRoot = path.join(root, 'cps-defs', 'evolution-experiments', 'cpslai1');
const versionPath = (version) => path.join(experimentRoot, `aas-v${version}.json`);
const readBytes = (version) => fs.readFileSync(versionPath(version));
const load = (version) => JSON.parse(readBytes(version).toString('utf8'));
const submodel = (aas, idShort) => aas.submodels.find((item) => item.idShort === idShort);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const clone = (value) => structuredClone(value);

function withoutExperimentalCapabilities(aas) {
  const copy = clone(aas);
  const elements = submodel(copy, 'Capabilities').submodelElements;
  submodel(copy, 'Capabilities').submodelElements = elements.filter((item) =>
    !['PieceDetection', 'ExperimentalAdaptivePieceDetection'].includes(item.idShort));
  return copy;
}

function differencePaths(before, current, pathParts = []) {
  if (Object.is(before, current)) return [];
  if (!before || !current || typeof before !== 'object' || typeof current !== 'object') {
    return [pathParts.join('/')];
  }
  const keys = new Set([...Object.keys(before), ...Object.keys(current)]);
  return [...keys].flatMap((key) => differencePaths(before[key], current[key], [...pathParts, key]));
}

test('V1 is the official AAS plus only the experimental PieceDetection declaration', () => {
  const official = JSON.parse(fs.readFileSync(officialPath, 'utf8'));
  const v1 = load(1);
  assert.deepEqual(withoutExperimentalCapabilities(v1), official);
  assert.equal(v1.assetAdministrationShells[0].id, official.assetAdministrationShells[0].id);
  assert.equal(v1.assetAdministrationShells[0].assetInformation.globalAssetId,
    official.assetAdministrationShells[0].assetInformation.globalAssetId);
  assert.deepEqual(submodel(v1, 'OperationalData'), submodel(official, 'OperationalData'));
  assert.deepEqual(submodel(v1, 'FieldIOMapping'), submodel(official, 'FieldIOMapping'));
  assert.deepEqual(submodel(v1, 'Services'), submodel(official, 'Services'));
});

test('PieceDetection has stable experimental semantic identity and functional-support attributes', () => {
  const versions = [1, 2, 3].map(load);
  const declarations = versions.map((aas) => buildFunctionalSnapshot(aas).declarations
    .find((item) => item.name === 'PieceDetection'));
  assert.equal(declarations.every(Boolean), true);
  assert.equal(new Set(declarations.map((item) => item.identity)).size, 1);
  assert.equal(declarations[0].identity,
    'semantic:GlobalReference:urn:ufsc:lai:experimental:capability:piece-detection:1');
  assert.deepEqual(Object.fromEntries(Object.entries(declarations[0].attributes)
    .map(([key, item]) => [key, item.value])), {
    PieceAtEntry: 'true', PieceAtMiddle: 'true', PieceAtExit: 'true',
  });
  assert.equal(declarations[1].attributes.PieceAtMiddle.value, 'false');
  assert.equal(declarations[2].attributes.PieceAtMiddle.value, 'false');
  assert.equal(versions.every((aas) => buildFunctionalSnapshot(aas).completeness === 'COMPLETE_WITH_WARNINGS'), true);
});

test('V1 to V2 is exactly PieceAtMiddle true to false and compares as CHANGED/CHANGED', () => {
  const v1 = load(1);
  const v2 = load(2);
  assert.deepEqual(differencePaths(v1, v2), ['submodels/9/submodelElements/5/value/1/value']);
  const result = compareFunctionalSnapshots(buildFunctionalSnapshot(v1), buildFunctionalSnapshot(v2));
  assert.equal(result.status, 'CHANGED');
  assert.equal(result.differences.length, 1);
  assert.equal(result.differences[0].type, 'CHANGED');
  assert.equal(result.differences[0].before.name, 'PieceDetection');
  assert.equal(result.differences[0].before.attributes.PieceAtMiddle.value, 'true');
  assert.equal(result.differences[0].current.attributes.PieceAtMiddle.value, 'false');
});

test('V2 to V3 adds exactly one synthetic non-physical capability and compares as CHANGED/ADDED', () => {
  const v2 = load(2);
  const v3 = load(3);
  const changedPaths = differencePaths(v2, v3);
  assert.equal(changedPaths.every((item) => item.startsWith('submodels/9/submodelElements/6')), true);
  const result = compareFunctionalSnapshots(buildFunctionalSnapshot(v2), buildFunctionalSnapshot(v3));
  assert.equal(result.status, 'CHANGED');
  assert.equal(result.differences.length, 1);
  assert.equal(result.differences[0].type, 'ADDED');
  assert.equal(result.differences[0].current.name, 'ExperimentalAdaptivePieceDetection');
  assert.equal(result.differences[0].current.evidence.physicallyValidated, false);
  assert.match(JSON.stringify(result.differences[0].current.qualifiers), /DECLARED_ONLY_NO_PHYSICAL_EVIDENCE/);
});

test('an OperationalData-only change remains NO_CHANGE', () => {
  const before = load(1);
  const current = clone(before);
  submodel(current, 'OperationalData').submodelElements
    .find((item) => item.idShort === 'PieceAtMiddle').value = 'true';
  assert.equal(compareFunctionalSnapshots(
    buildFunctionalSnapshot(before), buildFunctionalSnapshot(current)).status, 'NO_CHANGE');
});

test('original capabilities and services remain present in all versions', () => {
  const official = JSON.parse(fs.readFileSync(officialPath, 'utf8'));
  const originalCapabilities = extractFunctionalDeclarations(official).declarations
    .filter((item) => item.kind === 'CAPABILITY').map((item) => item.name).sort();
  const originalServices = extractFunctionalDeclarations(official).declarations
    .filter((item) => item.kind === 'SERVICE').map((item) => item.name).sort();
  for (const version of [1, 2, 3]) {
    const declarations = extractFunctionalDeclarations(load(version)).declarations;
    const names = (kind) => declarations.filter((item) => item.kind === kind).map((item) => item.name);
    assert.equal(originalCapabilities.every((name) => names('CAPABILITY').includes(name)), true);
    assert.deepEqual(names('SERVICE').sort(), originalServices);
  }
});

test('temporary AAS Archive and EvolutionStore preserve hashes, history and retry idempotency', async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'avm1b-cpslai1-'));
  try {
    const archive = new AasArchive({ rootDir: path.join(temporaryRoot, 'aas-archive') });
    const storePath = path.join(temporaryRoot, 'evolution-store.json');
    const store = new EvolutionStore({ filePath: storePath });
    const captures = [];
    const governance = [];
    for (const version of [1, 2, 3]) {
      const aas = load(version);
      governance.push(clone(submodel(aas, 'Governance')));
      const bytes = readBytes(version);
      const archived = await archive.archive({ bytes, expectedHash: digest(bytes) });
      assert.deepEqual(await archive.getByHash(archived.contentHash), bytes);
      const input = {
        cpsId: 'cpslai1', plugEventId: `avm1b-v${version}`, plugCycleId: `avm1b-cycle-v${version}`,
        snapshot: buildFunctionalSnapshot(aas), capturedAt: new Date(`2026-10-14T1${version}:00:00.000Z`),
        provenance: { source: 'AVM-1B_OFFLINE_FIXTURE', operational: false, physicalValidationInferred: false },
        aasReference: {
          contentHash: archived.contentHash, archiveReference: archived.reference,
          sourceType: 'EXPERIMENTAL_STATIC_FILE', physicalStateInferred: false,
        },
      };
      captures.push({ input, result: await store.recordCapture(input) });
    }
    assert.deepEqual(captures.map((item) => item.result.comparison.status), ['BASELINE', 'CHANGED', 'CHANGED']);
    assert.deepEqual(captures[1].result.comparison.differences.map((item) => item.type), ['CHANGED']);
    assert.deepEqual(captures[2].result.comparison.differences.map((item) => item.type), ['ADDED']);
    const retry = await store.recordCapture(clone(captures[2].input));
    assert.equal(retry.duplicate, true);
    assert.equal(retry.snapshot.snapshotId, captures[2].result.snapshot.snapshotId);
    const restarted = new EvolutionStore({ filePath: storePath });
    const document = await restarted.inspect();
    const comparisons = await restarted.listComparisons({ cpsId: 'cpslai1' });
    assert.equal(Object.keys(document.snapshots).length, 3);
    assert.equal(comparisons.length, 3);
    assert.deepEqual(comparisons.map((item) => item.status), ['BASELINE', 'CHANGED', 'CHANGED']);
    assert.deepEqual(governance[0], governance[1]);
    assert.deepEqual(governance[1], governance[2]);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
