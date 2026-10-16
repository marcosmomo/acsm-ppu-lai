import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { CognitiveAnalysis, SemanticHysteresis, analyzeHistory } from '../cognitiveAnalysis.js';
import {
  INPUT_TOPICS,
  MODEL_VERSION,
  OUTPUT_TOPIC,
  assertCognitiveEnvelope,
  normalizeOeePayload,
} from '../contracts.js';
import { loadConfig, PublicationController, semanticFingerprint, startService } from '../index.js';

const baseTime = Date.parse('2026-10-15T12:00:00.000Z');
const oee = (index, metrics = {}, metadata = {}) => ({
  schemaVersion: '1.0',
  cpsId: 'cpslai1',
  timestamp: new Date(baseTime + index * 60_000).toISOString(),
  calculationState: 'OPERATIONAL_OEE_PROXY',
  evidenceStatus: 'SENSOR_DERIVED_OPERATIONAL_OEE',
  source: 'NODE_RED_PHYSICAL_OPC_UA',
  oee: {
    availability: metrics.availability ?? 0.9,
    performance: metrics.performance ?? 0.9,
    quality: metrics.quality ?? 0.95,
    current: metrics.oee ?? (metrics.availability ?? 0.9) * (metrics.performance ?? 0.9) * (metrics.quality ?? 0.95),
  },
  production: { totalCount: index + 1, lastCycleTimeMs: metrics.cycleTimeMs ?? 2020 },
  reference: { cycleTimeMs: 2020, evidenceStatus: 'EXPERIMENTAL_REFERENCE_PROVISIONAL' },
  performance: { formula: 'referenceCycleTimeMs * totalCount / runTimeMs' },
  quality: { type: 'ASSUMED_CONFORMING_OUTPUT', productQualityValidated: false, evidenceStatus: 'NO_VALIDATED_REJECT_SIGNAL' },
  evidence: { countSourceTag: 'G1BG1', semanticStatus: { PieceAtExit: 'FIELD_VALIDATED' } },
  note: 'Original producer metadata must be preserved.',
  ...metadata,
});

const partialOee = (index) => oee(index, {}, {
  calculationState: 'PARTIAL', evidenceStatus: 'SENSOR_DERIVED_OPERATIONAL_OEE',
  oee: { availability: null, performance: null, quality: null, current: null },
});

const series = (values, metric) => values.map((value, index) => oee(index, {
  availability: metric === 'availability' ? value : 0.9,
  performance: metric === 'performance' ? value : 0.9,
  quality: metric === 'quality' ? value : 0.95,
  oee: metric === 'oee' ? value : undefined,
}));

const context = {
  status: { cpsId: 'cpslai1', timestamp: new Date(baseTime).toISOString(), operationalState: 'RUNNING', operationMode: 'AUTOMATIC', evidenceStatus: 'PHYSICALLY_VALIDATED_MODE' },
  data: { cpsId: 'cpslai1', timestamp: new Date(baseTime).toISOString(), AlarmSignal: false, operationMode: 'AUTOMATIC' },
};

test('stable physical OEE produces monitoring learning and operational continuity advice', () => {
  const result = analyzeHistory({ ...context, oee: series([0.9, 0.9, 0.901, 0.899, 0.9, 0.9], 'availability') });
  assert.equal(result.learning.state, 'monitoring');
  assert.equal(result.learning.metrics.availability.trend, 'stable');
  assert.equal(result.recommendation.category, 'continue_operation');
  assert.equal(result.functionalImpact.capability, 'MaterialTransport');
});

for (const metric of ['availability', 'performance', 'quality']) {
  test(`${metric} degradation is distinguished from the other APQ losses`, () => {
    const result = analyzeHistory({ ...context, oee: series([0.94, 0.92, 0.88, 0.82, 0.72, 0.6], metric) });
    assert.ok(result.learning.patterns.includes(`${metric}_degradation`));
    assert.equal(result.reasoning.dominantLoss, metric);
    assert.notEqual(result.reasoning.riskLevel, 'low');
  });
}

test('OEE decline is learned even when APQ decline remains distributed', () => {
  const values = [0.82, 0.8, 0.76, 0.7, 0.62, 0.52];
  const result = analyzeHistory({ ...context, oee: series(values, 'oee') });
  assert.ok(result.learning.patterns.includes('oee_degradation'));
  assert.equal(result.prediction.state, 'generated');
  assert.ok(result.prediction.expected.oee < values.at(-1));
});

