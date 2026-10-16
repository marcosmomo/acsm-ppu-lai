import { CPS_ID, MODEL_VERSION, OUTPUT_TOPIC, assertCognitiveEnvelope, copyMetadata, normalizeOeePayload, parseMqttPayload } from './contracts.js';

const metrics = ['availability', 'performance', 'quality', 'oee'];
const clamp = (n, min = 0, max = 1) => Math.max(min, Math.min(max, n));
const round = (n, digits = 6) => Number(Number(n).toFixed(digits));
const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s[Math.floor((s.length - 1) / 2)] + s[Math.ceil((s.length - 1) / 2)]) / 2 : null; };
const deviation = (xs) => xs.length < 2 ? 0 : Math.sqrt(mean(xs.map((x) => (x - mean(xs)) ** 2)));
const slopePerSecond = (samples, metric) => {
  if (samples.length < 2) return 0;
  const origin = samples[0].timestampMs;
  const xs = samples.map((x) => (x.timestampMs - origin) / 1000);
  const ys = samples.map((x) => x.metrics[metric]);
  const xm = mean(xs); const ym = mean(ys);
  const denominator = xs.reduce((sum, x) => sum + (x - xm) ** 2, 0);
  return denominator ? xs.reduce((sum, x, i) => sum + (x - xm) * (ys[i] - ym), 0) / denominator : 0;
};

function aggregate(raw, bucketMs) {
  const buckets = new Map();
  for (const sample of raw) {
    const key = Math.floor(sample.timestampMs / bucketMs) * bucketMs;
    const values = buckets.get(key) || [];
    values.push(sample); buckets.set(key, values);
  }
  return [...buckets.entries()].sort(([a], [b]) => a - b).map(([start, values]) => {
    const last = values.at(-1);
    return {
      timestamp: new Date(start + bucketMs).toISOString(), timestampMs: start + bucketMs,
      metrics: Object.fromEntries(metrics.map((name) => [name, mean(values.map((x) => x.metrics[name]))])),
      cycleTimeMs: mean(values.map((x) => x.cycleTimeMs).filter(Number.isFinite)),
      provenance: last.provenance, sourceCount: values.length,
    };
  });
}

function temporalWindow(raw, aggregated, bucketMs, maxGapMultiplier) {
  const intervals = raw.slice(1).map((x, i) => x.timestampMs - raw[i].timestampMs);
  const medianIntervalMs = median(intervals);
  const gapThresholdMs = medianIntervalMs === null ? null : Math.max(bucketMs, medianIntervalMs * maxGapMultiplier);
  const gaps = intervals.filter((x) => gapThresholdMs !== null && x > gapThresholdMs);
  return {
    from: raw[0]?.timestamp ?? null, to: raw.at(-1)?.timestamp ?? null,
    durationMs: raw.length > 1 ? raw.at(-1).timestampMs - raw[0].timestampMs : 0,
    rawSampleCount: raw.length, aggregatedSampleCount: aggregated.length, bucketMs,
    medianIntervalMs, gapThresholdMs, gapCount: gaps.length, largestGapMs: intervals.length ? Math.max(...intervals) : 0,
    consistent: gaps.length === 0,
  };
}

function summarize(samples, name) {
  const values = samples.map((x) => x.metrics[name]);
  const half = Math.max(2, Math.floor(values.length / 2));
  const baseline = mean(values.slice(0, half)); const current = values.at(-1); const recent = mean(values.slice(-half));
  const dispersion = deviation(values); const trendSlopePerSecond = slopePerSecond(samples, name);
  const reference = values.slice(0, -1).slice(-half);
  const anomalyScore = reference.length >= 2 ? clamp(Math.abs(current - mean(reference)) / Math.max(deviation(reference) * 3, 0.03)) : 0;
  return { baseline: round(baseline), current: round(current), recentMean: round(recent), variation: round(current - baseline), dispersion: round(dispersion), trendSlopePerSecond: round(trendSlopePerSecond, 9), trend: trendSlopePerSecond < -0.000033 ? 'decreasing' : trendSlopePerSecond > 0.000033 ? 'increasing' : 'stable', driftScore: round(clamp(Math.abs(recent - baseline) / Math.max(dispersion * 3, 0.03))), anomalyScore: round(anomalyScore) };
}

