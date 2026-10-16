import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readExperimentalEditableAas } from '../../lib/evolution/experimentalEditableAasSource.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const officialPath = path.join(projectRoot, 'cps-defs', 'cps-lai-01-aas-acsm-compatible-revised.json');
const v1Path = path.join(projectRoot, 'cps-defs', 'evolution-experiments', 'cpslai1', 'aas-v1.json');
const fixtureDirectory = path.join(projectRoot, 'cps-defs', 'evolution-experiments', 'cpslai1', 'three-state-demo');
const artifactPath = path.join(projectRoot, 'docs', 'experiments', 'cpslai1-three-state-evolution.json');

const load = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));
const capabilities = (document) => document.submodels.find(({ idShort }) => idShort === 'Capabilities').submodelElements;
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const clone = (value) => structuredClone(value);

const official = load(officialPath);
const v1 = load(v1Path);
const pieceDetection = capabilities(v1).find(({ idShort }) => idShort === 'PieceDetection');
assert.ok(pieceDetection, 'V1 must contain PieceDetection.');
assert.equal(capabilities(official).length, 5, 'Official AAS must contain five capabilities.');

const s1 = clone(official);
const s2 = clone(official);
capabilities(s2).push(clone(pieceDetection));
const s3 = clone(s2);
s3.submodels.find(({ idShort }) => idShort === 'Capabilities').submodelElements = capabilities(s3)
  .filter(({ idShort }) => idShort !== 'PieceDetection');

assert.deepEqual(capabilities(s1), capabilities(official));
assert.deepEqual(capabilities(s2).slice(0, 5), capabilities(official));
assert.deepEqual(capabilities(s2)[5], pieceDetection);
assert.deepEqual(capabilities(s3), capabilities(official));

fs.mkdirSync(fixtureDirectory, { recursive: true });
const fixtureDefinitions = [
  { id: 's1', label: 'S1 — Original AAS', fileName: 's1-original-aas.json', document: s1, trailingNewline: true },
  { id: 's2', label: 'S2 — Add PieceDetection', fileName: 's2-add-piece-detection.json', document: s2, trailingNewline: true },
  { id: 's3', label: 'S3 — Remove PieceDetection', fileName: 's3-remove-piece-detection.json', document: s3, trailingNewline: false },
];

for (const fixture of fixtureDefinitions) {
  const serialized = JSON.stringify(fixture.document, null, 2) + (fixture.trailingNewline ? '\n' : '');
  fixture.filePath = path.join(fixtureDirectory, fixture.fileName);
  fs.writeFileSync(fixture.filePath, serialized);
}

let previousSnapshot = null;
const steps = [];
for (const fixture of fixtureDefinitions) {
  const result = await readExperimentalEditableAas({
    filePath: fixture.filePath,
    previousSnapshot,
  });
  steps.push({
    id: fixture.id,
    label: fixture.label,
    fixture: path.relative(projectRoot, fixture.filePath).replaceAll('\\', '/'),
    immutable: true,
    documentHash: result.projection.contentHash,
    functionalHash: result.snapshot.functionalHash,
    capabilityCount: result.projection.capabilities.length,
    projection: result.projection,
    evolution: result.evolution,
  });
  previousSnapshot = result.snapshot;
}

assert.deepEqual(steps.map(({ capabilityCount }) => capabilityCount), [5, 6, 5]);
assert.deepEqual(steps.map(({ evolution }) => evolution.status), ['BASELINE', 'CHANGED', 'CHANGED']);
assert.deepEqual(steps[1].evolution.differences.map(({ type }) => type), ['ADDED']);
assert.deepEqual(steps[2].evolution.differences.map(({ type }) => type), ['REMOVED']);
assert.equal(steps[1].evolution.differences[0].current.name, 'PieceDetection');
assert.equal(steps[2].evolution.differences[0].before.name, 'PieceDetection');
assert.equal(steps[0].functionalHash, steps[2].functionalHash);
assert.equal(new Set(steps.map(({ documentHash }) => documentHash)).size, 3);

const artifact = {
  schemaVersion: 'cpslai1-three-state-evolution/1.0.0',
  generatedBy: 'scripts/experiments/build-cpslai1-three-state-evolution.mjs',
  boundary: 'EXPERIMENTAL AAS EVOLUTION — NOT OPERATIONAL PPU STATE',
  sequence: ['s1', 's2', 's3'],
  aasId: official.assetAdministrationShells[0].id,
  assetId: official.assetAdministrationShells[0].assetInformation.globalAssetId,
  steps,
};

fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  artifactPath,
  fixtures: steps.map(({ id, fixture, documentHash, functionalHash, capabilityCount, evolution }) => ({
    id,
    fixture,
    documentHash,
    functionalHash,
    capabilityCount,
    evolutionStatus: evolution.status,
    differenceTypes: evolution.differences.map(({ type }) => type),
  })),
}, null, 2)}\n`);
