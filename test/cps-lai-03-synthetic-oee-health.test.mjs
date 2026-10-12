import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flow = JSON.parse(fs.readFileSync(path.join(root, 'node-red', 'lai', 'flows', 'cps-lai-03-synthetic-oee-health.json'), 'utf8'));
const tab = flow.find(node => node.type === 'tab');
const evaluator = flow.find(node => node.id === 'cpslai3_synth_calculate');

function run(messages, context = new Map()) {
  const fn = new Function('msg', 'flow', 'Buffer', evaluator.func);
  const state = { get: key => context.get(key), set: (key, value) => context.set(key, value) };
  let result;
  for (const msg of messages) result = fn(msg, state, Buffer);
  return { result, context };
}

function data(mode = 'AUTOMATIC', timestamp = new Date().toISOString(), overrides = {}) {
  const sample = value => ({ value, valid: true, stale: false, statusCode: 'Good' });
  return {
    cpsId: 'cpslai3', publishedAt: timestamp, snapshotComplete: true,
    communication: { connected: true, dataFresh: true },
    derived: { operationMode: mode, semanticValidationStatus: 'PHYSICALLY_VALIDATED' },
    data: { GCT_0: sample(false), sys_man: sample(mode === 'MANUAL'), sys_sup: sample(mode === 'AUTOMATIC'), sys_man2: sample(mode === 'STEP_BY_STEP') },
    ...overrides,
  };
}

function metrics(timestamp = new Date().toISOString()) {
  return {
    cpsId: 'cpslai3', updatedAt: timestamp, source: 'CPS_LAI_03_EXPERIMENTAL_SIGNAL_AGGREGATOR',
    evidenceQuality: 'CURRENT', metricSessionId: 'optional-session',
    measuredSignals: ['B1BG1', 'G1BG3', 'G1MB1', 'G1MB2'].map(tag => ({ tag, valid: true, statusCode: 'Good' })),
    metrics: { pieceSensorActivationCount: 1 },
  };
}

test('independent flow is isolated, enabled for continuous publication and uses only synthetic topics', () => {
  assert.equal(tab.disabled, false);
  assert.deepEqual(flow.filter(n => n.type === 'mqtt out').map(n => n.topic).sort(), ['cpslai3/synthetic-health', 'cpslai3/synthetic-oee']);
  assert.deepEqual(flow.filter(n => n.type === 'mqtt in').map(n => n.topic).sort(), ['cpslai3/data', 'cpslai3/experimental-metrics']);
  assert.equal(flow.some(n => /opc.?ua|write|call|command/i.test(`${n.type} ${n.name || ''}`)), false);
  assert.doesNotThrow(() => new Function('msg', 'flow', 'Buffer', evaluator.func));
});

test('data alone continuously publishes five finite numeric indicators', () => {
  const { result } = run([{ topic: 'cpslai3/data', payload: data() }]);
  const oee = JSON.parse(result[0].payload);
  const health = JSON.parse(result[1].payload);
  for (const value of [oee.oee.availability, oee.oee.performance, oee.oee.quality, oee.oee.current, health.health.current]) {
    assert.equal(Number.isFinite(value), true);
    assert.ok(value >= 0 && value <= 100);
  }
  assert.equal(oee.oee.availability, 100);
  assert.equal(oee.oee.performance, 90);
  assert.equal(oee.oee.quality, 98);
  assert.equal(oee.oee.current, 88.2);
  assert.equal(oee.componentStatus.availability.origin, 'PHYSICAL_EVIDENCE');
  assert.equal(oee.componentStatus.performance.origin, 'SYNTHETIC_ESTIMATE');
  assert.equal(oee.componentStatus.quality.origin, 'SYNTHETIC_ESTIMATE');
  assert.deepEqual(oee.sourceTopics, ['cpslai3/data']);
  assert.equal(oee.optionalExperimentalEvidence.used, false);
  assert.equal(health.health.source, 'TELEMETRY_INTEGRITY_MODEL');
  assert.notEqual(health.health.current, oee.oee.current);
});

test('leaving AUTOMATIC for STEP_BY_STEP holds the last OEE and its calculation time', () => {
  const context = new Map();
  const automatic = run([{ topic: 'cpslai3/data', payload: data('AUTOMATIC') }], context);
  const computed = JSON.parse(automatic.result[0].payload);
  const step = run([{ topic: 'cpslai3/data', payload: data('STEP_BY_STEP') }], context);
  const held = JSON.parse(step.result[0].payload);
  assert.equal(computed.calculationState, 'SYNTHETIC');
  assert.equal(held.calculationState, 'HELD_LAST_VALUE');
  assert.equal(held.reason, 'MODE_STEP_BY_STEP_NOT_AUTOMATIC');
  assert.equal(held.currentMode, 'STEP_BY_STEP');
  assert.equal(held.calculatedAt, computed.calculatedAt);
  assert.deepEqual(held.oee, computed.oee);
  assert.equal(held.componentStatus.oee.state, 'HELD_LAST_VALUE');
  assert.equal(JSON.parse(step.result[1].payload).calculationState, 'SYNTHETIC', 'Health remains independent');
});