function learningFor(samples, window, minimumSamples) {
  const enoughDuration = window.durationMs >= (minimumSamples - 1) * window.bucketMs;
  if (samples.length < minimumSamples || !enoughDuration || !window.consistent) return { model: 'time-bucketed-statistical-series', state: 'insufficient_evidence', ready: false, sampleCount: samples.length, minimumSamples, confidence: 0, metrics: {}, patterns: [], dominantPattern: null, observations: ['Insufficient or inconsistent real-time evidence window.'] };
  const summaries = Object.fromEntries(metrics.map((name) => [name, summarize(samples, name)]));
  const patterns = ['availability', 'performance', 'quality'].flatMap((name) => summaries[name].trend === 'decreasing' && summaries[name].variation <= -0.03 ? [`${name}_degradation`] : summaries[name].driftScore >= 0.65 ? [`${name}_drift`] : []);
  if (summaries.oee.trend === 'decreasing' && summaries.oee.variation <= -0.03) patterns.push('oee_degradation');
  const anomalyScore = Math.max(...metrics.map((name) => summaries[name].anomalyScore));
  const driftScore = Math.max(...metrics.map((name) => summaries[name].driftScore));
  const confidence = clamp(0.45 + Math.min(samples.length, 20) / 40 - mean(metrics.map((name) => summaries[name].dispersion)));
  return { model: 'time-bucketed-statistical-series', state: patterns.length ? 'degrading' : 'monitoring', ready: true, sampleCount: samples.length, minimumSamples, confidence: round(confidence), metrics: summaries, patterns, dominantPattern: patterns[0] ?? 'stable_operation', driftScore: round(driftScore), anomalyScore: round(anomalyScore), observations: metrics.map((name) => `${name}: current=${summaries[name].current}, trend=${summaries[name].trend}`) };
}

function unavailableLearning(partialStats, minimumSamples) {
  return {
    model: 'time-bucketed-statistical-series', state: 'data_unavailable', ready: false,
    sampleCount: 0, minimumSamples, confidence: 0, metrics: {}, patterns: [], dominantPattern: null,
    dataAvailability: 'indicators_unavailable', partialRecordCount: partialStats.recordCount,
    observations: ['OEE indicators are unavailable in PARTIAL records; no numeric learning was performed.'],
  };
}

function predictionFor(samples, learning, window, horizonMs) {
  if (!learning.ready || !window.consistent) return { state: 'not_generated', reason: !window.consistent ? 'inconsistent_temporal_evidence' : 'insufficient_historical_evidence', horizon: 'next_5_minutes', horizonMs, confidence: 0 };
  const seconds = horizonMs / 1000;
  const expected = Object.fromEntries(metrics.map((name) => [name, round(clamp(samples.at(-1).metrics[name] + slopePerSecond(samples, name) * seconds))]));
  const confidence = clamp(learning.confidence * (1 - Math.min(mean(metrics.map((name) => learning.metrics[name].dispersion)) * 2, 0.5)));
  return { state: 'generated', method: 'bounded-linear-time-trend', horizon: `next_${Math.round(horizonMs / 60000)}_minutes`, horizonMs, historicalWindow: copyMetadata(window), confidence: round(confidence), expected, risk: expected.oee < 0.5 || learning.anomalyScore >= 0.75 ? 'high' : expected.oee < 0.7 || learning.driftScore >= 0.6 ? 'medium' : 'low' };
}

