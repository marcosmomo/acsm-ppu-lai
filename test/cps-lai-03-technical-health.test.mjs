import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { buildCpsLai3TechnicalHealth } from '../lib/acsm/cpsOperationalHealth.mjs';

const now = '2026-10-10T18:00:05.000Z';
const tagInfo = {
  sys_man: 'ns=3;s="sys_man"',
  sys_sup: 'ns=3;s="sys_sup"',
  sys_man2: 'ns=3;s="sys_man2"',
};

const sample = (tag, value, overrides = {}) => ({
  field: tag,
  nodeId: tagInfo[tag],
  value,
  dataType: 'Boolean',
  dataTypeNodeId: 'ns=0;i=1',
  dataTypeEvidence: 'OPC_UA_ATTRIBUTE_DATATYPE',
  statusCode: 'Good',
  quality: 'Good',
  valid: true,
  stale: false,
  collectedAt: now,
  semanticMappingStatus: 'PHYSICALLY_VALIDATED_MODE_MARKER',
  ...overrides,
});

const telemetry = (values = [false, true, false], overrides = {}) => ({
  cpsId: 'cpslai3',
  schemaVersion: '1.2',
  timestamp: now,
  publishedAt: now,
  staleAfterMs: 6000,
  snapshotComplete: true,
  availableTagCount: 3,
  expectedTagCount: 3,
  data: Object.fromEntries(Object.keys(tagInfo).map((tag, index) => [tag, sample(tag, values[index])])),
  ...overrides,
});

const calculate = ({ values, communication = {}, evidence = {}, overrides = {} } = {}) =>
  buildCpsLai3TechnicalHealth({
    cpsId: 'cpslai3',
    communication: { dataMessageReceived: true, connected: true, dataFresh: true, ...communication },
    telemetry: telemetry(values, { data: Object.fromEntries(Object.keys(tagInfo).map((tag, index) => [
      tag, sample(tag, values?.[index] ?? [false, true, false][index], evidence[tag] || {}),
    ])), ...overrides }),
    timestamp: now,
  });

test('all valid current markers produce Health 100 regardless of Boolean combination', () => {
  for (const values of [
    [true, false, false], [false, true, false], [false, false, true], [false, false, false],
  ]) {
    const result = calculate({ values });
    assert.equal(result.score, 100);
    assert.equal(result.healthState, 'HEALTHY');
    assert.equal(result.healthType, 'CPS_LAI_03_TECHNICAL_HEALTH');
    assert.deepEqual(result.evidence.failedChecks, []);
  }
});

test('either statusCode Good or quality Good is sufficient quality evidence', () => {
  const data = Object.fromEntries(Object.keys(tagInfo).map((tag, index) => [tag, sample(tag, [false, true, false][index])]));
  data.sys_man.statusCode = 'BadSomething';
  assert.equal(calculate({ overrides: { data } }).score, 100);
});

for (const [name, mutation, expectedCheck] of [
  ['missing marker', (data) => { delete data.sys_sup; }, 'sys_sup:MISSING_TAG'],
  ['unexpected NodeId', (data) => { data.sys_sup.nodeId = 'ns=3;s="other"'; }, 'sys_sup:UNEXPECTED_NODEID'],
  ['incompatible datatype', (data) => { data.sys_sup.dataType = 'Int32'; }, 'sys_sup:INCOMPATIBLE_DATATYPE'],
  ['unproven datatype NodeId', (data) => { data.sys_sup.dataTypeNodeId = null; }, 'sys_sup:DATATYPE_NODEID_NOT_PROVEN'],
  ['unproven datatype source', (data) => { data.sys_sup.dataTypeEvidence = null; }, 'sys_sup:DATATYPE_EVIDENCE_NOT_PROVEN'],
  ['non-Boolean value', (data) => { data.sys_sup.value = 1; }, 'sys_sup:NON_BOOLEAN_VALUE'],
  ['bad quality', (data) => { data.sys_sup.statusCode = 'BadNotConnected'; data.sys_sup.quality = 'BadNotConnected'; }, 'sys_sup:BAD_OPCUA_QUALITY'],
  ['invalid sample', (data) => { data.sys_sup.valid = false; }, 'sys_sup:INVALID_SAMPLE'],
  ['stale sample', (data) => { data.sys_sup.stale = true; }, 'sys_sup:STALE_SAMPLE'],
  ['old collectedAt', (data) => { data.sys_sup.collectedAt = '2026-10-10T17:59:00.000Z'; }, 'sys_sup:COLLECTED_AT_OUTSIDE_FRESHNESS_LIMIT'],
  ['missing freshness limit', (data) => {}, 'sys_man:INVALID_FRESHNESS_LIMIT'],
  ['invalid semantics', (data) => { data.sys_sup.semanticMappingStatus = 'CANDIDATE_UNVALIDATED'; }, 'sys_sup:INVALID_SEMANTIC_MAPPING'],
]) {
  test(`${name} with current connection produces Health 70 and records the failed check`, () => {
    const data = Object.fromEntries(Object.keys(tagInfo).map((tag, index) => [tag, sample(tag, [false, true, false][index])]));
    mutation(data);
    const telemetryOverrides = name === 'missing freshness limit'
      ? { data, staleAfterMs: null }
      : { data };
    const result = calculate({ overrides: telemetryOverrides });
    assert.equal(result.score, 70);
    assert.equal(result.healthState, 'DEGRADED');
    assert.ok(result.evidence.failedChecks.includes(expectedCheck));
  });
}