test('maintenance also holds OEE while Health continues from valid evidence', () => {
  const context = new Map();
  run([{ topic: 'cpslai3/data', payload: data('AUTOMATIC') }], context);
  const { result } = run([{ topic: 'cpslai3/data', payload: data('MAINTENANCE') }], context);
  assert.equal(JSON.parse(result[0].payload).reason, 'MODE_MAINTENANCE_NOT_AUTOMATIC');
  assert.equal(JSON.parse(result[0].payload).calculationState, 'HELD_LAST_VALUE');
  assert.equal(JSON.parse(result[1].payload).calculationState, 'SYNTHETIC');
});

test('returning to AUTOMATIC starts a new window without non-automatic time', () => {
  const context = new Map();
  const firstAt = new Date(Date.now() - 2000).toISOString();
  const stepAt = new Date(Date.now() - 1000).toISOString();
  const returnAt = new Date().toISOString();
  run([{ topic: 'cpslai3/data', payload: data('AUTOMATIC', firstAt) }], context);
  run([{ topic: 'cpslai3/data', payload: data('STEP_BY_STEP', stepAt) }], context);
  const { result } = run([{ topic: 'cpslai3/data', payload: data('AUTOMATIC', returnAt) }], context);
  const oee = JSON.parse(result[0].payload);
  assert.equal(oee.calculationState, 'SYNTHETIC');
  assert.equal(oee.window.windowStart, returnAt);
  assert.equal(oee.window.windowEnd, returnAt);
  assert.equal(oee.window.baselineOnly, true);
  assert.equal(oee.window.snapshotCount, 1);
  assert.equal(oee.oee.availability, 100);
});

test('valid experimental metrics are optional additional evidence for Performance', () => {
  const firstAt = new Date(Date.now() - 1000).toISOString();
  const now = new Date().toISOString();
  const context = new Map();
  run([
    { topic: 'cpslai3/experimental-metrics', payload: metrics(firstAt) },
    { topic: 'cpslai3/data', payload: data('AUTOMATIC', firstAt) },
  ], context);
  const updatedMetrics = metrics(now);
  updatedMetrics.metrics.pieceSensorActivationCount = 2;
  const { result } = run([
    { topic: 'cpslai3/experimental-metrics', payload: updatedMetrics },
    { topic: 'cpslai3/data', payload: data('AUTOMATIC', now) },
  ], context);
  const oee = JSON.parse(result[0].payload);
  assert.equal(oee.optionalExperimentalEvidence.used, true);
  assert.equal(oee.componentStatus.performance.origin, 'SYNTHETIC_ESTIMATE_WITH_PHYSICAL_EVIDENCE');
  assert.deepEqual(oee.sourceTopics, ['cpslai3/data', 'cpslai3/experimental-metrics']);
});

test('invalid telemetry or UNKNOWN mode never creates current OEE or Health values', () => {
  const stale = new Date(Date.now() - 60000).toISOString();
  const { result } = run([{ topic: 'cpslai3/data', payload: data('UNKNOWN', stale, { snapshotComplete: false, communication: { connected: false, dataFresh: false }, data: {} }) }]);
  const oee = JSON.parse(result[0].payload);
  const health = JSON.parse(result[1].payload);
  assert.equal(oee.calculationState, 'NOT_COMPUTED');
  assert.deepEqual([oee.oee.current, oee.oee.availability, oee.oee.performance, oee.oee.quality], [null, null, null, null]);
  assert.equal(health.calculationState, 'NOT_COMPUTED');
  assert.equal(health.health.current, null);
  assert.equal(health.evidenceStatus, 'DEGRADED_PHYSICAL_TELEMETRY');
});

test('absence of history outside AUTOMATIC publishes NOT_COMPUTED with null values', () => {
  const { result } = run([{ topic: 'cpslai3/data', payload: data('STEP_BY_STEP') }]);
  const oee = JSON.parse(result[0].payload);
  assert.equal(oee.calculationState, 'NOT_COMPUTED');
  assert.equal(oee.calculatedAt, null);
  assert.deepEqual([oee.oee.current, oee.oee.availability, oee.oee.performance, oee.oee.quality], [null, null, null, null]);
});
