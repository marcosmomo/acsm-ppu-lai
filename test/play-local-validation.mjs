import assert from 'node:assert/strict';

const baseUrl = process.env.PLAY_BASE_URL || 'http://localhost:3100';
const marker = { source: 'TEST_DATA', environment: 'LOCAL_FUNCTIONAL_VALIDATION' };
const cps = (extra = {}) => ({
  ...marker, id: 'cpslai1', displayName: 'CPS-LAI-01 – Distribution/Conveyor Station',
  lifecyclePhase: 'play', operationalState: 'running', ...extra,
});

const scenarios = [
  {
    name: 'NO_EVIDENCE',
    payload: { ...marker, acsmId: 'acsm1', totalCps: 1, cps: [cps()], historySize: 0, analytics: {} },
    verify: (body) => {
      assert.equal(body.activeCPS.count, 1);
      assert.equal(body.globalOEE.evidenceStatus, 'NO_DATA');
      assert.equal(body.systemHealth.state, 'UNKNOWN');
    },
  },
  {
    name: 'OEE_HEALTH',
    payload: {
      ...marker, acsmId: 'acsm1', totalCps: 1,
      cps: [cps({
        oee: { availability: 0.95, performance: 0.7, quality: 0.9 },
        health: { score: 0.92, label: 'healthy' },
      })],
      historySize: 1, analytics: {},
    },
    verify: (body) => {
      assert.equal(body.globalOEE.current, 0.5985);
      assert.equal(body.systemHealth.score, 0.92);
      assert.equal(body.reasoning.dominantLoss, 'PERFORMANCE');
    },
  },
  {
    name: 'SUFFICIENT_HISTORY',
    payload: {
      ...marker, acsmId: 'acsm1', totalCps: 1,
      cps: [cps({ oee: { availability: 0.96, performance: 0.72, quality: 0.94, current: 0.65 } })],
      historySize: 6,
      testHistory: [0.55, 0.57, 0.59, 0.61, 0.63, 0.65],
      analytics: {
        historySummary: { samples: 6 }, learningPattern: 'recovering_system',
        predictedSystemOEE: 0.67, confidence: 0.82,
        reasoning: { dominantLoss: 'performance', recommendation: 'Continue monitoring the validated recovery trend.' },
      },
    },
    verify: (body) => {
      assert.equal(body.learning.state, 'READY');
      assert.equal(body.prediction.predictedSystemOEE, 0.67);
      assert.equal(body.recommendation.state, 'AVAILABLE');
    },
  },
];

const post = async (payload) => {
  const response = await fetch(`${baseUrl}/api/acsm/play`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  assert.equal(response.status, 200);
  return response.json();
};

try {
  for (const scenario of scenarios) {
    const posted = await post(scenario.payload);
    scenario.verify(posted);
    const response = await fetch(`${baseUrl}/api/acsm/play`, { cache: 'no-store' });
    assert.equal(response.status, 200);
    const observed = await response.json();
    scenario.verify(observed);
    console.log(JSON.stringify({ scenario: scenario.name, testData: marker, postResponse: posted, getResponse: observed }, null, 2));
  }
} finally {
  const cleared = await post({ ...marker, cleanup: true, acsmId: 'acsm1', totalCps: 1, cps: [], historySize: 0, analytics: {} });
  assert.equal(cleared.activeCPS.count, 0);
  assert.equal(cleared.globalOEE.evidenceStatus, 'NO_DATA');
  console.log(JSON.stringify({ cleanup: 'TEST_DATA_REMOVED', getState: cleared }, null, 2));
}