test('dataFresh=false is not disconnection and cannot produce score zero', () => {
  const result = calculate({ communication: { dataFresh: false } });
  assert.equal(result.score, 70);
  assert.ok(result.evidence.failedChecks.includes('COMMUNICATION:DATA_NOT_FRESH'));
  const noMarkers = calculate({ communication: { dataFresh: false }, overrides: { data: {} } });
  assert.equal(noMarkers, null);
});

test('explicit current OPC UA disconnect produces Health 0 independently of marker count', () => {
  const result = calculate({
    communication: { connected: false, connectedConfirmed: true, dataFresh: false },
    overrides: { data: {} },
  });
  assert.equal(result.score, 0);
  assert.equal(result.healthState, 'COMMUNICATION_LOST');
  assert.deepEqual(result.evidence.failedChecks, ['OPCUA_CONNECTED_FALSE']);
  const defaultNotConnected = calculate({
    communication: { connected: false, connectedConfirmed: false },
    overrides: { data: {} },
  });
  assert.equal(defaultNotConnected, null, 'adapter default false without a current status event is not proof of disconnection');
});

test('ACSM receipt timeout produces Health 0 but unconfirmed communication stays Not Computed', () => {
  const timeout = buildCpsLai3TechnicalHealth({
    cpsId: 'cpslai3', communication: { connected: true, dataFresh: false, dataMessageReceived: true },
    telemetry: telemetry(), timestamp: now, timeoutConfirmed: true,
  });
  assert.equal(timeout.score, 0);
  assert.equal(timeout.evidence.evidenceStatus, 'ACSM_DATA_RECEIPT_TIMEOUT');
  assert.equal(buildCpsLai3TechnicalHealth({
    cpsId: 'cpslai3', communication: { dataFresh: false }, telemetry: telemetry(), timestamp: now,
  }), null);
});

test('no OPC UA marker objects, unknown connection, or invalid freshness limit is Not Computed', () => {
  assert.equal(calculate({ overrides: { data: {} } }), null);
  assert.equal(calculate({ communication: { connected: null } }), null);
  const noFreshnessLimit = calculate({ overrides: { staleAfterMs: null } });
  assert.equal(noFreshnessLimit.score, 70);
  assert.ok(noFreshnessLimit.evidence.failedChecks.includes('sys_man:INVALID_FRESHNESS_LIMIT'));
});

test('policy is CPS-LAI-03-only and does not derive mechanical, process, or mode health', () => {
  assert.equal(buildCpsLai3TechnicalHealth({
    cpsId: 'cpslai2', communication: { connected: true, dataMessageReceived: true },
    telemetry: telemetry(), timestamp: now,
  }), null);
  const result = calculate({ values: [false, false, false] });
  for (const field of ['operationMode', 'operationalState', 'lifecyclePhase', 'oee', 'mechanicalHealth']) {
    assert.equal(Object.hasOwn(result, field), false);
  }
});

test('CPSContext integrates per-data Health, times out receipt, and rejects generic cpslai3/health', () => {
  const source = readFileSync(new URL('../context/CPSContext.js', import.meta.url), 'utf8');
  assert.match(source, /buildCpsLai3TechnicalHealth/);
  assert.match(source, /applyCpsLai3TechnicalHealth\(false\)/);
  assert.match(source, /applyCpsLai3TechnicalHealth\(true\)/);
  assert.match(source, /telemetryCommunicationReceivedAtRef\.current\[cpsId\] = receivedAt/);
  assert.match(source, /cpsLai3StatusCommunicationRef/);
  assert.match(source, /Score only evidence carried by this MQTT snapshot[\s\S]{0,180}data: data\.data/);
  assert.match(source, /healthOwnerId === 'cpslai2' \|\| healthOwnerId === 'cpslai3'/);
  assert.match(source, /healthType: 'CPS_LAI_03_TECHNICAL_HEALTH'/);
});

test('Play Phase presents CPS-LAI-03 health score as a percent and Not Computed as Unavailable', () => {
  const source = readFileSync(new URL('../components/PlayFase.js', import.meta.url), 'utf8');
  assert.match(source, /CPS_LAI_03_TECHNICAL_HEALTH/);
  assert.match(source, /cpsLai3HealthNotComputed[\s\S]{0,150}Unavailable/);
  assert.match(source, /`\$\{healthScore\}%`/);
});