function ppuEvolution(samples, events) {
  const event = events.at(-1); if (!event?.timestamp) return { state: 'not_evaluated', reason: 'no_ppu_event_in_evidence_window' };
  const at = Date.parse(event.timestamp); const before = samples.filter((x) => x.timestampMs < at).slice(-5); const after = samples.filter((x) => x.timestampMs >= at).slice(0, 5);
  if (before.length < 2 || after.length < 2) return { state: 'insufficient_evidence', event: copyMetadata(event) };
  const beforeOee = mean(before.map((x) => x.metrics.oee)); const afterOee = mean(after.map((x) => x.metrics.oee));
  return { state: 'evaluated', event: copyMetadata(event), beforeOee: round(beforeOee), afterOee: round(afterOee), change: round(afterOee - beforeOee), outcome: afterOee > beforeOee + 0.02 ? 'improved' : afterOee < beforeOee - 0.02 ? 'degraded' : 'stable' };
}

function recommendationFor(risk, evidence) {
  if (risk === 'unknown') return { state: 'not_generated', category: 'continue_observation', text: 'Continue collecting physical operational evidence.', requiresGovernance: false };
  if (risk === 'high') return { state: 'generated', category: 'evaluate_maintenance_or_unplug', text: 'Investigate the dominant loss and evaluate maintenance; assess Unplug only if participation safety or reliability cannot be sustained.', lifecycleEvaluations: ['maintenance', 'unplug'], requiresGovernance: true, execution: 'not_authorized', evidence };
  if (risk === 'medium') return { state: 'generated', category: 'investigate_and_evaluate_maintenance', text: 'Continue controlled operation while investigating the dominant loss and evaluating maintenance or a later Return.', lifecycleEvaluations: ['maintenance', 'return'], requiresGovernance: true, execution: 'not_authorized', evidence };
  return { state: 'generated', category: 'continue_operation', text: 'Maintain controlled operation and continue monitoring the evidence window.', lifecycleEvaluations: ['continue'], requiresGovernance: false, execution: 'not_applicable', evidence };
}

export class SemanticHysteresis {
  constructor(confirmations = 2) { this.confirmations = confirmations; this.stable = null; this.pending = null; this.pendingCount = 0; }
  apply(candidate) {
    const signature = JSON.stringify([candidate.learning.state, candidate.learning.dominantPattern, candidate.reasoning.riskLevel, candidate.reasoning.dominantLoss, candidate.recommendation.category]);
    if (!this.stable) { this.stable = structuredClone(candidate); return candidate; }
    const stableSignature = JSON.stringify([this.stable.learning.state, this.stable.learning.dominantPattern, this.stable.reasoning.riskLevel, this.stable.reasoning.dominantLoss, this.stable.recommendation.category]);
    if (signature === stableSignature) { this.stable = structuredClone(candidate); this.pending = null; this.pendingCount = 0; return candidate; }
    const immediate = candidate.reasoning.riskLevel === 'high' || candidate.learning.anomalyScore >= 0.85;
    if (immediate) { this.stable = structuredClone(candidate); this.pending = null; this.pendingCount = 0; return candidate; }
    if (signature === this.pending) this.pendingCount += 1; else { this.pending = signature; this.pendingCount = 1; }
    if (this.pendingCount >= this.confirmations) { this.stable = structuredClone(candidate); this.pending = null; this.pendingCount = 0; return candidate; }
    const held = structuredClone(candidate);
    held.learning.state = this.stable.learning.state; held.learning.dominantPattern = this.stable.learning.dominantPattern; held.learning.patterns = copyMetadata(this.stable.learning.patterns);
    held.reasoning.riskLevel = this.stable.reasoning.riskLevel; held.reasoning.dominantLoss = this.stable.reasoning.dominantLoss;
    held.recommendation = copyMetadata(this.stable.recommendation); held.reasoning.recommendation = held.recommendation.text;
    held.hysteresis = { held: true, requiredConfirmations: this.confirmations, observedConfirmations: this.pendingCount };
    return held;
  }
}

