import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flowPath = path.join(root, 'node-red', 'lai', 'flows', 'cps-lai-02-synthetic-oee-health.json');
const sourcePath = path.join(root, 'node-red', 'lai', 'functions', 'cps-lai-02-synthetic-oee-health.js');
const flow = JSON.parse(fs.readFileSync(flowPath, 'utf8'));
const source = fs.readFileSync(sourcePath, 'utf8').replace(/\r\n/g, '\n').trimEnd();
const evaluator = flow.find(node => node.id === 'cpslai2_synth_calculate');

function run(messages, context = new Map()) {
  const fn = new Function('msg', 'flow', 'Buffer', evaluator.func);
  const state = { get: key => context.get(key), set: (key, value) => context.set(key, value) };
  let result;
  for (const msg of messages) result = fn(msg, state, Buffer);
  return { result, context };
}

function data(mode = 'AUTOMATIC', timestamp = new Date().toISOString(), overrides = {}) {
  const values = {
    INIT: [true, false, false, false],
    MANUAL: [false, true, false, false],
    AUTOMATIC: [false, false, true, false],
    STEP_BY_STEP: [false, false, false, true],
    UNKNOWN: [false, false, false, false],
  }[mode];
  const tags = ['GCT_0', 'sys_man', 'sys_sup', 'sys_man2'];
  const sample = (tag, value) => ({
    field: tag, value, nodeId: `ns=3;s="${tag}"`, dataType: 'Boolean',
    dataTypeNodeId: 'ns=0;i=1', dataTypeEvidence: 'OPC_UA_ATTRIBUTE_DATATYPE',
    collectedAt: timestamp, statusCode: 'Good', quality: 'Good', valid: true, stale: false,
  });
  return {
    schemaVersion: '1.2', cpsId: 'cpslai2', publishedAt: timestamp, timestamp,
    staleAfterMs: 6000, snapshotComplete: false, availableTagCount: 4, expectedTagCount: 7,
    data: Object.fromEntries(tags.map((tag, index) => [tag, sample(tag, values[index])])),
    derived: {
      operationMode: mode, source: 'PHYSICAL_OPCUA_MARKERS',
      semanticValidationStatus: 'PHYSICALLY_VALIDATED', derivedAt: timestamp,
    },
    ...overrides,
  };
}

test('flow is importable, disabled, MQTT-only and synchronized with its readable function source', () => {
  const tab = flow.find(node => node.type === 'tab');
  assert.equal(tab.label, 'CPS-LAI-02 — Synthetic OEE & Health');
  assert.equal(tab.disabled, true);
  assert.equal(evaluator.func, source);
  assert.doesNotThrow(() => new Function('msg', 'flow', 'Buffer', evaluator.func));
  assert.deepEqual(flow.filter(node => node.type === 'mqtt in').map(node => node.topic), ['cpslai2/data']);
  assert.deepEqual(
    flow.filter(node => node.type === 'mqtt out').map(node => node.topic).sort(),
    ['cpslai2/synthetic-health', 'cpslai2/synthetic-oee']
  );
  assert.equal(flow.some(node => /opc.?ua|http|websocket|tcp|udp|write|command/i.test(`${node.type} ${node.name || ''}`)), false);
});

test('AUTOMATIC publishes five numeric indicators without requiring auxiliary tags or communication fields', () => {
  const { result } = run([{ topic: 'cpslai2/data', payload: data() }]);
  const oee = JSON.parse(result[0].payload);
  const health = JSON.parse(result[1].payload);
  assert.equal(oee.calculationState, 'SYNTHETIC');
  assert.deepEqual(
    [oee.oee.availability, oee.oee.performance, oee.oee.quality, oee.oee.current],
    [100, 90, 98, 88.2]
  );
  assert.equal(Number.isFinite(health.health.current), true);
  assert.equal(health.calculationState, 'SYNTHETIC');
  assert.deepEqual(oee.sourceTopics, ['cpslai2/data']);
});

for (const mode of ['MANUAL', 'STEP_BY_STEP', 'INIT']) {
  test(`${mode} holds the last OEE while continuing to calculate Health`, () => {
    const context = new Map();
    const automatic = run([{ topic: 'cpslai2/data', payload: data('AUTOMATIC') }], context);
    const computed = JSON.parse(automatic.result[0].payload);
    const next = run([{ topic: 'cpslai2/data', payload: data(mode) }], context);
    const oee = JSON.parse(next.result[0].payload);
    const health = JSON.parse(next.result[1].payload);
    assert.equal(oee.calculationState, 'HELD_LAST_VALUE');
    assert.equal(oee.reason, `MODE_${mode}_NOT_AUTOMATIC`);
    assert.equal(oee.calculatedAt, computed.calculatedAt);
    assert.deepEqual(oee.oee, computed.oee);
    assert.equal(health.calculationState, 'SYNTHETIC');
  });
}

test('UNKNOWN, stale evidence and bad OPC UA quality produce no current indicators', () => {
  const cases = [
    data('UNKNOWN'),
    data('AUTOMATIC', new Date(Date.now() - 60_000).toISOString()),
    (() => {
      const payload = data('AUTOMATIC');
      payload.data.sys_sup.statusCode = 'BadNotConnected';
      payload.data.sys_sup.quality = 'BadNotConnected';
      payload.data.sys_sup.valid = false;
      return payload;
    })(),
  ];
  for (const payload of cases) {
    const { result } = run([{ topic: 'cpslai2/data', payload }]);
    const oee = JSON.parse(result[0].payload);
    const health = JSON.parse(result[1].payload);
    assert.equal(oee.calculationState, 'NOT_COMPUTED');
    assert.deepEqual([oee.oee.current, oee.oee.availability, oee.oee.performance, oee.oee.quality], [null, null, null, null]);
    assert.equal(health.calculationState, 'NOT_COMPUTED');
    assert.equal(health.health.current, null);
  }
});

test('return to AUTOMATIC starts a new window and excludes non-automatic time', () => {
  const context = new Map();
  const firstAt = new Date(Date.now() - 2000).toISOString();
  const manualAt = new Date(Date.now() - 1000).toISOString();
  const returnAt = new Date().toISOString();
  run([{ topic: 'cpslai2/data', payload: data('AUTOMATIC', firstAt) }], context);
  run([{ topic: 'cpslai2/data', payload: data('MANUAL', manualAt) }], context);
  const { result } = run([{ topic: 'cpslai2/data', payload: data('AUTOMATIC', returnAt) }], context);
  const oee = JSON.parse(result[0].payload);
  assert.equal(oee.window.windowStart, returnAt);
  assert.equal(oee.window.windowEnd, returnAt);
  assert.equal(oee.window.snapshotCount, 1);
  assert.equal(oee.window.baselineOnly, true);
  assert.equal(oee.oee.availability, 100);
});

test('messages and payloads for CPS-LAI-03 remain isolated', () => {
  assert.equal(run([{ topic: 'cpslai3/data', payload: { ...data(), cpsId: 'cpslai3' } }]).result, null);
  assert.equal(run([{ topic: 'cpslai2/data', payload: { ...data(), cpsId: 'cpslai3' } }]).result, null);
});
