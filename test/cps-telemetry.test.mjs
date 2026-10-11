import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyCpsLai2PhysicalOperationMode,
  buildTelemetryRows,
  formatTelemetryValue,
  getCpsLai2PhysicalOperationMode,
  isCpsLai2TelemetryCommunicationFresh,
  isCpsLai2SnapshotEquivalent,
  mergeCpsTelemetry,
  mergeTelemetryState,
  shouldUseLocalTelemetryModal,
} from '../lib/acsm/cpsTelemetry.mjs';

const tags = ['sys_man', 'sys_man2', 'sys_sup', 'sys_menu', 'man_step_0', 'man_step_1'];
const sample = (tag, value, second, extra = {}) => ({
  field: tag,
  value,
  nodeId: `ns=3;s="${tag}"`,
  dataType: typeof value === 'number' ? 'Int32' : 'Boolean',
  statusCode: 'Good (0x00000000)',
  quality: 'Good (0x00000000)',
  collectedAt: `2026-10-09T22:00:${String(second).padStart(2, '0')}.000Z`,
  sourceTimestamp: `2026-10-09T22:00:${String(second).padStart(2, '0')}.000Z`,
  serverTimestamp: `2026-10-09T22:00:${String(second).padStart(2, '0')}.001Z`,
  semanticMappingStatus: 'PRELIMINARY_UNVALIDATED',
  ...extra,
});

test('six individual MQTT messages aggregate without losing tags', () => {
  let aggregate = null;
  tags.forEach((tag, index) => {
    aggregate = mergeCpsTelemetry(aggregate, {
      cpsId: 'cpslai2',
      data: { [tag]: sample(tag, index % 2 === 0, index + 1) },
    });
  });
  assert.deepEqual(Object.keys(aggregate.data).sort(), [...tags].sort());
});

test('updating one tag preserves every other tag', () => {
  const first = mergeCpsTelemetry(null, {
    cpsId: 'cpslai2',
    data: { sys_man: sample('sys_man', false, 1), sys_sup: sample('sys_sup', true, 1) },
  });
  const updated = mergeCpsTelemetry(first, {
    cpsId: 'cpslai2',
    data: { sys_man: sample('sys_man', true, 2) },
  });
  assert.equal(updated.data.sys_man.value, true);
  assert.equal(updated.data.sys_sup.value, true);
});

test('legacy messages without payload.data do not clear telemetry', () => {
  const first = mergeCpsTelemetry(null, { cpsId: 'cpslai2', data: { sys_man: sample('sys_man', true, 1) } });
  assert.equal(mergeCpsTelemetry(first, { cpsId: 'cpslai2', operationModeRaw: 8 }), first);
});

test('false and zero are preserved as available values', () => {
  const aggregate = mergeCpsTelemetry(null, {
    cpsId: 'cpslai2',
    data: { sys_man: sample('sys_man', false, 1), counter: sample('counter', 0, 1) },
  });
  assert.equal(aggregate.data.sys_man.value, false);
  assert.equal(aggregate.data.sys_man.available, true);
  assert.equal(aggregate.data.counter.value, 0);
  assert.equal(formatTelemetryValue(aggregate.data.sys_man), 'false');
  assert.equal(formatTelemetryValue(aggregate.data.counter), '0');
});

test('invalid OPC UA quality is retained as evidence but not presented as a valid reading', () => {
  const aggregate = mergeCpsTelemetry(null, {
    cpsId: 'cpslai2',
    data: { sys_man: sample('sys_man', true, 1, { statusCode: 'BadNotConnected', quality: 'BadNotConnected' }) },
  });
  assert.equal(aggregate.data.sys_man.value, true);
  assert.equal(aggregate.data.sys_man.valid, false);
  assert.equal(formatTelemetryValue(aggregate.data.sys_man), 'Unavailable');
});

