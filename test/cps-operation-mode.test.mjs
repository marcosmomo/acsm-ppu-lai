import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyPhysicalStatus,
  applyRememberedRuntimeMode,
  hasIndependentPhysicalOperationMode,
  mergeNonStatusOperationalData,
  operationalDataForAcsmState,
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

const physicalModes = ['MANUAL', 'AUTOMATIC', 'STEP_BY_STEP', 'UNKNOWN'];

for (const id of ['cpslai1', 'CPS-LAI-02']) {
  for (const operationMode of physicalModes) {
    test(`${id} Start preserves physical operationMode=${operationMode}`, () => {
      const cps = {
        id,
        operationalState: 'stopped',
        lifecyclePhase: 'play',
        operationalData: { operationMode, marker: 'preserved' },
      };
      const updated = {
        ...cps,
        operationalState: 'running',
        lifecyclePhase: 'play',
        operationalData: operationalDataForAcsmState(cps, 'running'),
      };

      assert.equal(updated.operationalData.operationMode, operationMode);
      assert.equal(updated.operationalData.marker, 'preserved');
      assert.equal(updated.operationalState, 'running');
      assert.equal(updated.lifecyclePhase, 'play');
    });

    test(`${id} Stop preserves physical operationMode=${operationMode}`, () => {
      const cps = {
        id,
        operationalState: 'running',
        lifecyclePhase: 'play',
        operationalData: { operationMode },
      };
      const updated = {
        ...cps,
        operationalState: 'stopped',
        lifecyclePhase: 'play',
        operationalData: operationalDataForAcsmState(cps, 'stopped'),
      };

      assert.equal(updated.operationalData.operationMode, operationMode);
      assert.equal(updated.operationalState, 'stopped');
      assert.equal(updated.lifecyclePhase, 'play');
    });
  }
}

test('Maintenance preserves physical mode while retaining existing unplug lifecycle semantics', () => {
  for (const id of ['cpslai1', 'cpslai2', 'cpslai3']) {
    const cps = { id, lifecyclePhase: 'play', operationalData: { operationMode: 'UNKNOWN' } };
    const updated = {
      ...cps,
      operationalState: 'maintenance',
      lifecyclePhase: 'unplug',
      operationalData: operationalDataForAcsmState(cps, 'maintenance'),
    };
    assert.equal(updated.operationalData.operationMode, 'UNKNOWN');
    assert.equal(updated.operationalState, 'maintenance');
    assert.equal(updated.lifecyclePhase, 'unplug');
  }
});

test('CPS-LAI-03 has an independent physical mode that generic state changes cannot overwrite', () => {
  assert.equal(hasIndependentPhysicalOperationMode('CPS-LAI-01'), true);
  assert.equal(hasIndependentPhysicalOperationMode('cpslai2'), true);
  assert.equal(hasIndependentPhysicalOperationMode('cpslai3'), true);

  const cpsLai3 = {
    id: 'cpslai3',
    lifecyclePhase: 'play',
    operationalState: 'stopped',
    operationalData: {
      operationMode: 'running',
      operationModeRaw: 8,
      operationModeSemanticStatus: 'PENDING',
    },
  };
  assert.equal(operationalDataForAcsmState(cpsLai3, 'running').operationMode, 'UNKNOWN');
  assert.equal(operationalDataForAcsmState(cpsLai3, 'stopped').operationMode, 'UNKNOWN');
  assert.equal(applyRememberedRuntimeMode(cpsLai3, 'running').operationalData.operationMode, 'UNKNOWN');
  assert.equal(
    mergeNonStatusOperationalData(cpsLai3, { operationMode: 'AUTOMATIC', operationModeRaw: 8 })
      .operationMode,
    'UNKNOWN'
  );
  assert.equal(operationalDataForAcsmState(cpsLai3, 'running').operationModeRaw, 8);
  assert.equal(
    operationalDataForAcsmState(cpsLai3, 'running').operationModeSemanticStatus,
    'PENDING'
  );
  assert.equal(cpsLai3.operationalState, 'stopped');
  assert.equal(cpsLai3.lifecyclePhase, 'play');
});