test('a sharp last-point deviation is reported as an anomaly with separated reasoning evidence', () => {
  const result = analyzeHistory({
    status: { ...context.status, operationalState: 'STOPPED' },
    data: { ...context.data, AlarmSignal: true },
    interventions: [{ cpsId: 'cpslai1', timestamp: new Date(baseTime + 300_000).toISOString(), eventType: 'HUMAN_INTERVENTION_REQUIRED' }],
    oee: series([0.9, 0.9, 0.9, 0.9, 0.9, 0.2], 'availability'),
  });
  assert.ok(result.learning.anomalyScore >= 0.75);
  assert.equal(result.reasoning.riskLevel, 'high');
  assert.ok(result.evidence.observations.length > 0);
  assert.ok(result.reasoning.hypotheses.length > 0);
  assert.equal(result.recommendation.requiresGovernance, true);
  assert.equal(result.recommendation.execution, 'not_authorized');
});

test('prediction identifies its historical window, horizon and confidence', () => {
  const result = analyzeHistory({ ...context, oee: series([0.92, 0.9, 0.88, 0.86, 0.84, 0.82], 'performance') });
  assert.equal(result.prediction.horizon, 'next_5_minutes');
  assert.equal(result.prediction.horizonMs, 300000);
  assert.ok(result.prediction.confidence > 0);
  assert.match(result.evidenceWindow.historicalWindowId, /^2026-/);
  assert.equal(result.evidenceWindow.aggregatedSampleCount, 6);
  assert.equal(result.evidenceWindow.durationMs, 300000);
  assert.equal(result.evidenceWindow.medianIntervalMs, 60000);
});

test('insufficient evidence suppresses prediction and controlled recommendations', () => {
  const result = analyzeHistory({ ...context, oee: series([0.9, 0.88, 0.87], 'performance') });
  assert.equal(result.learning.state, 'insufficient_evidence');
  assert.equal(result.prediction.state, 'not_generated');
  assert.equal(result.recommendation.requiresGovernance, false);
});

test('performance after a PPU event is compared only when before and after evidence exists', () => {
  const input = series([0.6, 0.62, 0.65, 0.72, 0.75, 0.78], 'oee');
  const result = analyzeHistory({
    ...context,
    oee: input,
    ppuEvents: [{ cpsId: 'cpslai1', timestamp: new Date(baseTime + 180_000).toISOString(), eventType: 'RETURN_COMPLETED' }],
  });
  assert.equal(result.reasoning.ppuEvolution.state, 'evaluated');
  assert.equal(result.reasoning.ppuEvolution.outcome, 'improved');
  assert.ok(result.reasoning.ppuEvolution.change > 0);
});

test('producer provenance and validation metadata are preserved without mutation', () => {
  const payload = oee(1);
  const original = structuredClone(payload);
  const normalized = normalizeOeePayload(payload);
  assert.deepEqual(payload, original);
  assert.deepEqual(normalized.provenance.reference, original.reference);
  assert.deepEqual(normalized.provenance.performance, original.performance);
  assert.deepEqual(normalized.provenance.quality, original.quality);
  assert.deepEqual(normalized.provenance.evidence, original.evidence);
  const result = analyzeHistory({ ...context, oee: Array.from({ length: 5 }, (_, index) => oee(index)) });
  assert.deepEqual(result.sourceMetadata.latestOeeProvenance.quality, original.quality);
  assert.equal(result.sourceMetadata.measurementPolicy.includes('No input APQ/OEE value is modified'), true);
});

test('MQTT contract is compatible with the ACSM learning envelope and excludes physical commands', () => {
  const result = analyzeHistory({ ...context, oee: Array.from({ length: 5 }, (_, index) => oee(index)) });
  assert.equal(result.cpsId, 'cpslai1');
  assert.equal(result.modelVersion, MODEL_VERSION);
  assert.equal(result.outputTopic, OUTPUT_TOPIC);
  assert.ok(result.evidence);
  assert.equal(typeof result.reasoning.recommendation, 'string');
  assert.equal(typeof result.recommendation, 'object');
  assert.equal(assertCognitiveEnvelope(result), result);
  assert.deepEqual(INPUT_TOPICS, ['cpslai1/oee', 'cpslai1/status', 'cpslai1/data', 'cpslai1/intervention']);
  assert.doesNotMatch(JSON.stringify(result), /cpslai1\/cmd/i);
  assert.equal('governableAction' in result, false);
  assert.equal('governableAction' in result.recommendation, false);
});

test('service has no direct HCM persistence configuration or API', async () => {
  assert.equal('hcmBaseUrl' in loadConfig({ HCM_BASE_URL: 'forbidden' }), false);
  const source = await import('node:fs/promises').then((fs) => fs.readFile(new URL('../index.js', import.meta.url), 'utf8'));
  assert.doesNotMatch(source, /HCM_BASE_URL|\/episode\/open|\/knowledge|persistKnowledgeToHcm/);
});