test('older and timestamp-less samples cannot overwrite a timestamped value', () => {
  const current = mergeCpsTelemetry(null, { cpsId: 'cpslai2', data: { sys_man: sample('sys_man', true, 10) } });
  const older = mergeCpsTelemetry(current, { cpsId: 'cpslai2', data: { sys_man: sample('sys_man', false, 9) } });
  const unavailable = mergeCpsTelemetry(current, {
    cpsId: 'cpslai2',
    data: { sys_man: { ...sample('sys_man', false, 11), collectedAt: null, sourceTimestamp: null, serverTimestamp: null } },
  });
  assert.equal(older, current);
  assert.equal(unavailable, current);
});

test('telemetry is isolated by cpsId', () => {
  let state = mergeTelemetryState({}, 'cpslai2', { data: { sys_man: sample('sys_man', true, 1) } });
  state = mergeTelemetryState(state, 'cps1', { data: { counter: sample('counter', 0, 2) } });
  assert.deepEqual(Object.keys(state.cpslai2.data), ['sys_man']);
  assert.deepEqual(Object.keys(state.cps1.data), ['counter']);
});

test('local modal is exclusive to CPS-LAI-02 and exposes physical telemetry rows', () => {
  const aggregate = mergeCpsTelemetry(null, { cpsId: 'cpslai2', data: { sys_man: sample('sys_man', false, 1) } });
  const rows = buildTelemetryRows(aggregate);
  assert.equal(shouldUseLocalTelemetryModal({ id: 'cpslai2' }), true);
  assert.equal(shouldUseLocalTelemetryModal({ id: 'cpslai1' }), false);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].nodeId, 'ns=3;s="sys_man"');
  assert.equal(rows[0].semanticMappingStatus, 'PRELIMINARY_UNVALIDATED');
});

test('telemetry aggregation does not create OEE, Health or PPU state', () => {
  const aggregate = mergeCpsTelemetry(null, { cpsId: 'cpslai2', data: { sys_man: sample('sys_man', true, 1) } });
  assert.equal(Object.hasOwn(aggregate, 'oee'), false);
  assert.equal(Object.hasOwn(aggregate, 'health'), false);
  assert.equal(Object.hasOwn(aggregate, 'operationalState'), false);
  assert.equal(Object.hasOwn(aggregate, 'lifecyclePhase'), false);
});

test('MQTT aggregation preserves physical operationMode derivation without promoting it to PPU state', () => {
  const derived = {
    operationMode: 'MANUAL',
    source: 'PHYSICAL_OPCUA_MARKERS',
    semanticValidationStatus: 'PHYSICALLY_VALIDATED',
    reason: 'EXCLUSIVE_MANUAL_MARKER',
    derivedAt: '2026-10-09T12:00:00.000Z',
  };
  const aggregate = mergeCpsTelemetry(null, {
    cpsId: 'cpslai2',
    derived,
    data: { sys_man: sample('sys_man', true, 1) },
  });
  assert.deepEqual(aggregate.derived, derived);
  assert.equal(aggregate.operationMode, undefined);
  assert.equal(aggregate.operationalState, undefined);
  assert.equal(aggregate.lifecyclePhase, undefined);
  assert.equal(aggregate.health, undefined);
  assert.equal(aggregate.oee, undefined);
});

const physicalModeEntry = (operationMode, overrides = {}) => {
  const collectedAt = '2026-10-09T22:00:00.000Z';
  const modeSample = (tag, value) => sample(tag, value, 0, {
    semanticMappingStatus: 'PHYSICALLY_VALIDATED_MODE_MARKER',
  });
  const values = {
    MANUAL: [true, false, false],
    AUTOMATIC: [false, true, false],
    STEP_BY_STEP: [false, false, true],
    UNKNOWN: [false, false, false],
  }[operationMode] || [false, false, false];

  return {
    staleAfterMs: 6000,
    derived: {
      operationMode,
      source: 'PHYSICAL_OPCUA_MARKERS',
      semanticValidationStatus: 'PHYSICALLY_VALIDATED',
      derivedAt: collectedAt,
    },
    data: {
      sys_man: modeSample('sys_man', values[0]),
      sys_sup: modeSample('sys_sup', values[1]),
      sys_man2: modeSample('sys_man2', values[2]),
    },
    ...overrides,
  };
};

