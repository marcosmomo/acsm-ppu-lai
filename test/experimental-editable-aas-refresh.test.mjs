import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildExperimentalRefreshDiagnostics,
  readExperimentalEditableAas,
} from '../lib/evolution/experimentalEditableAasSource.mjs';
import { buildAasFunctionalCardPresentation } from '../lib/evolution/aasFunctionalCardPresentation.mjs';

const officialPath = path.resolve('cps-defs/cps-lai-01-aas-acsm-compatible-revised.json');
const avmPath = path.resolve('cps-defs/evolution-experiments/cpslai1/aas-v1.json');
const load = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const capabilities = (document) => document.submodels.find(({ idShort }) => idShort === 'Capabilities').submodelElements;

function withTempDocument(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'acsm-editable-aas-'));
  const filePath = path.join(directory, 'editable-aas.json');
  fs.copyFileSync(officialPath, filePath);
  return Promise.resolve(run(filePath)).finally(() => fs.rmSync(directory, { recursive: true, force: true }));
}

test('official five-capability fixture produces BASELINE and remains unbound', async () => {
  const result = await readExperimentalEditableAas({ filePath: officialPath });
  assert.equal(result.evolution.status, 'BASELINE');
  assert.equal(result.projection.capabilities.length, 5);
  assert.equal(result.projection.operational, false);
  assert.equal(result.projection.sourceType, 'EXPERIMENTAL_EDITABLE_AAS_DOCUMENT');
  assert.match(result.boundary, /NOT OPERATIONAL PPU STATE/);
});

test('adding PieceDetection produces six capabilities and ADDED; the next refresh is NO_CHANGE', async () => withTempDocument(async (filePath) => {
  const baseline = await readExperimentalEditableAas({ filePath });
  const document = load(filePath);
  const pieceDetection = structuredClone(capabilities(load(avmPath)).find(({ idShort }) => idShort === 'PieceDetection'));
  capabilities(document).push(pieceDetection);
  fs.writeFileSync(filePath, JSON.stringify(document, null, 2));
  const added = await readExperimentalEditableAas({ filePath, previousSnapshot: baseline.snapshot });
  assert.equal(added.projection.capabilities.length, 6);
  assert.equal(added.evolution.status, 'CHANGED');
  assert.deepEqual(added.evolution.differences.map(({ type }) => type), ['ADDED']);
  assert.equal(added.evolution.differences[0].current.name, 'PieceDetection');
  const unchanged = await readExperimentalEditableAas({ filePath, previousSnapshot: added.snapshot });
  assert.equal(unchanged.evolution.status, 'NO_CHANGE');
}));

test('functional attribute changes produce CHANGED and removing PieceDetection produces REMOVED', async () => withTempDocument(async (filePath) => {
  const baseline = await readExperimentalEditableAas({ filePath });
  const document = load(filePath);
  const pieceDetection = structuredClone(capabilities(load(avmPath)).find(({ idShort }) => idShort === 'PieceDetection'));
  capabilities(document).push(pieceDetection);
  fs.writeFileSync(filePath, JSON.stringify(document, null, 2));
  const added = await readExperimentalEditableAas({ filePath, previousSnapshot: baseline.snapshot });
  pieceDetection.value.find(({ idShort }) => idShort === 'PieceAtMiddle').value = 'false';
  fs.writeFileSync(filePath, JSON.stringify(document, null, 2));
  const changed = await readExperimentalEditableAas({ filePath, previousSnapshot: added.snapshot });
  assert.equal(changed.evolution.status, 'CHANGED');
  assert.equal(changed.evolution.differences[0].type, 'CHANGED');
  document.submodels.find(({ idShort }) => idShort === 'Capabilities').submodelElements = capabilities(document)
    .filter(({ idShort }) => idShort !== 'PieceDetection');
  fs.writeFileSync(filePath, JSON.stringify(document, null, 2));
  const removed = await readExperimentalEditableAas({ filePath, previousSnapshot: changed.snapshot });
  assert.equal(removed.projection.capabilities.length, 5);
  assert.deepEqual(removed.evolution.differences.map(({ type }) => type), ['REMOVED']);
}));

test('invalid JSON, divergent identity and incomplete declarations reject the refresh', async () => withTempDocument(async (filePath) => {
  const baseline = await readExperimentalEditableAas({ filePath });
  fs.writeFileSync(filePath, '{ invalid');
  await assert.rejects(() => readExperimentalEditableAas({ filePath, previousSnapshot: baseline.snapshot }), { code: 'AAS_DOCUMENT_INVALID' });
  const divergent = load(officialPath);
  divergent.assetAdministrationShells[0].id = 'urn:wrong:aas';
  fs.writeFileSync(filePath, JSON.stringify(divergent));
  await assert.rejects(() => readExperimentalEditableAas({ filePath, previousSnapshot: baseline.snapshot }), { code: 'AAS_IDENTITY_MISMATCH' });
  const incomplete = load(officialPath);
  capabilities(incomplete).push(structuredClone(capabilities(incomplete)[0]));
  fs.writeFileSync(filePath, JSON.stringify(incomplete));
  await assert.rejects(() => readExperimentalEditableAas({ filePath, previousSnapshot: baseline.snapshot }), { code: 'EXPERIMENTAL_AAS_DECLARATION_INCOMPLETE' });
}));

