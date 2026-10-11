import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCpsLai2TechnicalHealth } from '../lib/acsm/cpsOperationalHealth.mjs';
import { mergeCpsTelemetry } from '../lib/acsm/cpsTelemetry.mjs';

const publishedAt = '2026-10-10T12:00:05.000Z';
const collectedAt = '2026-10-10T12:00:01.000Z';

const marker = (value, overrides = {}) => ({
  value,
  dataType: 'Boolean',
  statusCode: 'Good',
  quality: 'Good',
  valid: true,
  stale: false,
  collectedAt,
  semanticMappingStatus: 'PHYSICALLY_VALIDATED_MODE_MARKER',
  ...overrides,
});

const telemetry = (values = [true, false, false], overrides = {}) => ({
  cpsId: 'cpslai2',
  timestamp: publishedAt,
  publishedAt,
  snapshotComplete: true,
  availableTagCount: 6,
  expectedTagCount: 6,
  staleAfterMs: 6000,
  data: {
    sys_man: marker(values[0]),
    sys_sup: marker(values[1]),
    sys_man2: marker(values[2]),
  },
  ...overrides,
});

const calculate = (entry, communication = { dataFresh: true }) =>
  buildCpsLai2TechnicalHealth({
    cpsId: 'cpslai2',
    communication,
    telemetry: entry,
    timestamp: publishedAt,
  });

test('three current validated markers produce Health 100', () => {
  const result = calculate(telemetry());
  assert.equal(result.score, 100);
  assert.equal(result.healthState, 'HEALTHY');
  assert.equal(result.healthType, 'CPS_LAI_02_TECHNICAL_HEALTH');
  assert.deepEqual(result.evidence.failedChecks, []);
});

test('three valid false markers still produce Health 100', () => {
  assert.equal(calculate(telemetry([false, false, false])).score, 100);
});

for (const [mode, values] of [
  ['MANUAL', [true, false, false]],
  ['AUTOMATIC', [false, true, false]],
  ['STEP_BY_STEP', [false, false, true]],
]) {
  test(`${mode} marker values do not change Health 100`, () => {
    assert.equal(calculate(telemetry(values)).score, 100);
  });
}

for (const [name, mutate, expectedCheck] of [
  ['missing tag', (entry) => { delete entry.data.sys_sup; }, 'sys_sup:MISSING_TAG'],
  ['bad quality', (entry) => { entry.data.sys_sup.statusCode = 'BadNotConnected'; entry.data.sys_sup.quality = 'BadNotConnected'; }, 'sys_sup:BAD_OPCUA_QUALITY'],
  ['incompatible datatype', (entry) => { entry.data.sys_sup.dataType = 'Int32'; }, 'sys_sup:INCOMPATIBLE_DATATYPE'],
  ['invalid sample', (entry) => { entry.data.sys_sup.valid = false; }, 'sys_sup:INVALID_SAMPLE'],
  ['stale sample', (entry) => { entry.data.sys_sup.stale = true; }, 'sys_sup:STALE_SAMPLE'],
  ['old collectedAt', (entry) => { entry.data.sys_sup.collectedAt = '2026-10-10T11:59:00.000Z'; }, 'sys_sup:COLLECTED_AT_OUTSIDE_FRESHNESS_LIMIT'],
  ['invalid semantic mapping', (entry) => { entry.data.sys_sup.semanticMappingStatus = 'PRELIMINARY_UNVALIDATED'; }, 'sys_sup:INVALID_SEMANTIC_MAPPING'],
]) {
  test(`${name} produces Health 70 with an explicit failed check`, () => {
    const entry = telemetry();
    mutate(entry);
    const result = calculate(entry);
    assert.equal(result.score, 70);
    assert.equal(result.healthState, 'DEGRADED');
    assert.ok(result.evidence.failedChecks.includes(expectedCheck));
  });
}

test('complete absence of essential OPC UA evidence is Not Computed', () => {
  assert.equal(calculate(telemetry([], { data: {} })), null);
  assert.equal(calculate(telemetry([], { data: { sys_menu: marker(true) } })), null);
});

test('confirmed communication timeout produces Health 0', () => {
  const result = calculate(null, { dataFresh: false, dataAgeMs: 6000 });
  assert.equal(result.score, 0);
  assert.equal(result.healthState, 'COMMUNICATION_LOST');
  assert.deepEqual(result.evidence.failedChecks, ['COMMUNICATION_TIMEOUT']);
});

test('missing or invalid dataFresh is Not Computed', () => {
  assert.equal(calculate(telemetry(), {}), null);
  assert.equal(calculate(telemetry(), { dataFresh: 'true' }), null);
});

test('policy is isolated from cpslai1 and contains no mode, operational state, PPU or failure score', () => {
  assert.equal(buildCpsLai2TechnicalHealth({
    cpsId: 'cpslai1',
    communication: { dataFresh: true },
    telemetry: telemetry(),
    timestamp: publishedAt,
  }), null);
  const result = calculate(telemetry());
  for (const field of ['operationMode', 'operationalState', 'lifecyclePhase']) {
    assert.equal(Object.hasOwn(result, field), false);
    assert.equal(Object.hasOwn(result.evidence, field), false);
  }
  assert.notEqual(result.score, 30);
});

test('telemetry merge preserves completeness metadata without weakening sample ordering', () => {
  const first = mergeCpsTelemetry(null, telemetry());
  assert.equal(first.snapshotComplete, true);
  assert.equal(first.availableTagCount, 6);
  assert.equal(first.expectedTagCount, 6);
  assert.equal(first.publishedAt, publishedAt);

  const older = telemetry([false, true, false], {
    publishedAt: '2026-10-10T12:00:06.000Z',
    timestamp: '2026-10-10T12:00:06.000Z',
  });
  older.data.sys_man.collectedAt = '2026-10-10T11:59:00.000Z';
  const merged = mergeCpsTelemetry(first, older);
  assert.equal(merged.data.sys_man.value, true);
  assert.equal(merged.publishedAt, '2026-10-10T12:00:06.000Z');
});