test('publication controller deduplicates, rate-limits and immediately publishes semantic changes', () => {
  const base = analyzeHistory({ ...context, oee: Array.from({ length: 5 }, (_, index) => oee(index)) });
  const controller = new PublicationController({ minimumIntervalMs: 30000 });
  assert.equal(controller.shouldPublish(base, 0).publish, true);
  assert.equal(controller.shouldPublish(structuredClone(base), 60000).reason, 'semantic_duplicate');
  const changedValue = structuredClone(base); changedValue.sourceMetadata.latestIndicators.oee -= 0.01;
  assert.equal(controller.shouldPublish(changedValue, 10000).reason, 'minimum_interval');
  assert.equal(controller.shouldPublish(changedValue, 30000).publish, true);
  const changedMeaning = structuredClone(changedValue); changedMeaning.reasoning.riskLevel = 'medium';
  assert.equal(controller.shouldPublish(changedMeaning, 30001).reason, 'significant_change');
  assert.notEqual(semanticFingerprint(base), semanticFingerprint(changedMeaning));
});

test('hysteresis requires confirmation for non-critical semantic oscillation', () => {
  const stable = analyzeHistory({ ...context, oee: Array.from({ length: 5 }, (_, index) => oee(index)) });
  const degraded = structuredClone(stable); degraded.learning.state = 'degrading'; degraded.learning.patterns = ['performance_degradation']; degraded.learning.dominantPattern = 'performance_degradation'; degraded.reasoning.riskLevel = 'medium'; degraded.reasoning.dominantLoss = 'performance'; degraded.recommendation.category = 'investigate';
  const hysteresis = new SemanticHysteresis(2);
  hysteresis.apply(stable);
  assert.equal(hysteresis.apply(degraded).learning.state, 'monitoring');
  assert.equal(hysteresis.apply(degraded).learning.state, 'degrading');
});

test('counter reset starts a new evidence window and blocks prediction', () => {
  const analysis = new CognitiveAnalysis();
  for (let index = 0; index < 5; index += 1) analysis.ingest('cpslai1/oee', oee(index));
  const result = analysis.ingest('cpslai1/oee', oee(6, {}, { production: { totalCount: 1, lastCycleTimeMs: 2020 } }));
  assert.equal(result.evidenceWindow.rawSampleCount, 1);
  assert.equal(result.prediction.state, 'not_generated');
  assert.equal(result.evidence.resetEvents.at(-1).reason, 'totalCount_reset');
  assert.equal(result.evidence.partialAvailability.validSegmentCount, 2);
});

test('temporal gaps make evidence inconsistent and suppress prediction', () => {
  const samples = Array.from({ length: 5 }, (_, index) => oee(index));
  samples.push({ ...oee(20), production: { totalCount: 21, lastCycleTimeMs: 2020 } });
  const result = analyzeHistory({ ...context, oee: samples });
  assert.ok(result.evidenceWindow.gapCount > 0);
  assert.equal(result.prediction.state, 'not_generated');
});

test('isolated PARTIAL is accepted as unavailable indicators without numeric inference', () => {
  const analysis = new CognitiveAnalysis();
  analysis.ingest('cpslai1/status', { ...context.status, operationalState: 'RUNNING' });
  const result = analysis.ingest('cpslai1/oee', partialOee(0));
  assert.equal(result.learning.state, 'data_unavailable');
  assert.equal(result.reasoning.state, 'data_unavailable');
  assert.equal(result.reasoning.physicalOperationalState, 'RUNNING');
  assert.equal(result.prediction.state, 'not_generated');
  assert.equal(result.recommendation.requiresGovernance, false);
  assert.deepEqual(result.sourceMetadata.latestIndicators, { availability: null, performance: null, quality: null, oee: null });
  assert.deepEqual(result.sourceMetadata.latestOeeProvenance, { calculationState: 'PARTIAL', evidenceStatus: 'SENSOR_DERIVED_OPERATIONAL_OEE', source: 'NODE_RED_PHYSICAL_OPC_UA', reference: oee(0).reference, performance: oee(0).performance, quality: oee(0).quality, evidence: oee(0).evidence, note: 'Original producer metadata must be preserved.', originalTimestamp: new Date(baseTime).toISOString() });
});

test('prolonged PARTIAL records are counted in a dated period and keep predictions blocked', () => {
  const analysis = new CognitiveAnalysis();
  let result;
  for (let index = 0; index < 4; index += 1) result = analysis.ingest('cpslai1/oee', partialOee(index));
  assert.equal(result.evidence.partialAvailability.recordCount, 4);
  assert.equal(result.evidence.partialAvailability.periodCount, 1);
  assert.equal(result.evidence.partialAvailability.periods[0].durationMs, 180000);
  assert.equal(result.evidence.partialAvailability.periods[0].medianIntervalMs, 60000);
  assert.equal(result.evidence.partialAvailability.periods[0].gapCount, 0);
  assert.equal(result.prediction.state, 'not_generated');
  assert.equal(result.recommendation.category, 'continue_observation');
});

