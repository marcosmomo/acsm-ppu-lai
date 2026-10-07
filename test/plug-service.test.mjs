import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { buildPlugState } from '../lib/acsm/plugService.mjs';

const plugAsset = () => ({
  cps: { cpsId: 'cpslai1', displayName: 'CPS-LAI-01', lifecyclePhase: 'plug' },
  identification: { manufacturer: 'FIELD_CONFIRMATION_REQUIRED', assetType: 'Conveyor' },
  aas: { id: 'urn:test', idShort: 'CPSLAI01_AAS' },
  capabilities: [{ group: 'AAS', items: ['Transportation'] }],
  interfaces: { baseTopic: 'cpslai1', brokerHost: 'localhost', brokerPort: '1883' },
  supportedPhases: ['Plug', 'Play', 'Stop', 'Maintenance', 'Return', 'Unplug'],
  governance: { profileId: 'GOV-CPSLAI1-001', profileVersion: 1, status: 'PENDING_APPROVAL' },
  lifecycleEvidence: { maintenanceCount: 2, events: [] },
});

test('empty Plug state reports NO_DATA without invented assets', () => {
  const result = buildPlugState({ acsmId: 'acsm1', assets: [] });
  assert.equal(result.phase, 'plug');
  assert.equal(result.evidenceStatus, 'NO_DATA');
  assert.equal(result.summary.registeredCPS, 0);
  assert.deepEqual(result.assets, []);
});

test('Plug facade normalizes stale unplugged lifecycle to plug when not linked', () => {
  const asset = plugAsset();
  asset.cps.lifecyclePhase = 'unplugged';
  const result = buildPlugState({ assets: [asset], operationallyLinked: 0 });
  assert.equal(result.assets[0].cps.lifecyclePhase, 'plug');
});

test('A discovered CPS remains registered/ready until an explicit Plug transition', () => {
  const asset = plugAsset();
  asset.cps.lifecyclePhase = 'registered';
  const result = buildPlugState({ assets: [asset], operationallyLinked: 0 });
  assert.equal(result.assets[0].cps.lifecyclePhase, 'registered');
});

test('Plug facade preserves AAS, governance and static capability projection', () => {
  const asset = plugAsset();
  const result = buildPlugState({ assets: [asset], operationallyLinked: 0 });
  assert.equal(result.evidenceStatus, 'AVAILABLE');
  assert.equal(result.summary.registeredCPS, 1);
  assert.deepEqual(result.assets[0].aas, asset.aas);
  assert.deepEqual(result.assets[0].governance, asset.governance);
  assert.deepEqual(result.assets[0].capabilities, asset.capabilities);
  assert.deepEqual(result.assets[0].lifecycleEvidence, asset.lifecycleEvidence);
});

test('Plug UI and context do not reference the removed capability-list helper', () => {
  const root = process.cwd();
  for (const relativePath of ['components/PlugFase.js', 'context/CPSContext.js']) {
    const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
    assert.doesNotMatch(source, /splitCapabilityList/);
  }
});