test('timestamp and OperatingMode-only edits do not create functional Evolution', async () => withTempDocument(async (filePath) => {
  const baseline = await readExperimentalEditableAas({ filePath });
  const document = load(filePath);
  document.assetAdministrationShells[0].description.push({ language: 'en', text: `Edited ${new Date(0).toISOString()}` });
  const operational = document.submodels.find(({ idShort }) => idShort === 'OperationalData');
  const mode = operational?.submodelElements?.find(({ idShort }) => idShort === 'OperatingMode');
  if (mode) mode.value = mode.value === 'AUTO' ? 'MANUAL' : 'AUTO';
  fs.writeFileSync(filePath, JSON.stringify(document, null, 2));
  const result = await readExperimentalEditableAas({ filePath, previousSnapshot: baseline.snapshot });
  assert.equal(result.evolution.status, 'NO_CHANGE');
  assert.notEqual(result.projection.contentHash, baseline.projection.contentHash);
}));

test('each valid refresh replaces the card projection for 5, 6, 5 and same-count attribute changes', async () => withTempDocument(async (filePath) => {
  const card = (result) => buildAasFunctionalCardPresentation({
    cpsId: 'cpslai1',
    document: result.projection,
  }).aas;
  let lastValid = await readExperimentalEditableAas({ filePath });
  assert.equal(card(lastValid).capabilities.length, 5);

  const document = load(filePath);
  const pieceDetection = structuredClone(capabilities(load(avmPath)).find(({ idShort }) => idShort === 'PieceDetection'));
  capabilities(document).push(pieceDetection);
  fs.writeFileSync(filePath, JSON.stringify(document, null, 2));
  lastValid = await readExperimentalEditableAas({ filePath, previousSnapshot: lastValid.snapshot });
  assert.equal(card(lastValid).capabilities.length, 6);
  assert.equal(lastValid.evolution.differences[0].type, 'ADDED');

  pieceDetection.value.find(({ idShort }) => idShort === 'PieceAtMiddle').value = 'false';
  fs.writeFileSync(filePath, JSON.stringify(document, null, 2));
  const changed = await readExperimentalEditableAas({ filePath, previousSnapshot: lastValid.snapshot });
  assert.equal(card(changed).capabilities.length, 6);
  assert.equal(changed.evolution.differences[0].type, 'CHANGED');
  assert.equal(
    card(changed).capabilities.find(({ name }) => name === 'PieceDetection').attributes.PieceAtMiddle.value,
    'false',
  );
  lastValid = changed;

  const retainedHash = card(lastValid).contentHash;
  fs.writeFileSync(filePath, '{ invalid');
  await assert.rejects(() => readExperimentalEditableAas({ filePath, previousSnapshot: lastValid.snapshot }), { code: 'AAS_DOCUMENT_INVALID' });
  assert.equal(card(lastValid).contentHash, retainedHash);

  document.submodels.find(({ idShort }) => idShort === 'Capabilities').submodelElements = capabilities(document)
    .filter(({ idShort }) => idShort !== 'PieceDetection');
  fs.writeFileSync(filePath, JSON.stringify(document, null, 2));
  lastValid = await readExperimentalEditableAas({ filePath, previousSnapshot: lastValid.snapshot });
  assert.equal(card(lastValid).capabilities.length, 5);
  assert.equal(lastValid.evolution.differences[0].type, 'REMOVED');

  const unchanged = await readExperimentalEditableAas({ filePath, previousSnapshot: lastValid.snapshot });
  assert.equal(unchanged.evolution.status, 'NO_CHANGE');
  assert.equal(card(unchanged).contentHash, card(lastValid).contentHash);
}));