export class CognitiveAnalysis {
  constructor({ minimumSamples = 5, maxSamples = 30, bucketMs = 60000, horizonMs = 300000, maxGapMultiplier = 3, hysteresisConfirmations = 2, now = () => new Date() } = {}) {
    Object.assign(this, { minimumSamples, maxSamples, bucketMs, horizonMs, maxGapMultiplier, now }); this.raw = []; this.status = null; this.data = null; this.interventions = []; this.ppuEvents = []; this.resetEvents = []; this.hysteresisConfirmations = hysteresisConfirmations; this.hysteresis = new SemanticHysteresis(hysteresisConfirmations); this.indicatorsUnavailable = false; this.partialRecordCount = 0; this.partialPeriods = []; this.partialUnavailableGaps = []; this.openPartialPeriod = null; this.validSegments = []; this.openValidSegment = null; this.segmentHasSamples = false; this.latestPartialProvenance = null;
  }
  closeValidSegment(endedAt) {
    if (!this.openValidSegment) return;
    this.validSegments.push({ ...this.openValidSegment, endedAt, durationMs: Date.parse(endedAt) - Date.parse(this.openValidSegment.startedAt) });
    this.openValidSegment = null;
  }
  resetReason(previous, current) {
    if (current.timestampMs <= previous.timestampMs) return 'non_monotonic_timestamp';
    if (previous.sessionKey && current.sessionKey && previous.sessionKey !== current.sessionKey) return 'session_changed';
    for (const key of Object.keys(current.counters)) if (previous.counters[key] !== null && current.counters[key] !== null && current.counters[key] < previous.counters[key]) return `${key}_reset`;
    return null;
  }
  ingest(topic, input) {
    const payload = parseMqttPayload(input); if (String(payload.cpsId || '').toLowerCase() !== CPS_ID) throw new Error('Input payload must belong to cpslai1.');
    if (topic === 'cpslai1/oee') {
      const sample = normalizeOeePayload(payload);
      if (sample.indicatorsUnavailable) {
        this.partialRecordCount += 1;
        this.latestPartialProvenance = copyMetadata(sample.provenance);
        if (!this.openPartialPeriod) {
          this.openPartialPeriod = { startedAt: sample.timestamp, lastAt: sample.timestamp, recordCount: 0, intervalsMs: [], recentIntervalsMs: [] };
          this.closeValidSegment(this.raw.at(-1)?.timestamp ?? sample.timestamp);
          this.raw = []; this.segmentHasSamples = false;
          this.resetEvents.push({ timestamp: sample.timestamp, reason: 'partial_indicators_started' });
          this.hysteresis = new SemanticHysteresis(this.hysteresisConfirmations);
        }
        const intervalMs = sample.timestampMs - Date.parse(this.openPartialPeriod.lastAt);
        const usualIntervalMs = median(this.openPartialPeriod.recentIntervalsMs);
        const gapThresholdMs = Math.max(this.bucketMs, (usualIntervalMs ?? this.bucketMs / this.maxGapMultiplier) * this.maxGapMultiplier);
        if (intervalMs > gapThresholdMs) {
          this.partialUnavailableGaps.push({ from: this.openPartialPeriod.lastAt, to: sample.timestamp, durationMs: intervalMs, thresholdMs: gapThresholdMs });
          this.partialPeriods.push({ ...this.openPartialPeriod });
          this.openPartialPeriod = { startedAt: sample.timestamp, lastAt: sample.timestamp, recordCount: 0, intervalsMs: [], recentIntervalsMs: [] };
        } else if (intervalMs > 0) {
          this.openPartialPeriod.intervalsMs.push(intervalMs);
          this.openPartialPeriod.recentIntervalsMs.push(intervalMs);
          this.openPartialPeriod.recentIntervalsMs = this.openPartialPeriod.recentIntervalsMs.slice(-30);
        }
        this.openPartialPeriod.lastAt = sample.timestamp; this.openPartialPeriod.recordCount += 1;
        this.indicatorsUnavailable = true;
        return this.analyze();
      }
      if (this.openPartialPeriod) {
        this.partialPeriods.push({ ...this.openPartialPeriod, endedAt: this.openPartialPeriod.lastAt, durationMs: Date.parse(this.openPartialPeriod.lastAt) - Date.parse(this.openPartialPeriod.startedAt) });
        this.openPartialPeriod = null;
        this.resetEvents.push({ timestamp: sample.timestamp, reason: 'partial_indicators_ended_new_segment' });
        this.raw = []; this.segmentHasSamples = false;
        this.hysteresis = new SemanticHysteresis(this.hysteresisConfirmations);
      }
      this.indicatorsUnavailable = false;
      this.latestPartialProvenance = null;
      const previous = this.raw.at(-1); const reason = previous && this.resetReason(previous, sample);
      if (reason) { this.closeValidSegment(previous.timestamp); this.resetEvents.push({ timestamp: sample.timestamp, reason }); this.raw = []; this.segmentHasSamples = false; this.hysteresis = new SemanticHysteresis(this.hysteresisConfirmations); }
      if (!this.segmentHasSamples) { this.openValidSegment = { startedAt: sample.timestamp, recordCount: 0 }; this.segmentHasSamples = true; }
      this.openValidSegment.recordCount += 1;
      this.raw.push(sample); const cutoff = sample.timestampMs - this.maxSamples * this.bucketMs; this.raw = this.raw.filter((x) => x.timestampMs >= cutoff);
    } else if (topic === 'cpslai1/status') this.status = payload;
    else if (topic === 'cpslai1/data') this.data = payload;
    else if (topic === 'cpslai1/intervention') this.interventions = [...this.interventions, payload].slice(-this.maxSamples);
    else throw new Error(`Unsupported cognitive input topic: ${topic}`);
    return this.analyze();
  }
  ingestPpuEvent(event) { if (String(event?.cpsId || '').toLowerCase() !== CPS_ID) throw new Error('PPU event must belong to cpslai1.'); this.ppuEvents = [...this.ppuEvents, copyMetadata(event)].slice(-this.maxSamples); }
  analyze() {
    const samples = aggregate(this.raw, this.bucketMs); const window = temporalWindow(this.raw, samples, this.bucketMs, this.maxGapMultiplier);
    const summarizePartial = (period, open = false) => {
      const intervals = period.intervalsMs || []; const medianIntervalMs = median(intervals); const gapThresholdMs = medianIntervalMs === null ? null : Math.max(this.bucketMs, medianIntervalMs * this.maxGapMultiplier);
      return { startedAt: period.startedAt, lastAt: period.lastAt, endedAt: open ? null : period.lastAt, recordCount: period.recordCount, durationMs: Date.parse(period.lastAt) - Date.parse(period.startedAt), medianIntervalMs, largestIntervalMs: intervals.length ? Math.max(...intervals) : 0, gapThresholdMs, gapCount: gapThresholdMs === null ? 0 : intervals.filter((value) => value > gapThresholdMs).length };
    };
    const partialStats = { recordCount: this.partialRecordCount, periodCount: this.partialPeriods.length + (this.openPartialPeriod ? 1 : 0), periods: [...this.partialPeriods.map((period) => summarizePartial(period)), ...(this.openPartialPeriod ? [summarizePartial(this.openPartialPeriod, true)] : [])], unavailableGaps: copyMetadata(this.partialUnavailableGaps), validSegmentCount: this.validSegments.length + (this.openValidSegment ? 1 : 0), validSegments: [...this.validSegments, ...(this.openValidSegment ? [{ ...this.openValidSegment, endedAt: this.raw.at(-1)?.timestamp ?? null, durationMs: this.raw.length ? Date.parse(this.raw.at(-1).timestamp) - Date.parse(this.openValidSegment.startedAt) : 0 }] : [])] };
    const learning = this.indicatorsUnavailable ? unavailableLearning(partialStats, this.minimumSamples) : learningFor(samples, window, this.minimumSamples); const prediction = predictionFor(samples, learning, window, this.horizonMs);
    const current = samples.at(-1)?.metrics; const dominantLoss = learning.ready && current ? ['availability', 'performance', 'quality'].sort((a, b) => current[a] - current[b])[0] : null;
    const alarm = this.data?.AlarmSignal === true || this.data?.evidence?.AlarmSignal?.value === true;
    const riskLevel = !learning.ready ? 'unknown' : prediction.risk === 'high' || alarm ? 'high' : prediction.risk === 'medium' || learning.patterns.length ? 'medium' : 'low';
    const evidenceRefs = [samples.at(-1)?.timestamp, ...learning.patterns].filter(Boolean); const recommendation = recommendationFor(riskLevel, evidenceRefs);
    const reasoning = { state: this.indicatorsUnavailable ? 'data_unavailable' : learning.ready ? 'available' : 'insufficient_evidence', dataAvailability: this.indicatorsUnavailable ? 'oee_indicators_unavailable' : 'available_or_not_yet_sufficient', physicalOperationalState: this.status?.operationalState ?? null, model: 'evidence-separated-rule-reasoning', dominantLoss, riskLevel, observations: learning.observations, inferences: learning.ready ? [`The dominant measured OEE loss is ${dominantLoss}.`] : [], hypotheses: learning.ready ? ['Operational causes require correlation with states, alarms, cycle times and interventions.'] : [], evidence: evidenceRefs, recommendation: recommendation.text, ppuEvolution: ppuEvolution(samples, this.ppuEvents), possibleConsequences: riskLevel === 'high' ? ['MaterialTransport interruption', 'Reduced CPS participation reliability'] : riskLevel === 'medium' ? ['Reduced MaterialTransport throughput', 'Potential participation instability'] : [] };
    const last = this.raw.at(-1);
    const candidate = { schemaVersion: '1.1', cpsId: CPS_ID, timestamp: this.now().toISOString(), modelVersion: MODEL_VERSION, outputTopic: OUTPUT_TOPIC, learning, reasoning, prediction, recommendation,
      evidence: { window: copyMetadata(window), observations: copyMetadata(learning.observations), sourceTimestamps: this.raw.map((x) => x.timestamp), resetEvents: copyMetadata(this.resetEvents.slice(-10)), partialAvailability: copyMetadata(partialStats) },
      evidenceWindow: { ...window, minimumSamples: this.minimumSamples, historicalWindowId: window.from && window.to ? `${window.from}/${window.to}` : null },
      sourceMetadata: { source: 'cpslai1-local-cognitive-service', inputTopics: ['cpslai1/oee', 'cpslai1/status', 'cpslai1/data', 'cpslai1/intervention'], measurementPolicy: 'No input APQ/OEE value is modified or presented as a new physical measurement.', indicatorAvailability: this.indicatorsUnavailable ? 'unavailable_partial' : last ? 'available' : 'no_oee_evidence', latestIndicators: this.indicatorsUnavailable ? { availability: null, performance: null, quality: null, oee: null } : copyMetadata(last?.metrics ?? null), latestOeeProvenance: copyMetadata(this.indicatorsUnavailable ? this.latestPartialProvenance : last?.provenance ?? null), latestStatusMetadata: copyMetadata(this.status ? { timestamp: this.status.timestamp ?? null, operationalState: this.status.operationalState ?? null, evidenceStatus: this.status.evidenceStatus ?? null, operationalStateEvidence: this.status.operationalStateEvidence ?? null } : null), reliability: learning.ready ? { level: learning.confidence >= .75 ? 'high' : learning.confidence >= .5 ? 'medium' : 'low', confidence: learning.confidence } : { level: 'insufficient', confidence: 0 } },
      functionalImpact: { capability: 'MaterialTransport', participationRisk: riskLevel, consequences: reasoning.possibleConsequences, operationalAuthority: 'advisory_only' } };
    return assertCognitiveEnvelope(this.hysteresis.apply(candidate));
  }
}

export function analyzeHistory({ oee = [], status = null, data = null, interventions = [], ppuEvents = [] } = {}, options = {}) {
  const analysis = new CognitiveAnalysis(options); if (status) analysis.ingest('cpslai1/status', status); if (data) analysis.ingest('cpslai1/data', data); interventions.forEach((x) => analysis.ingest('cpslai1/intervention', x)); ppuEvents.forEach((x) => analysis.ingestPpuEvent(x)); oee.forEach((x) => analysis.ingest('cpslai1/oee', x)); return analysis.analyze();
}
