import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const flowPath = new URL('../node-red/lai/flows/cps-lai-03-opcua-mqtt.json', import.meta.url);
const flow = JSON.parse(readFileSync(flowPath, 'utf8'));
const byId = (id) => flow.find((node) => node.id === id);
const runFunction = (id, msg, context = new Map()) => {
  const node = byId(id);
  const flowContext = {
    get: (key) => context.get(key),
    set: (key, value) => context.set(key, value),
  };
  return new Function('msg', 'flow', 'node', node.func)(msg, flowContext, { warn() {} });
};

const goodSignals = {
  B1BG1: 'ns=3;s="B1BG1"',
  G1BG3: 'ns=3;s="G1BG3"',
  G1MB1: 'ns=3;s="G1MB1"',
  G1MB2: 'ns=3;s="G1MB2"',
};

const startSession = (context) => {
  return runFunction('c3a000000000001f', { payload: Date.now() }, context);
};

const calculateOee = (context) => {
  const result = runFunction('c3a0000000000019', { payload: { cpsId: 'cpslai3' } }, context);
  return JSON.parse(result.payload);
};

const publishBatch = (context, values, options = {}) => {
  const requests = runFunction('c3a000000000001a', { payload: Date.now() }, context);
  assert.ok(requests?.[0], 'experimental requests should be generated');
  let result = null;
  for (const request of requests[0]) {
    const tag = request._tag;
    const sample = options[tag] || {};
    result = runFunction('c3a000000000001c', {
      ...request,
      value: Object.hasOwn(sample, 'value') ? sample.value : values[tag],
      dataType: Object.hasOwn(sample, 'dataType') ? sample.dataType : 'ns=0;i=1',
      statusCode: Object.hasOwn(sample, 'statusCode') ? sample.statusCode : 'Good',
      sourceTimestamp: '2014-01-01T00:00:00.000Z',
      serverTimestamp: '2014-01-01T00:00:00.000Z',
    }, context);
  }
  return result;
};

test('adapter retains one read-only OPC UA client and adds only the four requested signals', () => {
  assert.doesNotThrow(() => JSON.parse(readFileSync(flowPath, 'utf8')));
  const clients = flow.filter((node) => node.type === 'OpcUa-Client');
  assert.equal(clients.length, 1);
  assert.equal(clients[0].action, 'info');
  assert.equal(flow.some((node) => /write|call/i.test(`${node.action || ''} ${node.name || ''}`)), false);

  const requestNode = byId('c3a000000000001a');
  for (const [tag, nodeId] of Object.entries(goodSignals)) {
    assert.ok(requestNode.func.includes(tag));
    assert.ok(requestNode.func.includes(nodeId.replaceAll('"', '\\"')));
  }
  const requests = runFunction('c3a000000000001a', { payload: Date.now() }, new Map());
  assert.deepEqual(requests[0].map((request) => request._tag), Object.keys(goodSignals));
  assert.equal(byId('c3a0000000000001').disabled, true);
  assert.ok(flow.some((node) => node.type === 'mqtt out' && node.topic === 'cpslai3/experimental-metrics'));
  assert.ok(flow.some((node) => node.type === 'mqtt out' && node.topic === 'cpslai3/oee'));
});

test('baseline is not counted; false-to-true edges count once per signal; repeated true does not', () => {
  const context = new Map();
  startSession(context);
  const baseline = publishBatch(context, { B1BG1: false, G1BG3: false, G1MB1: false, G1MB2: false });
  assert.equal(baseline.payload.evidenceQuality, 'BASELINE_ONLY');
  assert.deepEqual(baseline.payload.metrics, {
    pieceSensorActivationCount: 0,
    conveyorSignalActiveTimeMs: 0,
    separator1ActivationCount: 0,
    separator2ActivationCount: 0,
  });

  const rising = publishBatch(context, { B1BG1: true, G1BG3: true, G1MB1: true, G1MB2: true });
  assert.equal(rising.payload.metrics.pieceSensorActivationCount, 1);
  assert.equal(rising.payload.metrics.separator1ActivationCount, 1);
  assert.equal(rising.payload.metrics.separator2ActivationCount, 1);
  assert.ok(rising.payload.metrics.conveyorSignalActiveTimeMs >= 0);
  assert.equal(rising.payload.interpretation.oee, 'NOT_COMPUTED');

  const repeated = publishBatch(context, { B1BG1: true, G1BG3: true, G1MB1: true, G1MB2: true });
  assert.equal(repeated.payload.metrics.pieceSensorActivationCount, 1);
  assert.equal(repeated.payload.metrics.separator1ActivationCount, 1);
  assert.equal(repeated.payload.metrics.separator2ActivationCount, 1);
});

