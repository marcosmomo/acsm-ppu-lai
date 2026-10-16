import {
  CPS_ID,
  MODEL_VERSION,
  OUTPUT_TOPIC,
  assertCognitiveEnvelope,
  copyMetadata,
  normalizeOeePayload,
  parseMqttPayload,
} from './contracts.js';

const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const round = (value, digits = 6) => Number(Number(value).toFixed(digits));
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const stddev = (values) => {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
};
const slope = (values) => {
  if (values.length < 2) return 0;
  const xMean = (values.length - 1) / 2;
  const yMean = mean(values);
  let numerator = 0;
  let denominator = 0;
  values.forEach((value, index) => {
    numerator += (index - xMean) * (value - yMean);
    denominator += (index - xMean) ** 2;
  });
  return denominator ? numerator / denominator : 0;
};
const metricNames = ['availability', 'performance', 'quality', 'oee'];
const metricSeries = (history, metric) => history.map((entry) => entry.metrics[metric]);
const lossName = (metrics) => ['availability', 'performance', 'quality']
  .map((metric) => ({ metric, loss: 1 - metrics[metric] }))
  .sort((a, b) => b.loss - a.loss)[0];

function summarizeMetric(values, baselineValues, recentValues) {
  const baseline = mean(baselineValues);
  const current = values.at(-1);
  const recent = mean(recentValues);
  const variation = current - baseline;
  const dispersion = stddev(values);
  const temporalSlope = slope(values);
  const driftScore = clamp(Math.abs(recent - baseline) / Math.max(dispersion * 3, 0.03));
  const anomalyReference = values.slice(0, -1).slice(-Math.max(2, recentValues.length));
  const anomalyMean = mean(anomalyReference);
  const anomalyScore = anomalyReference.length >= 2
    ? clamp(Math.abs(current - anomalyMean) / Math.max(stddev(anomalyReference) * 3, 0.03))
    : 0;
  return {
    baseline: round(baseline), current: round(current), recentMean: round(recent),
    variation: round(variation), dispersion: round(dispersion), trendSlope: round(temporalSlope),
    trend: temporalSlope < -0.002 ? 'decreasing' : temporalSlope > 0.002 ? 'increasing' : 'stable',
    driftScore: round(driftScore), anomalyScore: round(anomalyScore),
  };
}

function buildLearning(history, minimumSamples) {
  if (history.length < minimumSamples) {
    return {
      model: 'local-statistical-time-series', type: 'descriptive-diagnostic', state: 'insufficient_evidence',
      ready: false, sampleCount: history.length, minimumSamples, confidence: 0,
      metrics: {}, patterns: [], dominantPattern: null,
      observations: [`Only ${history.length} of ${minimumSamples} required OEE snapshots are available.`],
    };
  }
  const split = Math.max(2, Math.floor(history.length / 2));
  const baselineHistory = history.slice(0, split);
  const recentHistory = history.slice(-split);
  const metrics = Object.fromEntries(metricNames.map((metric) => [
    metric,
    summarizeMetric(metricSeries(history, metric), metricSeries(baselineHistory, metric), metricSeries(recentHistory, metric)),
  ]));
  const patterns = ['availability', 'performance', 'quality'].flatMap((metric) => {
    const item = metrics[metric];
    if (item.trend === 'decreasing' && item.variation <= -0.03) return [`${metric}_degradation`];
    if (item.driftScore >= 0.65) return [`${metric}_drift`];
    return [];
  });
  if (metrics.oee.trend === 'decreasing' && metrics.oee.variation <= -0.03) patterns.push('oee_degradation');
  const anomalyScore = Math.max(...metricNames.map((metric) => metrics[metric].anomalyScore));
  const driftScore = Math.max(...metricNames.map((metric) => metrics[metric].driftScore));
  const confidence = clamp(0.45 + Math.min(history.length, 20) / 40 - mean(metricNames.map((metric) => metrics[metric].dispersion)));
  return {
    model: 'local-statistical-time-series', type: 'descriptive-diagnostic', state: patterns.length ? 'degrading' : 'monitoring',
    ready: true, sampleCount: history.length, minimumSamples, confidence: round(confidence),
    metrics, patterns, dominantPattern: patterns[0] ?? 'stable_operation',
    driftScore: round(driftScore), anomalyScore: round(anomalyScore),
    observations: metricNames.map((metric) => `${metric}: current=${metrics[metric].current}, trend=${metrics[metric].trend}`),
  };
}

function ppuEvolution(history, ppuEvents) {
  const event = ppuEvents.at(-1);
  if (!event?.timestamp) return { state: 'not_evaluated', reason: 'no_ppu_event_in_evidence_window' };
  const eventTime = Date.parse(event.timestamp);
  const before = history.filter((item) => Date.parse(item.timestamp) < eventTime).slice(-5);
  const after = history.filter((item) => Date.parse(item.timestamp) >= eventTime).slice(0, 5);
  if (before.length < 2 || after.length < 2) return { state: 'insufficient_evidence', event: copyMetadata(event) };
  const beforeOee = mean(metricSeries(before, 'oee'));
  const afterOee = mean(metricSeries(after, 'oee'));
  return {
    state: 'evaluated', event: copyMetadata(event), beforeOee: round(beforeOee), afterOee: round(afterOee),
    change: round(afterOee - beforeOee), outcome: afterOee > beforeOee + 0.02 ? 'improved' : afterOee < beforeOee - 0.02 ? 'degraded' : 'stable',
  };
}

