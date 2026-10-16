export const CPS_ID = 'cpslai1';
export const MODEL_VERSION = 'cpslai1-cognitive-v1';
export const OUTPUT_TOPIC = 'acsm/cpslai1/learning';

export const INPUT_TOPICS = Object.freeze([
  'cpslai1/oee',
  'cpslai1/status',
  'cpslai1/data',
  'cpslai1/intervention',
]);

const clone = (value) => value === undefined ? undefined : structuredClone(value);
const finite = (value) => value === null || value === undefined || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const fraction = (value) => {
  const number = finite(value);
  return number !== null && number >= 0 && number <= 1 ? number : null;
};

export function parseMqttPayload(input) {
  if (Buffer.isBuffer(input)) input = input.toString('utf8');
  if (typeof input === 'string') return JSON.parse(input);
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('MQTT payload must be a JSON object.');
  }
  return clone(input);
}

export function normalizeOeePayload(input) {
  const payload = parseMqttPayload(input);
  if (String(payload.cpsId || '').toLowerCase() !== CPS_ID) {
    throw new Error('OEE payload must belong to cpslai1.');
  }
  const block = payload.oee && typeof payload.oee === 'object' ? payload.oee : payload;
  const metrics = {
    availability: fraction(block.availability),
    performance: fraction(block.performance),
    quality: fraction(block.quality),
    oee: fraction(block.current ?? block.oee ?? block.value),
  };
  const calculationState = String(payload.calculationState || '').toUpperCase();
  const indicatorsUnavailable = calculationState === 'PARTIAL';
  if (!indicatorsUnavailable && Object.values(metrics).some((value) => value === null)) {
    throw new Error('OEE payload requires finite Availability, Performance, Quality and OEE fractions.');
  }
  const timestamp = payload.timestamp || payload.ts;
  if (!Number.isFinite(Date.parse(String(timestamp)))) throw new Error('OEE payload requires a valid timestamp.');
  return {
    timestamp: new Date(timestamp).toISOString(),
    timestampMs: Date.parse(timestamp),
    metrics,
    indicatorsUnavailable,
    cycleTimeMs: finite(payload.production?.lastCycleTimeMs ?? payload.production?.averageCycleTimeMs),
    production: clone(payload.production ?? null),
    counters: {
      totalCount: finite(payload.production?.totalCount),
      completedCycles: finite(payload.production?.completedCycles),
      runTimeMs: finite(payload.time?.runTimeMs),
      plannedProductionTimeMs: finite(payload.time?.plannedProductionTimeMs),
    },
    sessionKey: payload.windowId ?? payload.metricSessionId ?? payload.production?.firstProductionTimestamp ?? null,
    provenance: {
      calculationState: clone(payload.calculationState ?? null),
      evidenceStatus: clone(payload.evidenceStatus ?? null),
      source: clone(payload.source ?? null),
      reference: clone(payload.reference ?? null),
      performance: clone(payload.performance ?? null),
      quality: clone(payload.quality ?? null),
      evidence: clone(payload.evidence ?? null),
      note: clone(payload.note ?? null),
      originalTimestamp: clone(timestamp),
    },
    raw: payload,
  };
}

export function assertCognitiveEnvelope(envelope) {
  if (envelope?.cpsId !== CPS_ID) throw new Error('Cognitive envelope must identify cpslai1.');
  if (envelope?.modelVersion !== MODEL_VERSION) throw new Error('Unexpected cognitive model version.');
  if (!Number.isFinite(Date.parse(String(envelope?.timestamp)))) throw new Error('Cognitive envelope requires a timestamp.');
  for (const key of ['learning', 'reasoning', 'prediction', 'recommendation', 'evidence', 'evidenceWindow', 'sourceMetadata', 'functionalImpact']) {
    if (!envelope[key] || typeof envelope[key] !== 'object') throw new Error(`Cognitive envelope requires ${key}.`);
  }
  if (envelope.outputTopic !== OUTPUT_TOPIC) throw new Error('Cognitive envelope has an unsupported output topic.');
  if (typeof envelope.reasoning.recommendation !== 'string') throw new Error('reasoning.recommendation must be text.');
  if ('governableAction' in envelope || 'governableAction' in envelope.recommendation) throw new Error('Lifecycle recommendations must not declare governableAction.');
  if (JSON.stringify(envelope).includes('cpslai1/cmd')) throw new Error('Cognitive envelope must not contain a physical command topic.');
  return envelope;
}

export const copyMetadata = clone;