test('card selector accepts each current validated physical operation mode', () => {
  for (const mode of ['MANUAL', 'AUTOMATIC', 'STEP_BY_STEP', 'UNKNOWN']) {
    assert.equal(getCpsLai2PhysicalOperationMode(physicalModeEntry(mode), true), mode);
  }
});

test('card selector returns UNKNOWN without telemetry or with stale telemetry', () => {
  assert.equal(getCpsLai2PhysicalOperationMode(null, true), 'UNKNOWN');
  assert.equal(getCpsLai2PhysicalOperationMode(physicalModeEntry('MANUAL'), false), 'UNKNOWN');
});

test('card selector rejects invalid derivation and invalid marker evidence', () => {
  const badSource = physicalModeEntry('MANUAL');
  badSource.derived.source = 'UNVALIDATED_SOURCE';
  assert.equal(getCpsLai2PhysicalOperationMode(badSource, true), 'UNKNOWN');

  const invalidMarker = physicalModeEntry('AUTOMATIC');
  invalidMarker.data.sys_sup.statusCode = 'BadNotConnected';
  invalidMarker.data.sys_sup.quality = 'BadNotConnected';
  assert.equal(getCpsLai2PhysicalOperationMode(invalidMarker, true), 'UNKNOWN');
});

test('card selector follows a fresh mode update without creating PPU or indicator fields', () => {
  const manual = physicalModeEntry('MANUAL');
  const automatic = physicalModeEntry('AUTOMATIC');
  assert.equal(getCpsLai2PhysicalOperationMode(manual, true), 'MANUAL');
  assert.equal(getCpsLai2PhysicalOperationMode(automatic, true), 'AUTOMATIC');
  for (const key of ['operationalState', 'lifecyclePhase', 'health', 'oee']) {
    assert.equal(Object.hasOwn(automatic, key), false);
  }
});

test('successive physical modes update operationMode and preserve ACSM state and lifecycle', () => {
  let cps = {
    id: 'CPS-LAI-02',
    operationalState: 'running',
    lifecyclePhase: 'play',
    operationalData: {},
  };

  for (const mode of ['MANUAL', 'AUTOMATIC', 'STEP_BY_STEP', 'UNKNOWN']) {
    cps = applyCpsLai2PhysicalOperationMode(cps, physicalModeEntry(mode), true);
    assert.equal(cps.operationalData.operationMode, mode);
    assert.equal(cps.operationalState, 'running');
    assert.equal(cps.lifecyclePhase, 'play');
  }
});

test('physical mode stays independent after ACSM Start and Stop state changes', () => {
  const automatic = applyCpsLai2PhysicalOperationMode({
    id: 'cpslai2',
    operationalState: 'running',
    lifecyclePhase: 'play',
    operationalData: {},
  }, physicalModeEntry('AUTOMATIC'), true);
  const stopped = { ...automatic, operationalState: 'stopped' };
  const manual = applyCpsLai2PhysicalOperationMode(stopped, physicalModeEntry('MANUAL'), true);

  assert.equal(automatic.operationalState, 'running');
  assert.equal(automatic.operationalData.operationMode, 'AUTOMATIC');
  assert.equal(manual.operationalState, 'stopped');
  assert.equal(manual.operationalData.operationMode, 'MANUAL');
  assert.equal(manual.lifecyclePhase, 'play');
});

test('repeated physical mode application preserves object identity', () => {
  const first = applyCpsLai2PhysicalOperationMode({
    id: 'cpslai2',
    operationalState: 'running',
    lifecyclePhase: 'play',
    operationalData: {},
  }, physicalModeEntry('STEP_BY_STEP'), true);
  const repeated = applyCpsLai2PhysicalOperationMode(first, physicalModeEntry('STEP_BY_STEP'), true);
  assert.equal(repeated, first);
});

test('CPS-LAI-01 and CPS-LAI-03 are untouched by the CPS-LAI-02 mode updater', () => {
  for (const id of ['cpslai1', 'cpslai3']) {
    const cps = { id, operationalState: 'running', lifecyclePhase: 'play', operationalData: {} };
    assert.equal(
      applyCpsLai2PhysicalOperationMode(cps, physicalModeEntry('MANUAL'), true),
      cps
    );
  }
});

