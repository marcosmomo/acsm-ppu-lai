import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOPICS, validateMessage } from '../services/cps-lai-01-persistence/src/contracts.js';
import { normalizeMessage, deriveProductionEdge } from '../services/cps-lai-01-persistence/src/normalize.js';
import { loadConfig, validateRuntimeConfig } from '../services/cps-lai-01-persistence/src/config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../services/cps-lai-01-persistence/test/fixtures');
const fixture = async (name) => JSON.parse(await fs.readFile(path.join(root, name), 'utf8'));

test('accepts the four anonymized CPS-LAI-01 topic fixtures', async () => {
  const names = ['data.json', 'status.json', 'oee.json', 'health.json'];
  for (let i = 0; i < TOPICS.length; i += 1) assert.equal(validateMessage(TOPICS[i], await fixture(names[i])).ok, true);
});

test('runtime defaults to MQTT disabled and refuses the central or another CPS database', () => {
  const config = loadConfig({});
  assert.equal(config.enableMqtt, false);
  assert.throws(() => validateRuntimeConfig({ ...config, mqttUrl: 'mqtt://localhost', mysqlUrl: 'mysql://localhost/acsm_main_telemetry' }), /must target acsm_cpslai1/);
  assert.equal(validateRuntimeConfig({ ...config, mqttUrl: 'mqtt://localhost', mysqlUrl: 'mysql://localhost/acsm_cpslai1' }).cpsId, 'cpslai1');
});

test('rejects unsupported topic, malformed JSON, wrong CPS and invalid topic contract', async () => {
  assert.deepEqual(validateMessage('cpslai1/cmd', {}).errors, ['unsupported_topic']);
  assert.equal(validateMessage('cpslai1/data', '{broken').ok, false);
  const data = await fixture('data.json');
  assert.ok(validateMessage('cpslai1/data', { ...data, cpsId: 'cpslai2' }).errors.includes('cps_id_mismatch'));
  assert.ok(validateMessage('cpslai1/oee', { ...(await fixture('oee.json')), calculationState: undefined }).errors.includes('missing_calculation_state'));
});

test('preserves original JSON bytes and all three physical sample clocks', async () => {
  const raw = '{"schemaVersion":"1.0","cpsId":"cpslai1","source":"OPC_UA","timestamp":"2026-01-15T12:00:02.000Z","evidence":{"x":{"value":true,"sourceTimestamp":"2014-11-15T19:05:17.891Z","serverTimestamp":"2014-11-15T19:05:17.891Z","timestamp":"2026-01-15T12:00:01.900Z","evidenceStatus":"FIELD_VALIDATED"}}}';
  const normalized = normalizeMessage({ topic: 'cpslai1/data', payload: raw, receivedAt: '2026-01-15T12:00:03.000Z' });
  assert.equal(normalized.record.sourceTimestamp, null);
  assert.equal(normalized.record.rawPayloadText, raw);
  assert.equal(normalized.record.publishedAt.toISOString(), '2026-01-15T12:00:02.000Z');
  assert.equal(normalized.record.receivedAt.toISOString(), '2026-01-15T12:00:03.000Z');
  assert.equal(normalized.samples[0].sourceTimestamp.toISOString(), '2014-11-15T19:05:17.891Z');
  assert.equal(normalized.samples[0].serverTimestamp.toISOString(), '2014-11-15T19:05:17.891Z');
});

test('keeps OPERATIONAL_OEE_PROXY and experimental/quality provenance without recalculation', async () => {
  const payload = await fixture('oee.json');
  const normalized = normalizeMessage({ topic: 'cpslai1/oee', payload });
  assert.equal(normalized.projection.calculationState, 'OPERATIONAL_OEE_PROXY');
  assert.equal(normalized.projection.referenceCycleTimeMs, 2020);
  assert.equal(normalized.projection.qualityProductValidated, false);
  assert.equal(normalized.projection.qualityEvidenceStatus, 'NO_VALIDATED_REJECT_SIGNAL');
  assert.deepEqual(normalized.samples, []);
  assert.equal(normalized.projection.oee, payload.oee.current);
  assert.ok(validateMessage('cpslai1/oee', { ...payload, calculationState: 'SYNTHETIC' }).errors.includes('synthetic_oee_forbidden_for_cpslai1'));
});

test('keeps operational and technical Health classes distinct', async () => {
  const operational = normalizeMessage({ topic: 'cpslai1/health', payload: await fixture('health.json') });
  const technicalPayload = { ...(await fixture('health.json')), healthType: 'TECHNICAL_HEALTH', healthState: 'DEVICE_HEALTHY' };
  const technical = normalizeMessage({ topic: 'cpslai1/health', payload: technicalPayload });
  assert.equal(operational.projection.healthType, 'OPERATIONAL_HEALTH');
  assert.equal(technical.projection.healthType, 'TECHNICAL_HEALTH');
  assert.notEqual(operational.projection.healthType, technical.projection.healthType);
});

test('derives piece events only from ordered validated false-to-true PieceAtExit edges', async () => {
  const data = await fixture('data.json');
  const sample = normalizeMessage({ topic: 'cpslai1/data', payload: data, receivedAt: '2026-01-15T12:00:03.000Z' }).samples.find((item) => item.signalKey === 'PieceAtExit');
  const edgeSample = { ...sample, valueBool: true };
  const prior = new Date('2026-01-15T12:00:01.000Z');
  assert.equal(deriveProductionEdge({ previousValue: false, previousTimestamp: prior, sample: edgeSample }).eventType, 'piece_counted');
  assert.equal(deriveProductionEdge({ previousValue: true, previousTimestamp: prior, sample: edgeSample }), null);
  assert.equal(deriveProductionEdge({ previousValue: false, previousTimestamp: edgeSample.sourceTimestamp, sample: edgeSample }), null);
  assert.equal(deriveProductionEdge({ previousValue: false, previousTimestamp: prior, sample: { ...edgeSample, evidenceStatus: 'SEMANTIC_VALIDATION_PENDING' } }), null);
  const stale = normalizeMessage({ topic: 'cpslai1/data', payload: data, receivedAt: '2026-01-15T12:01:00.000Z' }).samples.find((item) => item.signalKey === 'PieceAtExit');
  assert.equal(deriveProductionEdge({ previousValue: false, previousTimestamp: prior, sample: { ...stale, valueBool: true } }), null);
});