test('refresh diagnostics report the exact BASELINE, NO_CHANGE, ADDED, REMOVED and reset inputs', async () => withTempDocument(async (filePath) => {
  const sessionId = 'diagnostic-session-12345678';
  const instanceId = 'experimental-instance-a';
  const entry = (result) => ({ snapshot: result.snapshot, documentHash: result.projection.contentHash });
  const diagnostics = (result, previousEntry = null, selectedInstance = instanceId) =>
    buildExperimentalRefreshDiagnostics({ id: sessionId, instanceId: selectedInstance, previousEntry, result });

  const baseline = await readExperimentalEditableAas({ filePath });
  const baselineDiagnostics = diagnostics(baseline);
  assert.equal(baselineDiagnostics.sessionId, 'diag…5678');
  assert.equal(baselineDiagnostics.sessionReset, true);
  assert.equal(baselineDiagnostics.previousDocumentHash, null);
  assert.equal(baselineDiagnostics.previousFunctionalHash, null);
  assert.equal(baselineDiagnostics.previousCapabilityCount, null);
  assert.equal(baselineDiagnostics.currentCapabilityCount, 5);
  assert.equal(baselineDiagnostics.evolutionStatus, 'BASELINE');

  const unchanged = await readExperimentalEditableAas({ filePath, previousSnapshot: baseline.snapshot });
  const unchangedDiagnostics = diagnostics(unchanged, entry(baseline));
  assert.equal(unchangedDiagnostics.sessionReset, false);
  assert.equal(unchangedDiagnostics.previousDocumentHash, baseline.projection.contentHash);
  assert.equal(unchangedDiagnostics.previousFunctionalHash, baseline.snapshot.functionalHash);
  assert.equal(unchangedDiagnostics.currentFunctionalHash, unchanged.snapshot.functionalHash);
  assert.equal(unchangedDiagnostics.previousCapabilityCount, 5);
  assert.equal(unchangedDiagnostics.currentCapabilityCount, 5);
  assert.equal(unchangedDiagnostics.evolutionStatus, 'NO_CHANGE');
  assert.deepEqual(unchangedDiagnostics.differenceTypes, []);

  const document = load(filePath);
  capabilities(document).push(structuredClone(capabilities(load(avmPath)).find(({ idShort }) => idShort === 'PieceDetection')));
  fs.writeFileSync(filePath, JSON.stringify(document, null, 2));
  const added = await readExperimentalEditableAas({ filePath, previousSnapshot: unchanged.snapshot });
  const addedDiagnostics = diagnostics(added, entry(unchanged));
  assert.equal(addedDiagnostics.previousCapabilityCount, 5);
  assert.equal(addedDiagnostics.currentCapabilityCount, 6);
  assert.equal(addedDiagnostics.evolutionStatus, 'CHANGED');
  assert.deepEqual(addedDiagnostics.differenceTypes, ['ADDED']);
  assert.notEqual(addedDiagnostics.previousFunctionalHash, addedDiagnostics.currentFunctionalHash);
  assert.equal(addedDiagnostics.currentDocumentHash, added.projection.contentHash);
  assert.equal(addedDiagnostics.currentProjectionHash, added.projection.contentHash);

  document.submodels.find(({ idShort }) => idShort === 'Capabilities').submodelElements = capabilities(document)
    .filter(({ idShort }) => idShort !== 'PieceDetection');
  fs.writeFileSync(filePath, JSON.stringify(document, null, 2));
  const removed = await readExperimentalEditableAas({ filePath, previousSnapshot: added.snapshot });
  const removedDiagnostics = diagnostics(removed, entry(added));
  assert.equal(removedDiagnostics.previousCapabilityCount, 6);
  assert.equal(removedDiagnostics.currentCapabilityCount, 5);
  assert.equal(removedDiagnostics.evolutionStatus, 'CHANGED');
  assert.deepEqual(removedDiagnostics.differenceTypes, ['REMOVED']);

  const resetOnAnotherInstance = diagnostics(removed, null, 'experimental-instance-b');
  assert.equal(resetOnAnotherInstance.serverInstanceId, 'experimental-instance-b');
  assert.equal(resetOnAnotherInstance.sessionReset, true);
  assert.equal(resetOnAnotherInstance.previousCapabilityCount, null);

  const retainedEntry = entry(removed);
  fs.writeFileSync(filePath, '{ invalid');
  await assert.rejects(() => readExperimentalEditableAas({ filePath, previousSnapshot: retainedEntry.snapshot }), { code: 'AAS_DOCUMENT_INVALID' });
  assert.equal(retainedEntry.documentHash, removed.projection.contentHash);
  assert.equal(retainedEntry.snapshot.functionalHash, removed.snapshot.functionalHash);
}));

test('GET and UI remain read-only and isolated from PPU management', () => {
  const route = fs.readFileSync('app/api/experiments/aas/cpslai1/route.js', 'utf8');
  const source = fs.readFileSync('lib/evolution/experimentalEditableAasSource.mjs', 'utf8');
  const demo = fs.readFileSync('components/ExperimentalAasCycleDemo.js', 'utf8');
  assert.match(route, /export async function GET/);
  assert.doesNotMatch(route, /export async function (POST|PUT|PATCH|DELETE)/);
  assert.doesNotMatch(`${route}\n${source}`, /CPSContext|GovernanceRepository|EvolutionStore|governanceStore|plugStore|mqtt|opcua|mysql/i);
  assert.doesNotMatch(source, /writeFile|appendFile|rename|unlink/);
  assert.match(demo, /Refresh AAS/);
  assert.match(demo, /editableRefresh\?\.projection\?\.contentHash/);
  assert.match(demo, /Refresh AAS Diagnostics/);
  assert.match(route, /buildExperimentalRefreshDiagnostics/);
  assert.match(demo, /Last valid snapshot preserved/);
  assert.match(demo, /EXPERIMENTAL AAS EVOLUTION — NOT OPERATIONAL PPU STATE/);
  assert.doesNotMatch(demo, /plugCPS|unplugCPS|approveGovernanceProfile|playPhaseCPS/);
});
