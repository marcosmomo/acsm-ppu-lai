import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyPhysicalStatus,
  applyRememberedRuntimeMode,
  mergeNonStatusOperationalData,
} from '../lib/acsm/cpsOperationMode.mjs';

const physicalStatus = (extra = {}) => ({
  id: 'cpslai1',
  operationalState: 'UNKNOWN',
  operationalData: applyPhysicalStatus(
    {
      id: 'cpslai1',
      operationalData: {},
    },
    {
      operationMode: 'AUTOMATIC',
      operationModeEvidence: { sourceTag: 'sup_step_1' },
      supervisorState: { supStep1: true },
      evidenceStatus: 'PHYSICALLY_VALIDATED_MODE',
    }
  ),
  ...extra,
});

const assertPhysicalEvidence = (cps) => {
  assert.equal(cps.operationalData.operationMode, 'AUTOMATIC');
  assert.deepEqual(cps.operationalData.operationModeEvidence, { sourceTag: 'sup_step_1' });
  assert.deepEqual(cps.operationalData.supervisorState, { supStep1: true });
  assert.equal(cps.operationalData.evidenceStatus, 'PHYSICALLY_VALIDATED_MODE');
};

test('A: cpslai1 /data preserves the physical operation mode', () => {
  const cps = physicalStatus();
  const operationalData = mergeNonStatusOperationalData(cps, {
    currentTemperature: 31,
    operationMode: 'running',
  });

  assertPhysicalEvidence({ ...cps, operationalData });
  assert.equal(operationalData.currentTemperature, 31);
});

test('B: cpslai1 /oee preserves the physical operation mode', () => {
  const cps = physicalStatus();
  const operationalData = mergeNonStatusOperationalData(cps, {
    pieceCounter: 12,
    operationMode: null,
  });

  assertPhysicalEvidence({ ...cps, operationalData });
});

test('C: cpslai1 /learning preserves the physical operation mode', () => {
  const cps = physicalStatus();
  const operationalData = mergeNonStatusOperationalData(cps, {
    cycleTimeMs: 2400,
    operationMode: 'stopped',
  });

  assertPhysicalEvidence({ ...cps, operationalData });
});

test('D: remembered legacy running mode is ignored for cpslai1', () => {
  const cps = physicalStatus();
  const result = applyRememberedRuntimeMode(cps, 'running');

  assertPhysicalEvidence(result);
});

test('E: UNKNOWN operational state remains independent from AUTOMATIC mode', () => {
  const cps = physicalStatus();

  assert.equal(cps.operationalState, 'UNKNOWN');
  assert.equal(cps.operationalData.operationMode, 'AUTOMATIC');
});

for (const id of ['cps1', 'cps5', 'cps7']) {
  test(`F: ${id} keeps legacy runtime operation mode behavior`, () => {
    const cps = { id, operationalData: { operationMode: 'stopped', currentRPM: 10 } };
    const remembered = applyRememberedRuntimeMode(cps, 'running');
    const updated = mergeNonStatusOperationalData(remembered, {
      operationMode: 'maintenance',
      currentRPM: 20,
    });

    assert.equal(remembered.operationalData.operationMode, 'running');
    assert.equal(updated.operationMode, 'maintenance');
    assert.equal(updated.currentRPM, 20);
  });
}
