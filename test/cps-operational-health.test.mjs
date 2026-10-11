import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import {
  buildCpsOperationalHealth,
  buildCpsLai1OperationalHealth,
  publishCpsOperationalHealth,
  publishCpsLai1OperationalHealth,
} from '../lib/acsm/cpsOperationalHealth.mjs';

const require = createRequire(import.meta.url);
const MqttAdapter = require('../services/cps-lai-01/src/mqtt.js');

const timestamp = '2026-10-03T12:00:00.000Z';
const derive = (operationalState, dataFresh = true, extra = {}) =>
  buildCpsLai1OperationalHealth({
    communication: { dataFresh, dataAgeMs: 125, ...extra.communication },
    operationalState,
    timestamp,
    ...extra,
  });

for (const [operationalState, health, healthState] of [
  ['RUNNING', 100, 'HEALTHY'],
  ['STOPPED', 70, 'DEGRADED'],
  ['MAINTENANCE', 60, 'MAINTENANCE'],
  ['UNKNOWN', 40, 'UNKNOWN_OPERATIONAL_STATE'],
]) {
  test(`dataFresh=true plus ${operationalState} derives ${healthState}`, () => {
    const payload = derive(operationalState);
    assert.equal(payload.health, health);
    assert.equal(payload.current, health);
    assert.equal(payload.score, health);
    assert.equal(payload.healthState, healthState);
    assert.equal(payload.healthType, 'OPERATIONAL_HEALTH');
  });
}

test('dataFresh=false derives COMMUNICATION_LOST independently of operational state', () => {
  const payload = derive('RUNNING', false);
  assert.equal(payload.health, 0);
  assert.equal(payload.healthState, 'COMMUNICATION_LOST');
  assert.equal(payload.evidence.communicationFresh, false);
});

test('AlarmSignal and MagazineFeedSensor do not participate in operational health', () => {
  const baseline = derive('STOPPED');
  const withUnvalidatedSignals = derive('STOPPED', true, {
    AlarmSignal: true,
    MagazineFeedSensor: false,
    communication: { dataFresh: true, dataAgeMs: 125, AlarmSignal: true },
  });
  assert.deepEqual(withUnvalidatedSignals, baseline);
  assert.equal(Object.hasOwn(withUnvalidatedSignals.evidence, 'AlarmSignal'), false);
  assert.equal(Object.hasOwn(withUnvalidatedSignals, 'MagazineFeedSensor'), false);
});

test('missing explicit dataFresh does not derive health', () => {
  assert.equal(buildCpsLai1OperationalHealth({ communication: {}, operationalState: 'RUNNING' }), null);
});

test('missing or invalid communication evidence never fabricates legacy operational health', () => {
  for (const cpsId of ['cpslai1']) {
    assert.equal(buildCpsOperationalHealth({ cpsId, operationalState: 'RUNNING' }), null);
    assert.equal(buildCpsOperationalHealth({ cpsId, communication: {}, operationalState: 'RUNNING' }), null);
    assert.equal(buildCpsOperationalHealth({ cpsId, communication: { dataFresh: 'true' }, operationalState: 'RUNNING' }), null);
  }
});

for (const cpsId of ['cpslai1']) {
  for (const [operationalState, score, healthState] of [
    ['RUNNING', 100, 'HEALTHY'],
    ['STOPPED', 70, 'DEGRADED'],
    ['MAINTENANCE', 60, 'MAINTENANCE'],
    ['UNKNOWN', 40, 'UNKNOWN_OPERATIONAL_STATE'],
  ]) {
    test(`${cpsId} keeps its identity for ${operationalState}`, () => {
      const payload = buildCpsOperationalHealth({
        cpsId,
        communication: { dataFresh: true },
        operationalState,
        timestamp,
      });
      assert.equal(payload.cpsId, cpsId);
      assert.equal(payload.score, score);
      assert.equal(payload.healthState, healthState);
      assert.equal(payload.evidence.operationalState, operationalState);
      assert.equal(Object.hasOwn(payload, 'operationMode'), false);
      assert.equal(Object.hasOwn(payload, 'lifecyclePhase'), false);
    });
  }
}

test('legacy publisher remains exclusive to cpslai1', () => {
  const publications = [];
  const client = {
    connected: true,
    publish: (topic, payload) => publications.push({ topic, payload: JSON.parse(payload) }),
  };
  publishCpsOperationalHealth({
    client,
    topic: 'cpslai1/health',
    cpsId: 'cpslai1',
    status: { communication: { dataFresh: false }, operationalState: 'RUNNING', timestamp },
  });
  assert.deepEqual(publications.map(({ topic, payload }) => [topic, payload.cpsId, payload.score]), [
    ['cpslai1/health', 'cpslai1', 0],
  ]);
  assert.equal(buildCpsOperationalHealth({
    cpsId: 'cpslai2',
    communication: { dataFresh: true },
    operationalState: 'RUNNING',
  }), null);
});

test('publisher rejects a topic owned by the other physical CPS', () => {
  const publications = [];
  const payload = publishCpsOperationalHealth({
    client: { connected: true, publish: (...args) => publications.push(args) },
    topic: 'cpslai1/health',
    cpsId: 'cpslai2',
    status: { communication: { dataFresh: true }, operationalState: 'MAINTENANCE', timestamp },
  });
  assert.equal(payload, null);
  assert.equal(publications.length, 0);
});

test('unsupported CPS identities are not changed by the physical Operational Health rule', () => {
  assert.equal(buildCpsOperationalHealth({
    cpsId: 'cpslai3',
    communication: { dataFresh: true },
    operationalState: 'RUNNING',
  }), null);
});

test('each cpslai1 status update publishes at most one OPERATIONAL_HEALTH payload', () => {
  const publications = [];
  const client = {
    connected: true,
    publish: (topic, payload, options) => publications.push({ topic, payload: JSON.parse(payload), options }),
  };
  publishCpsLai1OperationalHealth({
    client,
    topic: 'cpslai1/health',
    status: {
      communication: { dataFresh: true, dataAgeMs: 125 },
      operationalState: 'STOPPED',
      timestamp,
    },
  });

  assert.equal(publications.length, 1);
  assert.equal(publications[0].topic, 'cpslai1/health');
  assert.deepEqual(publications[0].options, { qos: 1, retain: true });
  assert.equal(publications[0].payload.healthType, 'OPERATIONAL_HEALTH');
  assert.notEqual(publications[0].payload.healthState, 'NOT_DERIVED');
  assert.equal(
    publications[0].payload.note.includes('Machine health intentionally not derived'),
    false
  );
});

test('legacy adapter technical-state cycle no longer publishes cpslai1/health', () => {
  const adapter = new MqttAdapter(
    { topics: { status: 'cpslai1/status', health: 'cpslai1/health' } },
    {},
    () => {},
    { status: () => ({ cpsId: 'cpslai1' }), health: () => ({ healthState: 'NOT_DERIVED' }) }
  );
  const publications = [];
  adapter.publish = (topic, payload, options) => publications.push({ topic, payload, options });

  adapter.publishTechnicalState();

  assert.deepEqual(publications.map(({ topic }) => topic), ['cpslai1/status']);
});
