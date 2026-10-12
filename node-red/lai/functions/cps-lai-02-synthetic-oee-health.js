const P = Object.freeze({
  plannedWindowMs: 60000,
  expectedSampleIntervalMs: 1000,
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

if (msg.topic !== 'cpslai2/data') return null;
const data = parse(msg.payload);
if (data?.cpsId !== 'cpslai2') return null;

const publishedAtMs = time(data.publishedAt || data.timestamp);
const declaredFreshnessMs = Number(data.staleAfterMs);
const freshnessLimitMs = Number.isFinite(declaredFreshnessMs) && declaredFreshnessMs > 0
  ? Math.min(declaredFreshnessMs, P.maxEvidenceAgeMs)
  : P.maxEvidenceAgeMs;
const envelopeAgeMs = publishedAtMs === null || publishedAtMs > now
  ? freshnessLimitMs + 1
  : now - publishedAtMs;
const markers = [
  { tag: 'GCT_0', nodeId: 'ns=3;s="GCT_0"' },
  { tag: 'sys_man', nodeId: 'ns=3;s="sys_man"' },
  { tag: 'sys_sup', nodeId: 'ns=3;s="sys_sup"' },
  { tag: 'sys_man2', nodeId: 'ns=3;s="sys_man2"' }
];
const samples = data.data || {};
const sampleValid = marker => {
  const sample = samples[marker.tag];
  const collectedAtMs = time(sample?.collectedAt);
  return !!sample && sample.nodeId === marker.nodeId &&
    String(sample.dataType || sample.datatype || '').toLowerCase() === 'boolean' &&
    sample.valid === true && sample.stale !== true &&
    /^Good(?:\b|\s|\()/i.test(String(sample.statusCode || sample.quality || '')) &&
    typeof sample.value === 'boolean' && collectedAtMs !== null && collectedAtMs <= now &&
    now - collectedAtMs <= freshnessLimitMs;
};
const validCount = markers.filter(sampleValid).length;
const goodCount = markers.filter(marker => {
  const sample = samples[marker.tag];
  return sampleValid(marker) && /^Good(?:\b|\s|\()/i.test(String(sample.statusCode || sample.quality || ''));
}).length;
const currentMode = data.derived?.operationMode || 'UNKNOWN';
const semanticValid = data.derived?.semanticValidationStatus === 'PHYSICALLY_VALIDATED' &&
  time(data.derived?.derivedAt) !== null && currentMode !== 'UNKNOWN';
const evidenceValid = envelopeAgeMs <= freshnessLimitMs && semanticValid &&
  validCount === markers.length && goodCount === markers.length;

let healthHistory = flow.get('cpslai2_synthetic_health_history') || {
  lastMode: null, transitions: 0, invalidSnapshots: 0, totalSnapshots: 0
};
healthHistory.totalSnapshots++;
if (!evidenceValid) healthHistory.invalidSnapshots++;
if (evidenceValid && healthHistory.lastMode && healthHistory.lastMode !== currentMode) {
  healthHistory.transitions++;
}
if (evidenceValid) healthHistory.lastMode = currentMode;
flow.set('cpslai2_synthetic_health_history', healthHistory);

let oeeWindow = flow.get('cpslai2_synthetic_oee_window') || null;
let lastOee = flow.get('cpslai2_synthetic_last_oee') || null;
const automaticEvidence = evidenceValid && currentMode === 'AUTOMATIC';
const wasAutomatic = oeeWindow?.active === true;

if (!automaticEvidence) {
  oeeWindow = null;
  flow.set('cpslai2_synthetic_oee_window', null);
} else {
  if (!wasAutomatic) {
    oeeWindow = {
      active: true,
      startedAt: publishedAtMs,
      lastSnapshotAt: publishedAtMs,
      observedMs: 0,
      snapshotCount: 0
    };
  } else if (publishedAtMs > oeeWindow.lastSnapshotAt) {
    const duration = publishedAtMs - oeeWindow.lastSnapshotAt;
    if (duration <= freshnessLimitMs) oeeWindow.observedMs += duration;
    oeeWindow.lastSnapshotAt = publishedAtMs;
  }
  oeeWindow.snapshotCount++;
  flow.set('cpslai2_synthetic_oee_window', oeeWindow);
}

const emittedAt = new Date(now).toISOString();
let oeePayload;
if (automaticEvidence) {
  const elapsedMs = Math.max(
    P.expectedSampleIntervalMs,
    publishedAtMs - oeeWindow.startedAt + P.expectedSampleIntervalMs
  );
  const observedMs = Math.max(
    P.expectedSampleIntervalMs,
    oeeWindow.observedMs + P.expectedSampleIntervalMs
  );
  const availability = clamp(100 * observedMs / elapsedMs);
  const performance = 100 * P.syntheticPerformanceRatio;
  const quality = 100 * P.syntheticQualityRatio;
  const oee = availability * performance * quality / 10000;
  const calculatedAt = new Date(publishedAtMs).toISOString();
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
    performance: { value: performance, state: 'COMPUTED', origin: 'SYNTHETIC_ESTIMATE', basis: 'configured 90% hypothesis; no measured production count is implied' },
    quality: { value: quality, state: 'COMPUTED', origin: 'SYNTHETIC_ESTIMATE', basis: 'configured 98% hypothesis; not measured good/total production' },
    oee: { value: oee, state: 'COMPUTED', origin: 'SYNTHETIC_ESTIMATE', basis: 'availability x performance x quality' }
  };
  lastOee = {
    calculatedAt,
    oee: { current: oee, availability, performance, quality, unit: 'percent' },
    window,
    componentStatus
  };
  flow.set('cpslai2_synthetic_last_oee', lastOee);
  oeePayload = {
    schemaVersion: '1.2', cpsId: 'cpslai2', timestamp: emittedAt, calculatedAt,
    indicatorClass: 'SYNTHETIC', calculationState: 'SYNTHETIC',
    evidenceStatus: 'CURRENT_PHYSICAL_TELEMETRY', currentMode,
    sourceTopics: ['cpslai2/data'], parameters: P, window,
    optionalExperimentalEvidence: { used: false, metricSessionId: null },
    oee: lastOee.oee, componentStatus
  };
} else {
  const reason = !evidenceValid
    ? (currentMode === 'UNKNOWN' ? 'MODE_UNKNOWN_OR_INVALID_TELEMETRY' : 'INVALID_OR_STALE_TELEMETRY')
    : `MODE_${currentMode}_NOT_AUTOMATIC`;
  const held = !!lastOee;
  const nullOee = { current: null, availability: null, performance: null, quality: null, unit: 'percent' };
  oeePayload = {
    schemaVersion: '1.2', cpsId: 'cpslai2', timestamp: emittedAt,
    calculatedAt: held ? lastOee.calculatedAt : null,
    indicatorClass: 'SYNTHETIC', calculationState: held ? 'HELD_LAST_VALUE' : 'NOT_COMPUTED',
    evidenceStatus: evidenceValid ? 'CURRENT_NON_AUTOMATIC_MODE' : 'DEGRADED_PHYSICAL_TELEMETRY',
    reason, currentMode, sourceTopics: ['cpslai2/data'], parameters: P,
    window: held ? lastOee.window : null,
    optionalExperimentalEvidence: { used: false, metricSessionId: null },
    oee: held ? lastOee.oee : nullOee,
    componentStatus: held
      ? Object.fromEntries(Object.entries(lastOee.componentStatus).map(([key, value]) => [key, { ...value, state: 'HELD_LAST_VALUE' }]))
      : Object.fromEntries(['availability', 'performance', 'quality', 'oee'].map(key => [key, { value: null, state: 'NOT_COMPUTED' }]))
  };
}

let healthPayload;
if (evidenceValid) {
  const freshnessScore = clamp(100 * (1 - envelopeAgeMs / freshnessLimitMs));
  const validityScore = 25 * validCount / markers.length;
  const opcQualityScore = 25 * goodCount / markers.length;
  const stabilityScore = clamp(20 - Math.min(20, healthHistory.transitions * 4) -
    Math.min(10, 10 * healthHistory.invalidSnapshots / healthHistory.totalSnapshots));
  const health = clamp(.30 * freshnessScore + validityScore + opcQualityScore + stabilityScore);
  const healthState = health >= P.healthHealthyThreshold ? 'SYNTHETIC_HEALTHY'
    : health >= P.healthDegradedThreshold ? 'SYNTHETIC_DEGRADED' : 'SYNTHETIC_CRITICAL';
  healthPayload = {
    schemaVersion: '1.2', cpsId: 'cpslai2', timestamp: emittedAt,
    indicatorClass: 'SYNTHETIC', calculationState: 'SYNTHETIC',
    evidenceStatus: 'CURRENT_PHYSICAL_TELEMETRY', currentMode,
    sourceTopics: ['cpslai2/data'], parameters: P,
    health: {
      current: health, score: health, healthState, unit: 'percent',
      origin: 'PHYSICAL_EVIDENCE', source: 'TELEMETRY_INTEGRITY_MODEL',
      basis: 'freshness, validity, OPC UA quality and marker stability',
      factors: { freshnessScore, validityScore, opcQualityScore, stabilityScore }
    }
  };
} else {
  healthPayload = {
    schemaVersion: '1.2', cpsId: 'cpslai2', timestamp: emittedAt,
    indicatorClass: 'SYNTHETIC', calculationState: 'NOT_COMPUTED',
    evidenceStatus: 'DEGRADED_PHYSICAL_TELEMETRY',
    reason: currentMode === 'UNKNOWN' ? 'MODE_UNKNOWN_OR_INVALID_TELEMETRY' : 'INVALID_OR_STALE_TELEMETRY',
    currentMode, sourceTopics: ['cpslai2/data'], parameters: P,
    health: { current: null, score: null, healthState: 'NOT_COMPUTED', unit: 'percent' }
  };
}

return [
  { topic: 'cpslai2/synthetic-oee', qos: 1, retain: false, payload: JSON.stringify(oeePayload) },
  { topic: 'cpslai2/synthetic-health', qos: 1, retain: false, payload: JSON.stringify(healthPayload) }
];
