import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateMessage } from '../services/cps-lai-01-persistence/src/contracts.js';
import { normalizeOeePayload } from '../services/cps-lai-01-cognitive/contracts.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flowPath = path.join(root, 'node-red', 'lai', 'flows', 'cps-lai-01-synthetic-emulator.json');
const configPath = path.join(root, 'node-red', 'lai', 'config', 'cps-lai-01-synthetic-scenarios.json');
const flow = JSON.parse(fs.readFileSync(flowPath, 'utf8'));
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const byId = new Map(flow.map(node => [node.id, node]));
const controller = byId.get('cpslai1_synthetic_controller');
const generator = byId.get('cpslai1_synthetic_generator');
const normalizer = byId.get('cpslai1_synthetic_normalize');
const metrics = byId.get('cpslai1_synthetic_metrics');
const snapshot = byId.get('cpslai1_synthetic_snapshot');
const contractAdapter = byId.get('cpslai1_operational_contract_adapter');

function context() {
  const values = new Map();
  return { values, get: key => values.get(key), set: (key, value) => values.set(key, value) };
}

function invoke(node, msg, state) {
  return new Function('msg', 'flow', 'Buffer', node.func)(msg, state, Buffer);
}

function start(state, scenario, at = 1000) {
  return invoke(controller, { payload: { command: 'restart', scenario }, _syntheticNowMs: at }, state);
}

function step(state, scenario, elapsed, startAt = 1000) {
  const now = startAt + elapsed;
  const [signals, snap] = invoke(generator, { payload: 'tick', _syntheticNowMs: now }, state);
  for (const signal of signals || []) {
    const normalized = invoke(normalizer, signal, state);
    if (normalized) invoke(metrics, normalized, state);
  }
  return snap ? invoke(snapshot, snap, state) : null;
}

function runScenario(scenario, durationMs, stepMs = 250) {
  const state = context();
  start(state, scenario);
  let last;
  for (let t = 0; t <= durationMs; t += stepMs) last = step(state, scenario, t);
  return { state, last };
}

function parsed(msg) {
  assert.ok(msg, 'expected output message');
  return typeof msg.payload === 'string' ? JSON.parse(msg.payload) : msg.payload;
}