function buildPrediction(history, learning, horizonSamples) {
  if (!learning.ready) return { state: 'not_generated', reason: 'insufficient_historical_evidence', confidence: 0 };
  const prediction = {};
  for (const metric of metricNames) {
    const values = metricSeries(history, metric);
    prediction[metric] = round(clamp(values.at(-1) + slope(values) * horizonSamples));
  }
  const averageDispersion = mean(metricNames.map((metric) => learning.metrics[metric].dispersion));
  const confidence = clamp(learning.confidence * (1 - Math.min(averageDispersion * 2, 0.5)));
  return {
    state: 'generated', method: 'bounded-linear-trend', horizon: `next_${horizonSamples}_samples`,
    horizonSamples, confidence: round(confidence), expected: prediction,
    risk: prediction.oee < 0.5 || learning.anomalyScore >= 0.75 ? 'high' : prediction.oee < 0.7 || learning.driftScore >= 0.6 ? 'medium' : 'low',
  };
}

function buildReasoning({ history, learning, prediction, status, data, interventions, ppu }) {
  if (!learning.ready) {
    return {
      state: 'insufficient_evidence', dominantLoss: null, riskLevel: 'unknown',
      observations: learning.observations, inferences: [], hypotheses: [], evidence: [],
      ppuEvolution: ppu,
    };
  }
  const current = history.at(-1).metrics;
  const dominant = lossName(current);
  const alarm = data?.AlarmSignal === true || data?.evidence?.AlarmSignal?.value === true;
  const cycleTime = history.at(-1).cycleTimeMs;
  const operationalState = status?.operationalState ?? null;
  const operationMode = status?.operationMode ?? data?.operationMode ?? null;
  const observations = [
    `Dominant measured OEE component loss: ${dominant.metric} (${round(dominant.loss)}).`,
    `Operational state: ${operationalState ?? 'not_available'}.`,
    `Operation mode: ${operationMode ?? 'not_available'}.`,
    `AlarmSignal observed: ${alarm}.`,
    `Last cycle time: ${cycleTime ?? 'not_available'} ms.`,
    `Interventions in window: ${interventions.length}.`,
  ];
  const inferences = [];
  const hypotheses = [];
  if (dominant.metric === 'availability') {
    inferences.push('The main current contribution to OEE loss is reduced operating availability.');
    hypotheses.push(alarm ? 'Alarm recurrence may be associated with stopped time.' : 'Stops or inactive windows may explain the availability loss.');
  } else if (dominant.metric === 'performance') {
    inferences.push('The main current contribution to OEE loss is reduced execution rate.');
    hypotheses.push(cycleTime ? 'Increasing or unstable cycle time may contribute to the performance loss.' : 'Micro-stops or slower cycles may contribute to the performance loss.');
  } else {
    inferences.push('The main current contribution to OEE loss is the Quality indicator.');
    hypotheses.push('The origin and validation metadata of Quality must be checked before attributing a product-quality cause.');
  }
  const riskLevel = prediction.risk === 'high' || alarm ? 'high' : prediction.risk === 'medium' || learning.patterns.length ? 'medium' : 'low';
  return {
    state: 'available', model: 'evidence-separated-rule-reasoning', dominantLoss: dominant.metric,
    dominantLossValue: round(dominant.loss), riskLevel, observations, inferences, hypotheses,
    evidence: [history.at(-1).timestamp, ...learning.patterns], ppuEvolution: ppu,
    possibleConsequences: riskLevel === 'high'
      ? ['MaterialTransport interruption', 'Reduced CPS participation reliability', 'Possible lifecycle reassessment']
      : riskLevel === 'medium'
        ? ['Reduced MaterialTransport throughput', 'Potential participation instability']
        : ['No material participation consequence detected in the current window'],
  };
}

function buildRecommendation(reasoning, prediction) {
  if (reasoning.state !== 'available') {
    return { state: 'not_generated', category: 'continue_observation', text: 'Continue collecting physical operational evidence.', requiresGovernance: false };
  }
  if (reasoning.riskLevel === 'high') {
    return {
      state: 'generated', category: 'evaluate_maintenance_or_unplug',
      text: 'Investigate the dominant loss and evaluate maintenance; assess Unplug only if participation safety or reliability cannot be sustained.',
      lifecycleEvaluations: ['maintenance', 'unplug'], requiresGovernance: true, execution: 'not_authorized',
      evidence: reasoning.evidence,
    };
  }
  if (reasoning.riskLevel === 'medium') {
    return {
      state: 'generated', category: 'investigate_and_evaluate_maintenance',
      text: 'Continue controlled operation while investigating the dominant loss and evaluating maintenance or a later Return.',
      lifecycleEvaluations: ['maintenance', 'return'], requiresGovernance: true, execution: 'not_authorized',
      evidence: reasoning.evidence,
    };
  }
  return {
    state: 'generated', category: 'continue_operation', text: 'Maintain controlled operation and continue monitoring the evidence window.',
    lifecycleEvaluations: ['continue'], requiresGovernance: false, execution: 'not_applicable', evidence: reasoning.evidence,
    predictedOee: prediction.expected?.oee ?? null,
  };
}