test('invalid batch clears the edge baseline; first recovery batch only establishes a new baseline', () => {
  const context = new Map();
  startSession(context);
  publishBatch(context, { B1BG1: false, G1BG3: false, G1MB1: false, G1MB2: false });
  const invalid = publishBatch(context,
    { B1BG1: true, G1BG3: true, G1MB1: true, G1MB2: true },
    { G1MB1: { statusCode: 'BadSensorFailure' } });
  assert.equal(invalid.payload.evidenceQuality, 'INVALID_OR_STALE_SAMPLE');
  assert.equal(invalid.payload.metrics.pieceSensorActivationCount, 0);

  const recovered = publishBatch(context, { B1BG1: true, G1BG3: true, G1MB1: true, G1MB2: true });
  assert.equal(recovered.payload.evidenceQuality, 'BASELINE_ONLY');
  assert.equal(recovered.payload.metrics.pieceSensorActivationCount, 0);
});

test('datatype mismatch is invalid and stopped sessions do not aggregate', () => {
  const context = new Map();
  startSession(context);
  const wrongType = publishBatch(context,
    { B1BG1: false, G1BG3: false, G1MB1: false, G1MB2: false },
    { B1BG1: { dataType: 'ns=0;i=1' }, G1BG3: { dataType: 'ns=0;i=6' } });
  assert.equal(wrongType.payload.evidenceQuality, 'INVALID_OR_STALE_SAMPLE');
  assert.equal(wrongType.payload.measuredSignals.find((x) => x.tag === 'G1BG3').valid, false);

  runFunction('c3a0000000000022', { payload: Date.now() }, context);
  const stopped = publishBatch(context, { B1BG1: true, G1BG3: true, G1MB1: true, G1MB2: true });
  assert.equal(stopped, null);
});

test('manual reset creates a new session with zeroed counters and OEE remains NOT_COMPUTED', () => {
  const context = new Map();
  startSession(context);
  publishBatch(context, { B1BG1: false, G1BG3: false, G1MB1: false, G1MB2: false });
  publishBatch(context, { B1BG1: true, G1BG3: true, G1MB1: true, G1MB2: true });
  const previousId = context.get('cpslai3_exp_session').id;
  const reset = runFunction('c3a000000000001f', { payload: Date.now() }, context);
  assert.notEqual(reset.payload.metricSessionId, previousId);
  assert.equal(reset.payload.metrics.pieceSensorActivationCount, 0);
  assert.equal(reset.payload.interpretation.oee, 'NOT_COMPUTED');

  const oeeBuilder = byId('c3a0000000000019');
  assert.match(oeeBuilder.func, /NOT_COMPUTED/);
  assert.match(oeeBuilder.func, /const oee=\{current:null,availability:null,performance:null,quality:null\}/);
});

test('runtime restart interrupts a live session and clears the baseline without emitting metrics', () => {
  const context = new Map();
  startSession(context);
  publishBatch(context, { B1BG1: false, G1BG3: false, G1MB1: false, G1MB2: false });
  assert.ok(context.get('cpslai3_exp_baseline'));

  assert.equal(byId('c3a0000000000023').once, true);
  const result = runFunction('c3a0000000000024', { payload: Date.now() }, context);
  assert.equal(result, null);
  assert.equal(context.get('cpslai3_exp_session').status, 'INTERRUPTED_BY_RUNTIME_RESTART');
  assert.equal(context.get('cpslai3_exp_baseline'), null);
  assert.equal(context.get('cpslai3_exp_batch'), null);
});

