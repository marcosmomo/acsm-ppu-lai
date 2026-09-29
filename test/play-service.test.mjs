import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPlayState, DEFAULT_MINIMUM_HISTORY } from '../lib/acsm/playService.mjs';

const TEST_META = { source: 'TEST_DATA', environment: 'LOCAL_FUNCTIONAL_VALIDATION' };
const running = (extra = {}) => ({
  ...TEST_META, id: 'cpslai1', displayName: 'CPS-LAI-01 – Distribution/Conveyor Station',
  lifecyclePhase: 'play', operationalState: 'running', ...extra,
});
const snapshot = (extra = {}) => ({ ...TEST_META, cps: [running()], totalCps: 1, ...extra });

test('A: Play without OEE preserves missing evidence', () => {
  const result = buildPlayState(snapshot());
  assert.equal(result.activeCPS.count, 1);
  assert.equal(result.globalOEE.current, null);
  assert.equal(result.globalOEE.evidenceStatus, 'NO_DATA');
  assert.equal(result.criticalCPS, null);
  assert.equal(result.learning.state, 'NO_DATA');
  assert.equal(result.reasoning.state, 'INSUFFICIENT_DATA');
  assert.equal(result.prediction.state, 'INSUFFICIENT_HISTORY');
  assert.equal(result.recommendation.state, 'NO_RECOMMENDATION');
  assert.equal(result.interpretation.state, 'NO_EVIDENCE');
});

test('B: measured OEE equal to zero remains valid evidence', () => {
  const result = buildPlayState(snapshot({ cps: [running({
    oee: { current: 0, availability: 0, performance: 0, quality: 0 },
  })] }));
  assert.equal(result.globalOEE.current, 0);
  assert.equal(result.globalOEE.evidenceStatus, 'AVAILABLE');
});

test('C: valid component OEE is calculated and performance is dominant', () => {
  const result = buildPlayState(snapshot({
    cps: [running({ oee: { availability: 0.95, performance: 0.7, quality: 0.9 } })], historySize: 1,
  }));
  assert.deepEqual(result.globalOEE, {
    current: 0.5985, availability: 0.95, performance: 0.7, quality: 0.9, evidenceStatus: 'AVAILABLE',
  });
  assert.deepEqual(result.criticalCPS, { cpsId: 'cpslai1', oee: 0.5985, reason: 'PERFORMANCE' });
  assert.equal(result.reasoning.dominantLoss, 'PERFORMANCE');
});

test('D1: valid health evidence is preserved and classified from its real label', () => {
  const result = buildPlayState(snapshot({ cps: [running({ health: { score: 0.92, label: 'healthy' } })] }));
  assert.deepEqual(result.systemHealth, { state: 'HEALTHY', score: 0.92 });
});

test('D2: absent health stays unknown without an artificial score', () => {
  assert.deepEqual(buildPlayState(snapshot()).systemHealth, { state: 'UNKNOWN', score: null });
});

test('E1: Play plus running produces RUNNING', () => {
  assert.equal(buildPlayState(snapshot()).systemState, 'RUNNING');
});

test('E2: Play plus degraded produces DEGRADED', () => {
  assert.equal(buildPlayState(snapshot({ cps: [running({ operationalState: 'degraded' })] })).systemState, 'DEGRADED');
});

for (const historySize of [1, 3, 5]) {
  test(`F: historySize=${historySize} remains insufficient`, () => {
    const result = buildPlayState(snapshot({
      cps: [running({ oee: { value: 0.6 } })], historySize, analytics: { predictedSystemOEE: 0.7 },
    }));
    assert.equal(result.learning.state, 'INSUFFICIENT_HISTORY');
    assert.equal(result.learning.ready, false);
    assert.equal(result.prediction.state, 'INSUFFICIENT_HISTORY');
    assert.equal(result.prediction.predictedSystemOEE, null);
  });
}

test('G: six samples expose learning and forecast already produced by existing analytics', () => {
  const history = [0.55, 0.57, 0.59, 0.61, 0.63, 0.65];
  const result = buildPlayState(snapshot({
    cps: [running({ oee: { value: history.at(-1) } })], historySize: history.length,
    analytics: { historySummary: { samples: 6 }, learningPattern: 'recovering_system', predictedSystemOEE: 0.67 },
  }));
  assert.equal(DEFAULT_MINIMUM_HISTORY, 6);
  assert.deepEqual(result.learning, {
    state: 'READY', historySize: 6, minimumHistory: 6, ready: true, pattern: 'recovering_system',
  });
  assert.deepEqual(result.prediction, {
    predictedSystemOEE: 0.67, horizon: 'next_window', state: 'AVAILABLE',
  });
});

