import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyzeHistory } from '../services/cps-lai-01-cognitive/temporalCognitiveAnalysis.js';
import { buildLevel1KnowledgePackage } from '../lib/ai/knowledgePackages.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const dashboard = read('components', 'CPSDashboard.js');
const context = read('context', 'CPSContext.js');

const startedAt = Date.parse('2026-10-15T12:00:00.000Z');
const oee = (index, value = 0.8) => ({
  cpsId: 'cpslai1',
  timestamp: new Date(startedAt + index * 60_000).toISOString(),
  calculationState: 'OPERATIONAL_OEE_PROXY',
  oee: { availability: 0.9, performance: value, quality: 0.95, current: 0.9 * value * 0.95 },
  production: { totalCount: index + 1, completedCycles: index + 1, lastCycleTimeMs: 3000 },
});

test('operational panel preserves the CPS-LAI-01 sensor and production contract without changing other CPS maps', () => {
  for (const field of [
    'PieceAtEntry', 'PieceAtMiddle', 'PieceAtExit', 'SlideRetracted', 'SlideExtended',
    'AlarmSignal', 'totalCount', 'completedCycles', 'incompleteCycles',
    'lastCycleTimeMs', 'averageCycleTimeMs',
  ]) {
    assert.match(context, new RegExp(`${field}: data\\?\\.`));
    assert.match(dashboard, new RegExp(`keys: \\['${field}'\\]`));
  }
  for (const otherCps of ['cps1:', 'cps5:', 'cps7:']) assert.match(dashboard, new RegExp(otherCps));
});

test('Learning and Reasoning UI consume the fields produced by the cognitive contract', () => {
  const result = analyzeHistory({
    status: { cpsId: 'cpslai1', timestamp: new Date(startedAt).toISOString(), operationalState: 'RUNNING' },
    data: { cpsId: 'cpslai1', timestamp: new Date(startedAt).toISOString(), AlarmSignal: false },
    oee: [0.9, 0.86, 0.82, 0.76, 0.7, 0.64].map((value, index) => oee(index, value)),
  });
  assert.ok(result.learning.state);
  assert.ok(result.learning.dominantPattern);
  assert.ok(result.learning.metrics.oee.trend);
  assert.ok(Array.isArray(result.reasoning.observations));
  assert.ok(Array.isArray(result.reasoning.inferences));
  assert.ok(Array.isArray(result.reasoning.hypotheses));
  assert.match(dashboard, /learning\.dominantPattern/);
  assert.match(dashboard, /learning\.metrics\.oee\.trend/);
  assert.match(dashboard, /label="Observations"/);
  assert.match(dashboard, /label="Inferences"/);
  assert.match(dashboard, /label="Hypotheses"/);
  assert.match(dashboard, /label="Evidence References"/);
});

test('unavailable prediction remains unavailable instead of becoming zero percent', () => {
  const result = analyzeHistory({ oee: [oee(0), oee(1)] });
  assert.equal(result.prediction.state, 'not_generated');
  assert.equal(result.prediction.expected, undefined);
  assert.match(dashboard, /value === null \|\| value === undefined \|\| value === ''/);
  assert.match(dashboard, /prediction\?\.expected\?\.oee/);
  assert.match(dashboard, /prediction\?\.historicalWindow \|\| analytics\?\.evidenceWindow/);
});

test('recommendation text remains distinct from an absent governable action', () => {
  const result = analyzeHistory({ oee: [oee(0), oee(1)] });
  assert.equal(typeof result.recommendation.text, 'string');
  assert.equal('governableAction' in result.recommendation, false);
  assert.match(dashboard, /source\?\.text/);
  assert.match(dashboard, /source\?\.recommendedAction/);
  assert.match(dashboard, /label: 'Requires Governance'/);
  assert.match(dashboard, /label: 'Execution'/);
});

test('Level 1 package forwards actual cognitive prediction and pattern to generative interpretation', () => {
  const packageValue = buildLevel1KnowledgePackage({
    cpsId: 'cpslai1',
    analytics: {
      learning: { dominantPattern: 'performance_degradation' },
      prediction: { expected: { oee: 0.63 } },
      recommendation: { text: 'Continue observation.' },
    },
  });
  assert.equal(packageValue.learningPattern, 'performance_degradation');
  assert.equal(packageValue.forecastOEE, 0.63);
});

test('HCM trace never substitutes episode status or close timestamp for feedback/effectiveness', () => {
  assert.match(dashboard, /eventType === 'feedback'/);
  assert.match(dashboard, /episode\?\.effectiveness/);
  assert.doesNotMatch(dashboard, /\['Feedback',[^\n]*episode\?\.status/);
  assert.doesNotMatch(dashboard, /\['Effectiveness',[^\n]*closedAt/);
  assert.match(dashboard, /'Not available'/);
});
