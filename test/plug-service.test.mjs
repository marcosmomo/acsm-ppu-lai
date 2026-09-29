import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPlugState } from '../lib/acsm/plugService.mjs';

test('empty Plug state reports NO_DATA without invented assets', () => {
  const result = buildPlugState({ acsmId: 'acsm1', assets: [] });
  assert.equal(result.phase, 'plug');
  assert.equal(result.evidenceStatus, 'NO_DATA');
  assert.equal(result.summary.registeredCPS, 0);
  assert.deepEqual(result.assets, []);
});

test('Plug facade preserves the existing UI projection', () => {
  const asset = {
    cps: { cpsId: 'cpslai1', displayName: 'CPS-LAI-01', lifecyclePhase: 'plug' },
    identification: { manufacturer: 'FIELD_CONFIRMATION_REQUIRED', assetType: 'Conveyor' },
    aas: { id: 'urn:test', idShort: 'CPSLAI01_AAS' },
    capabilities: [{ group: 'Process Capabilities', items: ['Transportation'] }],
    interfaces: { baseTopic: 'cpslai1', brokerHost: 'localhost', brokerPort: '1883' },
    supportedPhases: ['Plug', 'Play', 'Stop', 'Maintenance', 'Return', 'Unplug'],
    governance: { profileId: 'GOV-1', profileVersion: 1, status: 'APPROVED' },
    lifecycleEvidence: { maintenanceCount: 2, lastEvolutionTimestamp: 123, events: [] },
  };
  const result = buildPlugState({ assets: [asset], operationallyLinked: 1 });
  assert.equal(result.evidenceStatus, 'AVAILABLE');
  assert.equal(result.summary.operationallyLinked, 1);
  assert.deepEqual(result.assets[0], asset);
});