test('large gaps split PARTIAL periods and remain unavailable to prediction', () => {
  const analysis = new CognitiveAnalysis();
  analysis.ingest('cpslai1/oee', partialOee(0));
  analysis.ingest('cpslai1/oee', partialOee(1));
  const result = analysis.ingest('cpslai1/oee', partialOee(100));
  assert.equal(result.evidence.partialAvailability.periodCount, 2);
  assert.equal(result.evidence.partialAvailability.unavailableGaps.length, 1);
  assert.ok(result.evidence.partialAvailability.unavailableGaps[0].durationMs > 60 * 60 * 1000);
  assert.equal(result.prediction.state, 'not_generated');
});

test('return from PARTIAL starts a fresh valid segment and cannot reuse the prior window', () => {
  const analysis = new CognitiveAnalysis();
  for (let index = 0; index < 6; index += 1) analysis.ingest('cpslai1/oee', oee(index));
  analysis.ingest('cpslai1/oee', partialOee(6));
  const returned = analysis.ingest('cpslai1/oee', oee(7));
  assert.equal(returned.learning.state, 'insufficient_evidence');
  assert.equal(returned.learning.sampleCount, 1);
  assert.equal(returned.prediction.state, 'not_generated');
  assert.equal(returned.evidence.partialAvailability.validSegmentCount, 2);
  assert.equal(returned.evidence.partialAvailability.periodCount, 1);
  assert.ok(returned.evidence.resetEvents.some((event) => event.reason === 'partial_indicators_ended_new_segment'));
});

test('PARTIAL never creates maintenance or unplug recommendations from null indicators', () => {
  const analysis = new CognitiveAnalysis();
  const result = analysis.ingest('cpslai1/oee', partialOee(0));
  assert.equal(result.learning.ready, false);
  assert.equal(result.reasoning.dominantLoss, null);
  assert.equal(result.recommendation.state, 'not_generated');
  assert.deepEqual(result.recommendation.lifecycleEvaluations, undefined);
  assert.equal(result.recommendation.requiresGovernance, false);
});

test('service is disabled by default and active runtime only subscribes to read topics and publishes learning', async () => {
  assert.equal(loadConfig({}).enabled, false);
  await assert.rejects(() => startService({ ...loadConfig({}), enabled: false }), /disabled/);

  class FakeClient extends EventEmitter {
    subscriptions = [];
    publications = [];
    subscribe(topics) { this.subscriptions.push(...topics); }
    publish(topic, payload, options) { this.publications.push({ topic, payload: JSON.parse(payload), options }); }
    end(_force, _options, callback) { callback(); }
  }
  const client = new FakeClient();
  const config = {
    ...loadConfig({ CPSLAI1_COGNITIVE_ENABLED: 'true' }), enabled: true,
    historyBaseUrl: '', minimumSamples: 5, maxSamples: 20, bucketMs: 60000, horizonMs: 300000, publicationIntervalMs: 30000,
  };
  const stop = await startService(config, { mqttConnect: () => client, analysis: new CognitiveAnalysis(config) });
  client.emit('connect');
  assert.deepEqual(client.subscriptions, INPUT_TOPICS);
  client.emit('message', 'cpslai1/status', Buffer.from(JSON.stringify(context.status)));
  client.emit('message', 'cpslai1/data', Buffer.from(JSON.stringify(context.data)));
  for (let index = 0; index < 6; index += 1) client.emit('message', 'cpslai1/oee', Buffer.from(JSON.stringify(oee(index))));
  client.emit('message', 'cpslai1/oee', Buffer.from(JSON.stringify(partialOee(6))));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.publications.length, 3);
  assert.equal(client.publications[0].payload.learning.state, 'insufficient_evidence');
  assert.equal(client.publications[1].payload.learning.state, 'monitoring');
  assert.equal(client.publications[2].payload.learning.state, 'data_unavailable');
  assert.equal(client.publications[2].payload.prediction.state, 'not_generated');
  assert.equal(client.publications[2].payload.recommendation.requiresGovernance, false);
  assert.ok(client.publications.every((item) => item.topic === OUTPUT_TOPIC));
  assert.ok(client.publications.every((item) => item.options.retain === false));
  assert.ok(client.publications.every((item) => !item.topic.includes('/cmd')));
  await stop();
});

test('invalid CPS, unsupported topics and invalid APQ fractions are rejected', () => {
  const analysis = new CognitiveAnalysis();
  assert.throws(() => analysis.ingest('cpslai1/oee', { ...oee(0), cpsId: 'cpslai2' }), /cpslai1/);
  assert.throws(() => analysis.ingest('cpslai1/cmd', oee(0)), /Unsupported/);
  assert.throws(() => normalizeOeePayload(oee(0, { quality: 100 })), /fractions/);
});
