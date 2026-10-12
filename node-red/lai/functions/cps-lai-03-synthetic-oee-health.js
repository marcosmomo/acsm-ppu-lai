const P = Object.freeze({
  plannedWindowMs: 60000,
  expectedSampleIntervalMs: 1000,
  idealCycleTimeMs: 5000,
  syntheticPerformanceRatio: 0.90,
  syntheticQualityRatio: 0.98,
  maxEvidenceAgeMs: 6000,
  healthHealthyThreshold: 85,
  healthDegradedThreshold: 60
});

const now = Date.now();
const parse = value => {
  if (Buffer.isBuffer(value)) value = value.toString('utf8');
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
};
const time = value => {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
};
const clamp = value => Math.max(0, Math.min(100, value));

if (msg.topic === 'cpslai3/experimental-metrics') {
  const metrics = parse(msg.payload);
  if (metrics?.cpsId === 'cpslai3') {
    flow.set('cpslai3_synthetic_metrics_cache', { payload: metrics, receivedAt: now });
  }
  return null;
}
if (msg.topic !== 'cpslai3/data') return null;

const data = parse(msg.payload);
if (data?.cpsId !== 'cpslai3') return null;

const at = time(data.publishedAt || data.timestamp);
const age = at === null || at > now ? P.maxEvidenceAgeMs + 1 : now - at;
const tags = ['GCT_0', 'sys_man', 'sys_sup', 'sys_man2'];
const samples = data.data || {};
const valid = sample => sample && sample.valid === true && sample.stale !== true && typeof sample.value === 'boolean';
const good = sample => valid(sample) && /^Good(?:\b|\s|\()/i.test(String(sample.statusCode || sample.quality || ''));
const validCount = tags.filter(tag => valid(samples[tag])).length;
const goodCount = tags.filter(tag => good(samples[tag])).length;
const currentMode = data.derived?.operationMode || 'UNKNOWN';
const semanticValid = data.derived?.semanticValidationStatus === 'PHYSICALLY_VALIDATED' && currentMode !== 'UNKNOWN';
const snapshotValid = age <= P.maxEvidenceAgeMs && data.snapshotComplete === true &&
  data.communication?.connected === true && data.communication?.dataFresh === true &&
  semanticValid && validCount === tags.length && goodCount === tags.length;

let healthHistory = flow.get('cpslai3_synthetic_health_history') || {
  lastMode: null, transitions: 0, invalidSnapshots: 0, totalSnapshots: 0
};
healthHistory.totalSnapshots++;
if (!snapshotValid) healthHistory.invalidSnapshots++;
if (snapshotValid && healthHistory.lastMode && healthHistory.lastMode !== currentMode) healthHistory.transitions++;
if (snapshotValid) healthHistory.lastMode = currentMode;
flow.set('cpslai3_synthetic_health_history', healthHistory);

const metricCache = flow.get('cpslai3_synthetic_metrics_cache');
const metrics = metricCache?.payload;
const metricsAt = time(metrics?.updatedAt);
const signals = Array.isArray(metrics?.measuredSignals) ? metrics.measuredSignals : [];
const metricsValid = !!metrics && metricsAt !== null && now >= metricsAt &&
  now - metricsAt <= P.maxEvidenceAgeMs && now - metricCache.receivedAt <= P.maxEvidenceAgeMs &&
  metrics.source === 'CPS_LAI_03_EXPERIMENTAL_SIGNAL_AGGREGATOR' &&
  ['CURRENT', 'BASELINE_ONLY', 'BASELINE_ONLY_AFTER_GAP'].includes(metrics.evidenceQuality) &&
  Number.isInteger(metrics.metrics?.pieceSensorActivationCount) && metrics.metrics.pieceSensorActivationCount >= 0 &&
  signals.length === 4 && signals.every(signal => signal?.valid === true && /^Good(?:\b|\s|\()/i.test(String(signal.statusCode || signal.quality || '')));

let oeeWindow = flow.get('cpslai3_synthetic_oee_window') || null;
let lastOee = flow.get('cpslai3_synthetic_last_oee') || null;
const automaticEvidence = snapshotValid && currentMode === 'AUTOMATIC';
const wasAutomatic = oeeWindow?.active === true;

if (!automaticEvidence) {
  oeeWindow = null;
  flow.set('cpslai3_synthetic_oee_window', null);
} else {
  if (!wasAutomatic) {
    oeeWindow = {
      active: true,
      startedAt: at,
      lastSnapshotAt: at,
      observedMs: 0,
      snapshotCount: 0,
      metricBaselineCount: metricsValid ? metrics.metrics.pieceSensorActivationCount : null
    };
  } else if (at > oeeWindow.lastSnapshotAt) {
    const duration = at - oeeWindow.lastSnapshotAt;
    if (duration <= P.maxEvidenceAgeMs) oeeWindow.observedMs += duration;
    oeeWindow.lastSnapshotAt = at;
  }
  oeeWindow.snapshotCount++;
  flow.set('cpslai3_synthetic_oee_window', oeeWindow);
}

const publishedAt = new Date(now).toISOString();
let oeePayload;
if (automaticEvidence) {
  const elapsedMs = Math.max(P.expectedSampleIntervalMs, at - oeeWindow.startedAt + P.expectedSampleIntervalMs);
  const observedMs = Math.max(P.expectedSampleIntervalMs, oeeWindow.observedMs + P.expectedSampleIntervalMs);
  const availability = clamp(100 * observedMs / elapsedMs);
  let performance = 100 * P.syntheticPerformanceRatio;
  let performanceOrigin = 'SYNTHETIC_ESTIMATE';
  let performanceBasis = 'configured syntheticPerformanceRatio; no measured production count is implied';
  const countDelta = metricsValid && Number.isInteger(oeeWindow.metricBaselineCount)
    ? metrics.metrics.pieceSensorActivationCount - oeeWindow.metricBaselineCount
    : null;
  if (countDelta > 0 && oeeWindow.observedMs > 0) {
    performance = clamp(100 * P.idealCycleTimeMs * countDelta / oeeWindow.observedMs);
    performanceOrigin = 'SYNTHETIC_ESTIMATE_WITH_PHYSICAL_EVIDENCE';
    performanceBasis = 'B1BG1 event proxy delta since this AUTOMATIC window began; not validated production output';
  }
  const quality = 100 * P.syntheticQualityRatio;
  const oee = availability * performance * quality / 10000;
  const calculatedAt = new Date(at).toISOString();
  const window = {
    basis: 'CURRENT_VALIDATED_AUTOMATIC_PERIOD',
    windowStart: new Date(oeeWindow.startedAt).toISOString(),
    windowEnd: calculatedAt,
    plannedWindowMs: P.plannedWindowMs,
    plannedElapsedMs: elapsedMs,
    observedMs,
    automaticMs: observedMs,
    baselineOnly: oeeWindow.snapshotCount === 1,
    snapshotCount: oeeWindow.snapshotCount
  };
  const componentStatus = {
    availability: { value: availability, state: 'COMPUTED', origin: 'PHYSICAL_EVIDENCE', basis: 'validated evidence coverage inside the current AUTOMATIC period' },
    performance: { value: performance, state: 'COMPUTED', origin: performanceOrigin, basis: performanceBasis },
    quality: { value: quality, state: 'COMPUTED', origin: 'SYNTHETIC_ESTIMATE', basis: 'configured 98% hypothesis; not measured good/total production' },
    oee: { value: oee, state: 'COMPUTED', origin: 'SYNTHETIC_ESTIMATE', basis: 'availability x performance x quality' }
  };
  lastOee = { calculatedAt, oee: { current: oee, availability, performance, quality, unit: 'percent' }, window, componentStatus };
  flow.set('cpslai3_synthetic_last_oee', lastOee);
  oeePayload = {
    schemaVersion: '1.2', cpsId: 'cpslai3', timestamp: publishedAt, calculatedAt,
    indicatorClass: 'SYNTHETIC', calculationState: 'SYNTHETIC', evidenceStatus: 'CURRENT_PHYSICAL_TELEMETRY',
    currentMode, sourceTopics: metricsValid ? ['cpslai3/data', 'cpslai3/experimental-metrics'] : ['cpslai3/data'],
    parameters: P, window, optionalExperimentalEvidence: { used: countDelta > 0, metricSessionId: metricsValid ? metrics.metricSessionId || null : null },
    oee: lastOee.oee, componentStatus
  };
} else {
  const reason = !snapshotValid
    ? (currentMode === 'UNKNOWN' ? 'MODE_UNKNOWN_OR_INVALID_TELEMETRY' : 'INVALID_OR_STALE_TELEMETRY')
    : `MODE_${currentMode}_NOT_AUTOMATIC`;
  const held = !!lastOee;
  const nullOee = { current: null, availability: null, performance: null, quality: null, unit: 'percent' };
  oeePayload = {
    schemaVersion: '1.2', cpsId: 'cpslai3', timestamp: publishedAt,
    calculatedAt: held ? lastOee.calculatedAt : null,
    indicatorClass: 'SYNTHETIC', calculationState: held ? 'HELD_LAST_VALUE' : 'NOT_COMPUTED',
    evidenceStatus: snapshotValid ? 'CURRENT_NON_AUTOMATIC_MODE' : 'DEGRADED_PHYSICAL_TELEMETRY',
    reason, currentMode, sourceTopics: ['cpslai3/data'], parameters: P,
    window: held ? lastOee.window : null,
    optionalExperimentalEvidence: { used: false, metricSessionId: null },
    oee: held ? lastOee.oee : nullOee,
    componentStatus: held
      ? Object.fromEntries(Object.entries(lastOee.componentStatus).map(([key, value]) => [key, { ...value, state: 'HELD_LAST_VALUE' }]))
      : Object.fromEntries(['availability', 'performance', 'quality', 'oee'].map(key => [key, { value: null, state: 'NOT_COMPUTED' }]))
  };
}

let healthPayload;
if (snapshotValid) {
  const freshnessScore = clamp(100 * (1 - age / P.maxEvidenceAgeMs));
  const validityScore = 25 * validCount / tags.length;
  const opcQualityScore = 25 * goodCount / tags.length;
  const stabilityScore = clamp(20 - Math.min(20, healthHistory.transitions * 4) -
    Math.min(10, 10 * healthHistory.invalidSnapshots / healthHistory.totalSnapshots));
  const health = clamp(.30 * freshnessScore + validityScore + opcQualityScore + stabilityScore);
  const healthState = health >= P.healthHealthyThreshold ? 'SYNTHETIC_HEALTHY'
    : health >= P.healthDegradedThreshold ? 'SYNTHETIC_DEGRADED' : 'SYNTHETIC_CRITICAL';
  healthPayload = {
    schemaVersion: '1.2', cpsId: 'cpslai3', timestamp: publishedAt, indicatorClass: 'SYNTHETIC',
    calculationState: 'SYNTHETIC', evidenceStatus: 'CURRENT_PHYSICAL_TELEMETRY', currentMode,
    sourceTopics: ['cpslai3/data'], parameters: P,
    health: { current: health, score: health, healthState, unit: 'percent', origin: 'PHYSICAL_EVIDENCE', source: 'TELEMETRY_INTEGRITY_MODEL', basis: 'freshness, validity, OPC UA quality and marker stability', factors: { freshnessScore, validityScore, opcQualityScore, stabilityScore } }
  };
} else {
  healthPayload = {
    schemaVersion: '1.2', cpsId: 'cpslai3', timestamp: publishedAt, indicatorClass: 'SYNTHETIC',
    calculationState: 'NOT_COMPUTED', evidenceStatus: 'DEGRADED_PHYSICAL_TELEMETRY',
    reason: currentMode === 'UNKNOWN' ? 'MODE_UNKNOWN_OR_INVALID_TELEMETRY' : 'INVALID_OR_STALE_TELEMETRY',
    currentMode, sourceTopics: ['cpslai3/data'], parameters: P,
    health: { current: null, score: null, healthState: 'NOT_COMPUTED', unit: 'percent' }
  };
}

return [
  { topic: 'cpslai3/synthetic-oee', qos: 1, retain: false, payload: JSON.stringify(oeePayload) },
  { topic: 'cpslai3/synthetic-health', qos: 1, retain: false, payload: JSON.stringify(healthPayload) }
];