test('OPC UA disconnect and reconnect both clear experimental baseline and pending batch', () => {
  const context = new Map([
    ['cpslai3_exp_connected', true],
    ['cpslai3_exp_baseline', { at: Date.now(), v: { B1BG1: false } }],
    ['cpslai3_exp_batch', { id: 'pending' }],
  ]);
  runFunction('c3a0000000000025', { payload: { communication: { connected: false } } }, context);
  assert.equal(context.get('cpslai3_exp_baseline'), null);
  assert.equal(context.get('cpslai3_exp_batch'), null);
  assert.equal(context.get('cpslai3_exp_quality'), 'COMMUNICATION_LOST');

  context.set('cpslai3_exp_baseline', { at: Date.now(), v: { B1BG1: true } });
  context.set('cpslai3_exp_batch', { id: 'pending-again' });
  runFunction('c3a0000000000025', { payload: { communication: { connected: true } } }, context);
  assert.equal(context.get('cpslai3_exp_baseline'), null);
  assert.equal(context.get('cpslai3_exp_batch'), null);
  assert.equal(context.get('cpslai3_exp_quality'), 'BASELINE_PENDING');
});

test('CPS1-style OEE contract stays NOT_COMPUTED until CPS-LAI-03 equivalents exist', () => {
  const result = calculateOee(new Map([
    ['cpslai3_exp_metrics', {
      pieceSensorActivationCount: 4,
      conveyorSignalActiveTimeMs: 0,
      separator1ActivationCount: 2,
      separator2ActivationCount: 0,
    }],
  ]));
  assert.equal(result.calculationState, 'NOT_COMPUTED');
  assert.deepEqual(result.oee, { current: null, availability: null, performance: null, quality: null });
  assert.equal(result.source, 'CPS_LAI_03_EXPERIMENTAL_OEE');
  assert.equal(result.experimentalEvidence.pieceSensorActivationCount, 4);
  assert.equal(result.experimentalEvidence.separator1ActivationCount, 2);
  assert.deepEqual(result.missingInputs, [
    'PLANNED_PRODUCTION_TIME_NOT_AVAILABLE',
    'VALIDATED_PRODUCTIVE_TIME_NOT_AVAILABLE',
    'COMPLETED_PIECE_COUNT_NOT_AVAILABLE',
    'GOOD_PIECE_COUNT_NOT_AVAILABLE',
    'IDEAL_CYCLE_TIME_NOT_CONFIGURED',
  ]);
  assert.equal(result.windowId, null);
});

test('OEE window follows the existing experimental session and retains its bounds', () => {
  const context = new Map();
  const started = startSession(context);
  const running = calculateOee(context);
  assert.equal(running.windowId, started.payload.metricSessionId);
  assert.equal(running.windowStartedAt, started.payload.startedAt);
  assert.equal(running.windowStatus, 'RUNNING');
  assert.equal(running.calculationState, 'NOT_COMPUTED');

  const stopped = runFunction('c3a0000000000022', { payload: Date.now() }, context);
  const ended = calculateOee(context);
  assert.equal(ended.windowId, started.payload.metricSessionId);
  assert.equal(ended.windowStartedAt, started.payload.startedAt);
  assert.equal(ended.windowEndedAt, stopped.payload.updatedAt);
  assert.equal(ended.windowStatus, 'STOPPED');
  assert.deepEqual(ended.oee, { current: null, availability: null, performance: null, quality: null });
});

test('manual OEE injection is removed; topic, context handling, and Experimental OEE UI remain', () => {
  assert.ok(flow.some((node) => node.type === 'mqtt out' && node.topic === 'cpslai3/oee'));
  assert.equal(flow.some((node) => ['c3a0000000000027', 'c3a0000000000028', 'c3a0000000000029'].includes(node.id)), false);
  assert.doesNotMatch(byId('c3a0000000000019').func, /cpslai3_exp_oee_window|cpslai3_exp_oee_parameters/);
  const contextSource = readFileSync(new URL('../context/CPSContext.js', import.meta.url), 'utf8');
  const playSource = readFileSync(new URL('../components/PlayFase.js', import.meta.url), 'utf8');
  assert.match(contextSource, /hasExplicitCpsLai3CalculationState/);
  assert.match(playSource, /Experimental OEE/);
  assert.match(playSource, /experimentalMetrics/);
});