test('H: degrading analytics output is preserved with forecast and recommendation', () => {
  const history = [0.75, 0.73, 0.7, 0.67, 0.64, 0.6];
  const recommendation = 'Investigate the recent decline in system OEE.';
  const result = buildPlayState(snapshot({
    cps: [running({ oee: { value: history.at(-1), availability: 0.9, performance: 0.65, quality: 0.95 } })],
    historySize: history.length,
    analytics: {
      learningPattern: 'degrading_system', predictedSystemOEE: 0.57, confidence: 0.81,
      reasoning: { dominantLoss: 'performance', recommendation },
    },
  }));
  assert.equal(result.learning.pattern, 'degrading_system');
  assert.equal(result.prediction.predictedSystemOEE, 0.57);
  assert.equal(result.reasoning.dominantLoss, 'PERFORMANCE');
  assert.equal(result.recommendation.recommendation, recommendation);
});

for (const [expected, oee] of [
  ['AVAILABILITY', { availability: 0.6, performance: 0.9, quality: 0.95 }],
  ['PERFORMANCE', { availability: 0.95, performance: 0.6, quality: 0.9 }],
  ['QUALITY', { availability: 0.95, performance: 0.9, quality: 0.6 }],
]) {
  test(`I: dominant loss ${expected}`, () => {
    const result = buildPlayState(snapshot({ cps: [running({ oee })] }));
    assert.equal(result.reasoning.dominantLoss, expected);
    assert.equal(result.criticalCPS.reason, expected);
  });
}

test('J: recommendation remains descriptive and does not execute a governed action', () => {
  let executed = false;
  const result = buildPlayState(snapshot({
    cps: [running({ oee: { availability: 0.95, performance: 0.6, quality: 0.9 } })],
    analytics: { confidence: 0.8, reasoning: {
      recommendation: 'Review conveyor throughput.', governableAction: 'ADJUST_TRANSPORT_SPEED',
    } },
    executeAction: () => { executed = true; },
  }));
  assert.equal(result.recommendation.state, 'AVAILABLE');
  assert.equal(result.recommendation.governableAction, 'ADJUST_TRANSPORT_SPEED');
  assert.equal(result.recommendation.cpsId, 'cpslai1');
  assert.equal(executed, false);
});

test('K: interpretation distinguishes no evidence, insufficient history and available reasoning', () => {
  assert.equal(buildPlayState(snapshot()).interpretation.state, 'NO_EVIDENCE');
  const insufficient = buildPlayState(snapshot({
    cps: [running({ oee: { availability: 0.9, performance: 0.8, quality: 0.95 } })], historySize: 1,
  }));
  assert.equal(insufficient.interpretation.state, 'INSUFFICIENT_HISTORY');
  const available = buildPlayState(snapshot({
    cps: [running({ oee: { availability: 0.9, performance: 0.8, quality: 0.95 } })],
    historySize: 6, analytics: { learningPattern: 'stable_system' },
  }));
  assert.equal(available.interpretation.state, 'AVAILABLE');
  assert.match(available.interpretation.summary, /performance.*cpslai1/i);
});

test('L: CPS outside Play is excluded even when it contains OEE', () => {
  const result = buildPlayState(snapshot({
    cps: [running({ lifecyclePhase: 'stop', operationalState: 'stopped', oee: { value: 0.8 } })],
  }));
  assert.equal(result.activeCPS.count, 0);
  assert.equal(result.globalOEE.evidenceStatus, 'NO_DATA');
});

test('M: multiple Play CPS aggregate OEE and select the lowest OEE as critical', () => {
  const cps = [
    running({ id: 'cpslai1', oee: { value: 0.8 } }),
    running({ id: 'cpslai2', oee: { value: 0.6 } }),
    running({ id: 'cpslai3', oee: { value: 0.75 } }),
  ];
  const result = buildPlayState({ ...TEST_META, cps, totalCps: 3 });
  assert.equal(result.activeCPS.count, 3);
  assert.equal(result.globalOEE.current, 0.7167);
  assert.equal(result.criticalCPS.cpsId, 'cpslai2');
});

test('N: TEST_DATA metadata is input provenance, never physical evidence', () => {
  const input = snapshot();
  assert.equal(input.source, 'TEST_DATA');
  assert.equal(input.environment, 'LOCAL_FUNCTIONAL_VALIDATION');
  assert.equal(Object.hasOwn(buildPlayState(input), 'physicalEvidence'), false);
});