test('flow is disabled and its four publishers use the principal operational broker', () => {
  assert.equal(flow.length > 0, true);
  const tab = flow.find(node => node.type === 'tab');
  assert.equal(tab.label, 'CPS-LAI-01 — OPERATIONAL EMULATOR');
  assert.equal(tab.disabled, true);
  assert.equal(config.identity, 'cpslai1');
  assert.equal(config.producerComponent, 'CPS_LAI_01_OPERATIONAL_EMULATOR');
  assert.equal(config.manualStartRequired, true);
  assert.equal(flow.every(node => ['tab', 'comment', 'inject', 'function', 'debug', 'mqtt-broker', 'mqtt out'].includes(node.type)), true);
  assert.equal(flow.some(node => /mqtt in|opcua|mysql|email|e-mail/i.test(node.type)), false);
  assert.equal(flow.some(node => /192\.168\.1\.10|acsm\/cpslai1\/lifecycle/i.test(JSON.stringify(node))), false);
  assert.deepEqual(flow.filter(node => node.type === 'debug').length, 4);
  for (const node of flow.filter(node => node.type === 'function')) {
    for (const match of node.func.matchAll(/flow\.(?:get|set)\(['"]([^'"]+)/g)) {
      assert.match(match[1], /^cpslai1_synthetic_/);
    }
    assert.doesNotMatch(node.func, /global\.(?:get|set)|mqtt|mysql|hcm|ppu|sendmail/i);
  }
  assert.equal(flow.find(node => node.id === 'cpslai1_synthetic_tick').once, false);
  const broker = flow.find(node => node.type === 'mqtt-broker');
  assert.equal(broker.broker, '127.0.0.1');
  assert.equal(broker.port, '1883');
  assert.equal(broker.autoConnect, true);
  assert.deepEqual(flow.filter(node => node.type === 'mqtt out').map(node => node.topic).sort(), [
    'cpslai1/data', 'cpslai1/health', 'cpslai1/oee', 'cpslai1/status',
  ]);
});

test('start, stop and restart are manual; restart clears only synthetic state', () => {
  const state = context();
  state.set('cpslai1_synthetic_totalCount', 99);
  state.set('cpslai1_latest', { physical: true });
  const started = parsed(start(state, 'normal'));
  assert.equal(started.eventType, 'SCENARIO_RESTARTED');
  assert.equal(started.cpsId, 'cpslai1');
  assert.equal(state.get('cpslai1_synthetic_active'), true);
  assert.deepEqual(state.get('cpslai1_latest'), { physical: true });
  const stopped = parsed(invoke(controller, { payload: { command: 'stop' }, _syntheticNowMs: 2000 }, state));
  assert.equal(stopped.eventType, 'SCENARIO_STOPPED');
  assert.equal(state.get('cpslai1_synthetic_active'), false);
});

test('normal sequence Entry → Middle → Exit counts completed cycles and preserves OEE formulas', () => {
  const state = context();
  start(state, 'normal');
  const previous = new Map();
  const risingOrder = [];
  let last;
  for (let elapsed = 0; elapsed <= 9000; elapsed += 250) {
    const now = 1000 + elapsed;
    const [signals, snap] = invoke(generator, { payload: 'tick', _syntheticNowMs: now }, state);
    for (const signal of signals || []) {
      if (['G1BG3', 'G1BG2', 'G1BG1'].some(tag => signal.topic.endsWith(`"${tag}"`))) {
        const tag = signal._syntheticTag;
        if (previous.get(tag) === false && signal.payload === true) risingOrder.push(tag);
        previous.set(tag, signal.payload);
      }
      const normalized = invoke(normalizer, signal, state);
      if (normalized) invoke(metrics, normalized, state);
    }
    last = invoke(snapshot, snap, state);
  }
  const production = state.get('cpslai1_synthetic_production_metrics');
  assert.ok(production.completedCycles >= 2);
  assert.equal(production.incompleteCycles, 0);
  assert.equal(production.totalCount, production.completedCycles);
  assert.ok(production.lastCycleTimeMs > 0);
  assert.deepEqual(risingOrder.slice(0, 3), ['G1BG3', 'G1BG2', 'G1BG1']);
  const dataMessage = invoke(contractAdapter, last[0], state)[0];
  const statusOutputs = invoke(contractAdapter, last[1], state);
  const oeeMessage = invoke(contractAdapter, last[2], state)[2];
  const data = parsed(dataMessage);
  const status = parsed(statusOutputs[1]);
  const health = parsed(statusOutputs[3]);
  const oee = parsed(oeeMessage);
  assert.equal(data.cpsId, 'cpslai1');
  assert.equal(data.source, 'OPC_UA');
  assert.equal(data.data.PieceAtEntry, false);
  assert.equal(status.operationalState, 'RUNNING');
  assert.equal(oee.production.totalCount, production.totalCount);
  assert.equal(oee.oee.availability, oee.time.runTimeMs / oee.time.plannedProductionTimeMs);
  assert.equal(oee.oee.performance, Math.min(1, (2020 * oee.production.totalCount) / oee.time.runTimeMs));
  assert.equal(oee.oee.quality, 1);
  assert.equal(oee.oee.current, oee.oee.availability * oee.oee.performance * oee.oee.quality);
  assert.equal(oee.evidenceStatus, 'SENSOR_DERIVED_OPERATIONAL_OEE');
  assert.equal(health.healthType, 'OPERATIONAL_HEALTH');
  assert.equal(health.healthState, 'HEALTHY');
  assert.deepEqual([dataMessage.topic, statusOutputs[1].topic, oeeMessage.topic, statusOutputs[3].topic], [
    'cpslai1/data', 'cpslai1/status', 'cpslai1/oee', 'cpslai1/health',
  ]);
});

test('incomplete cycle counts exit without a Middle confirmation', () => {
  const { state } = runScenario('incomplete', 2000);
  const production = state.get('cpslai1_synthetic_production_metrics');
  assert.equal(production.totalCount, 1);
  assert.equal(production.completedCycles, 0);
  assert.equal(production.incompleteCycles, 1);
});

test('degradation reduces performance relative to normal operation', () => {
  const normal = runScenario('normal', 30000).last;
  const degraded = runScenario('degradation', 30000).last;
  assert.ok(parsed(normal[2]).oee.performance > parsed(degraded[2]).oee.performance);
});

test('stop scenario becomes STOPPED after physical inactivity exceeds threshold', () => {
  const { last } = runScenario('stop', 8500);
  assert.equal(parsed(last[1]).operationalState, 'STOPPED');
  assert.ok(parsed(last[2]).time.stoppedTimeMs > 0);
});

test('maintenance marker produces MAINTENANCE and accumulates maintenance time', () => {
  const { last } = runScenario('maintenance', 2000);
  assert.equal(parsed(last[1]).operationMode, 'STEP_BY_STEP');
  assert.equal(parsed(last[1]).operationalState, 'MAINTENANCE');
  assert.ok(parsed(last[2]).time.maintenanceTimeMs > 0);
});

test('alarm raises a synthetic alarm event without changing the operational rule', () => {
  const state = context();
  start(state, 'alarm');
  let last;
  let alarmEvent;
  for (let elapsed = 0; elapsed <= 1000; elapsed += 250) {
    last = step(state, 'alarm', elapsed);
    if (last[3]) alarmEvent = last[3];
  }
  assert.equal(parsed(last[0]).data.AlarmSignal, true);
  assert.equal(parsed(last[1]).operationalState, 'RUNNING');
  assert.equal(parsed(alarmEvent).eventType, 'SYNTHETIC_ALARM_RAISED');
  const alarm = state.get('cpslai1_synthetic_last_alarm');
  assert.equal(alarm, true);
});

test('return scenario uses INIT during return and resumes play', () => {
  const state = context();
  start(state, 'return');
  const returning = step(state, 'return', 1000);
  assert.equal(parsed(returning[1]).lifecyclePhase, 'return');
  assert.equal(parsed(returning[1]).operationMode, 'INIT');
  const resumed = step(state, 'return', 4000);
  assert.equal(parsed(resumed[1]).lifecyclePhase, 'play');
  assert.equal(parsed(resumed[1]).operationMode, 'AUTOMATIC');
});

test('communication loss lets freshness expire and reports UNKNOWN', () => {
  const state = context();
  start(state, 'communicationLoss');
  let last;
  for (let t = 0; t <= 7000; t += 250) last = step(state, 'communicationLoss', t);
  assert.equal(parsed(last[1]).communication.dataFresh, false);
  assert.equal(parsed(last[1]).operationalState, 'UNKNOWN');
});

test('operational adapter aligns data, status, OEE and health contracts', () => {
  const state = context();
  const started = parsed(start(state, 'alarm'));
  assert.equal(started.cpsId, 'cpslai1');
  const last = step(state, 'alarm', 250);
  const data = parsed(invoke(contractAdapter, last[0], state)[0]);
  const statusOutputs = invoke(contractAdapter, last[1], state);
  const status = parsed(statusOutputs[1]);
  const health = parsed(statusOutputs[3]);
  const oee = parsed(invoke(contractAdapter, last[2], state)[2]);
  for (const payload of [data, status, health, oee]) {
    assert.equal(payload.cpsId, 'cpslai1');
    assert.equal(payload.producerComponent, 'CPS_LAI_01_OPERATIONAL_EMULATOR');
    assert.equal('classification' in payload, false);
    assert.equal('synthetic' in payload, false);
  }
  const normalized = invoke(normalizer, { topic: 'ns=3;s="G1BG3"', payload: true, statusCode: { value: 0 }, _synthetic: true, _syntheticNowMs: 1000 }, state);
  assert.equal(normalized.payload.evidenceOrigin, 'OPERATIONAL_EMULATOR');
});

test('all eight scenarios satisfy persistence and cognitive MQTT contracts', () => {
  for (const scenario of Object.keys(config.scenarios)) {
    const { state, last } = runScenario(scenario, scenario === 'communicationLoss' ? 7000 : 9000);
    const data = invoke(contractAdapter, last[0], state)[0];
    const statusOutputs = invoke(contractAdapter, last[1], state);
    const oee = invoke(contractAdapter, last[2], state)[2];
    const messages = [data, statusOutputs[1], oee, statusOutputs[3]];
    for (const message of messages) {
      const result = validateMessage(message.topic, message.payload);
      assert.equal(result.ok, true, `${scenario} ${message.topic}: ${result.errors?.join(',')}`);
    }
    const cognitive = normalizeOeePayload(oee.payload);
    assert.equal(cognitive.raw.cpsId, 'cpslai1');
  }
});