class LegacyCognitiveAnalysis {
  constructor({ minimumSamples = 5, maxSamples = 120, horizonSamples = 3, now = () => new Date() } = {}) {
    this.minimumSamples = minimumSamples;
    this.maxSamples = maxSamples;
    this.horizonSamples = horizonSamples;
    this.now = now;
    this.oeeHistory = [];
    this.status = null;
    this.data = null;
    this.interventions = [];
    this.ppuEvents = [];
  }

  ingest(topic, input) {
    const payload = parseMqttPayload(input);
    if (String(payload.cpsId || '').toLowerCase() !== CPS_ID) throw new Error('Input payload must belong to cpslai1.');
    if (topic === 'cpslai1/oee') this.oeeHistory = [...this.oeeHistory, normalizeOeePayload(payload)].slice(-this.maxSamples);
    else if (topic === 'cpslai1/status') this.status = payload;
    else if (topic === 'cpslai1/data') this.data = payload;
    else if (topic === 'cpslai1/intervention') this.interventions = [...this.interventions, payload].slice(-this.maxSamples);
    else throw new Error(`Unsupported cognitive input topic: ${topic}`);
    return this.analyze();
  }

  ingestPpuEvent(event) {
    if (String(event?.cpsId || '').toLowerCase() !== CPS_ID) throw new Error('PPU event must belong to cpslai1.');
    this.ppuEvents = [...this.ppuEvents, copyMetadata(event)].slice(-this.maxSamples);
  }

  analyze() {
    const learning = buildLearning(this.oeeHistory, this.minimumSamples);
    const prediction = buildPrediction(this.oeeHistory, learning, this.horizonSamples);
    const evolution = ppuEvolution(this.oeeHistory, this.ppuEvents);
    const reasoning = buildReasoning({
      history: this.oeeHistory, learning, prediction, status: this.status, data: this.data,
      interventions: this.interventions, ppu: evolution,
    });
    const recommendation = buildRecommendation(reasoning, prediction);
    const first = this.oeeHistory[0];
    const last = this.oeeHistory.at(-1);
    return assertCognitiveEnvelope({
      schemaVersion: '1.0', cpsId: CPS_ID, timestamp: this.now().toISOString(), modelVersion: MODEL_VERSION,
      outputTopic: OUTPUT_TOPIC, learning, reasoning, prediction, recommendation,
      evidenceWindow: {
        from: first?.timestamp ?? null, to: last?.timestamp ?? null, sampleCount: this.oeeHistory.length,
        minimumSamples: this.minimumSamples, historicalWindowId: first && last ? `${first.timestamp}/${last.timestamp}` : null,
      },
      sourceMetadata: {
        source: 'cpslai1-local-cognitive-service', inputTopics: ['cpslai1/oee', 'cpslai1/status', 'cpslai1/data', 'cpslai1/intervention'],
        measurementPolicy: 'No input APQ/OEE value is modified or presented as a new physical measurement.',
        latestOeeProvenance: copyMetadata(last?.provenance ?? null),
        latestStatusMetadata: copyMetadata(this.status ? { timestamp: this.status.timestamp ?? null, evidenceStatus: this.status.evidenceStatus ?? null, operationalStateEvidence: this.status.operationalStateEvidence ?? null } : null),
        reliability: learning.ready ? { level: learning.confidence >= 0.75 ? 'high' : learning.confidence >= 0.5 ? 'medium' : 'low', confidence: learning.confidence } : { level: 'insufficient', confidence: 0 },
      },
      functionalImpact: {
        capability: 'MaterialTransport', participationRisk: reasoning.riskLevel,
        consequences: reasoning.possibleConsequences ?? [], operationalAuthority: 'advisory_only',
      },
    });
  }
}

function legacyAnalyzeHistory({ oee = [], status = null, data = null, interventions = [], ppuEvents = [] } = {}, options = {}) {
  const analysis = new CognitiveAnalysis(options);
  if (status) analysis.ingest('cpslai1/status', status);
  if (data) analysis.ingest('cpslai1/data', data);
  interventions.forEach((item) => analysis.ingest('cpslai1/intervention', item));
  ppuEvents.forEach((item) => analysis.ingestPpuEvent(item));
  oee.forEach((item) => analysis.ingest('cpslai1/oee', item));
  return analysis.analyze();
}

export { CognitiveAnalysis, SemanticHysteresis, analyzeHistory } from './temporalCognitiveAnalysis.js';