test('one-second snapshots and two-second OPC UA reads keep each physical mode stable for 30 seconds', () => {
  for (const mode of ['AUTOMATIC', 'MANUAL', 'STEP_BY_STEP']) {
    let now = Date.parse('2026-10-09T22:00:00.000Z');
    let lastMessageAt = now;
    let entry = physicalModeEntry(mode);
    for (let second = 1; second <= 30; second += 1) {
      now += 1000;
      lastMessageAt = now;
      if (second % 2 === 0) {
        entry = physicalModeEntry(mode);
        for (const sample of Object.values(entry.data)) {
          sample.collectedAt = new Date(now + 100).toISOString();
        }
        entry.derived.derivedAt = new Date(now).toISOString();
      }
      assert.equal(isCpsLai2TelemetryCommunicationFresh(lastMessageAt, now), true);
      assert.equal(getCpsLai2PhysicalOperationMode(entry, true), mode);
    }
  }
});

test('sample timestamps slightly after derivedAt do not cause a false UNKNOWN', () => {
  const entry = physicalModeEntry('AUTOMATIC');
  for (const sample of Object.values(entry.data)) {
    sample.collectedAt = '2026-10-09T22:00:00.250Z';
  }
  entry.derived.derivedAt = '2026-10-09T22:00:00.000Z';
  assert.equal(getCpsLai2PhysicalOperationMode(entry, true), 'AUTOMATIC');
});

test('repeated unchanged snapshots do not replace the aggregate or its derivation', () => {
  const first = mergeCpsTelemetry(null, {
    cpsId: 'cpslai2',
    staleAfterMs: 6000,
    derived: { operationMode: 'AUTOMATIC', source: 'PHYSICAL_OPCUA_MARKERS', semanticValidationStatus: 'PHYSICALLY_VALIDATED', reason: 'EXCLUSIVE_AUTOMATIC_MARKER', derivedAt: '2026-10-09T22:00:00.000Z' },
    data: { sys_sup: sample('sys_sup', true, 10, { valid: true, stale: false }) },
  });
  const next = mergeCpsTelemetry(first, {
    cpsId: 'cpslai2',
    staleAfterMs: 6000,
    derived: { ...first.derived, derivedAt: '2026-10-09T22:00:01.000Z' },
    data: { sys_sup: { ...first.data.sys_sup, ageMs: 1000 } },
  });
  assert.equal(next, first);
  assert.equal(isCpsLai2SnapshotEquivalent(first, {
    staleAfterMs: 6000,
    derived: { ...first.derived, derivedAt: '2026-10-09T22:00:01.000Z' },
    data: { sys_sup: { ...first.data.sys_sup, ageMs: 1000 } },
  }), true);
});

test('loss timeout makes mode UNKNOWN and a new message restores freshness', () => {
  const lastReceivedAt = 10000;
  assert.equal(isCpsLai2TelemetryCommunicationFresh(lastReceivedAt, 15999), true);
  assert.equal(isCpsLai2TelemetryCommunicationFresh(lastReceivedAt, 16000), false);
  const entry = physicalModeEntry('STEP_BY_STEP');
  assert.equal(getCpsLai2PhysicalOperationMode(entry, false), 'UNKNOWN');
  assert.equal(isCpsLai2TelemetryCommunicationFresh(16000, 16000), true);
  assert.equal(getCpsLai2PhysicalOperationMode(entry, true), 'STEP_BY_STEP');
});

test('invalid or conflicting adapter derivation remains UNKNOWN and modal samples stay intact', () => {
  const entry = physicalModeEntry('UNKNOWN');
  entry.derived.reason = 'NON_EXCLUSIVE_MODE_MARKERS';
  entry.data.sys_man.value = true;
  entry.data.sys_man.valid = true;
  entry.data.sys_sup.value = true;
  entry.data.sys_sup.valid = true;
  const rows = buildTelemetryRows(entry);
  assert.equal(getCpsLai2PhysicalOperationMode(entry, true), 'UNKNOWN');
  assert.equal(rows.find((row) => row.tag === 'sys_man').value, true);
  assert.equal(rows.find((row) => row.tag === 'sys_sup').value, true);
});
