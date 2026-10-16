import { createHash, randomUUID } from 'node:crypto';
import { parsePayload, PPU_TOPIC } from './contracts.js';

const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};
const sha256 = (text) => createHash('sha256').update(text).digest();
const asDate = (value) => value && Number.isFinite(Date.parse(value)) ? new Date(value) : null;

export function normalizeMessage({ topic, payload: rawPayload, receivedAt = new Date(), cpsId = 'cpslai1', qos = null, retain = false, maxEvidenceAgeMs = 15000 }) {
  const rawPayloadText = Buffer.isBuffer(rawPayload) ? rawPayload.toString('utf8') : typeof rawPayload === 'string' ? rawPayload : JSON.stringify(rawPayload);
  const parsed = parsePayload(rawPayload);
  if (!parsed.ok) throw new Error(parsed.errors.join(','));
  const payload = parsed.payload;
  const canonicalPayload = canonical(payload);
  const payloadHash = sha256(canonicalPayload);
  const dedupeKey = sha256(`${cpsId}\n${topic}\n${canonicalPayload}`);
  const inboxId = randomUUID();
  const record = {
    inboxId,
    dedupeKey: dedupeKey.toString('hex'),
    payloadHash: payloadHash.toString('hex'),
    rawPayloadText,
    cpsId,
    topic,
    schemaVersion: payload.schemaVersion ?? null,
    sourceTimestamp: asDate(payload.sourceTimestamp),
    publishedAt: asDate(payload.timestamp),
    receivedAt: new Date(receivedAt),
    qos,
    retain,
    payload,
  };

  const samples = [];
  if (topic === 'cpslai1/data') {
    const groups = [['evidence', payload.evidence], ['mode', payload.mode]];
    for (const [group, values] of groups) for (const [key, evidence] of Object.entries(values && typeof values === 'object' ? values : {})) {
      if (!evidence || typeof evidence !== 'object' || !Object.hasOwn(evidence, 'value')) continue;
      const signalKey = group === 'evidence' ? key : `mode.${key}`;
      const value = evidence.value;
      const sampleTimestamp = asDate(evidence.timestamp) ?? record.publishedAt;
      const evidenceAgeMs = sampleTimestamp ? record.receivedAt.getTime() - sampleTimestamp.getTime() : null;
      samples.push({
        signalKey,
        sampleKey: sha256(`${signalKey}\n${canonical(evidence)}`).toString('hex'),
        nodeId: evidence.nodeId ?? null,
        tag: evidence.tag ?? null,
        valueNum: typeof value === 'number' ? value : null,
        valueBool: typeof value === 'boolean' ? value : null,
        valueText: typeof value === 'string' ? value : null,
        rawValue: value ?? null,
        unit: evidence.unit ?? null,
        sourceTimestamp: asDate(evidence.sourceTimestamp),
        serverTimestamp: asDate(evidence.serverTimestamp),
        sampleTimestamp,
        receivedAt: record.receivedAt,
        quality: evidence.quality ?? evidence.statusCode ?? null,
        evidenceStatus: evidence.evidenceStatus ?? null,
        isValid: evidence.valid ?? null,
        isStale: evidence.stale ?? null,
        isFresh: evidence.stale === true ? false : evidenceAgeMs !== null && evidenceAgeMs >= 0 && evidenceAgeMs <= maxEvidenceAgeMs,
        evidenceAgeMs,
        ordinal: samples.length,
      });
    }
  }

  let projection = null;
  if (topic === 'cpslai1/status') {
    projection = { kind: 'status', state: payload.operationalState ?? null, reason: payload.operationalStateEvidence?.reason ?? null, evidenceStatus: payload.operationalStateEvidence?.evidenceStatus ?? payload.evidenceStatus ?? null };
  } else if (topic === 'cpslai1/oee') {
    projection = {
      kind: 'oee',
      calculationState: payload.calculationState ?? null,
      evidenceStatus: payload.evidenceStatus ?? null,
      calculationVersion: payload.calculationVersion ?? null,
      calculatedAt: asDate(payload.calculatedAt ?? payload.timestamp) ?? record.receivedAt,
      windowStart: asDate(payload.window?.windowStart),
      windowEnd: asDate(payload.window?.windowEnd),
      oee: payload.oee?.current ?? null,
      availability: payload.oee?.availability ?? null,
      performance: payload.oee?.performance ?? null,
      quality: payload.oee?.quality ?? null,
      referenceCycleTimeMs: payload.reference?.cycleTimeMs ?? payload.referenceCycleTimeMs ?? null,
      qualityProductValidated: payload.quality?.productQualityValidated ?? null,
      qualityEvidenceStatus: payload.quality?.evidenceStatus ?? null,
    };
  } else if (topic === 'cpslai1/health') {
    projection = {
      kind: 'health',
      healthType: payload.healthType ?? 'UNCLASSIFIED',
      producerComponent: payload.producerComponent ?? null,
      healthState: payload.healthState ?? payload.state ?? null,
      score: payload.health ?? payload.score ?? payload.current ?? null,
      communicationFresh: payload.communication?.dataFresh ?? payload.evidence?.communicationFresh ?? null,
      evidenceStatus: payload.evidence?.evidenceStatus ?? null,
      calculatedAt: asDate(payload.timestamp) ?? record.receivedAt,
    };
  } else if (topic === PPU_TOPIC) {
    const actorId = typeof payload.actor === 'string' ? payload.actor : payload.actor?.id ?? null;
    projection = {
      kind: 'ppu',
      eventKey: sha256(`${cpsId}\n${payload.eventId}`).toString('hex'),
      eventType: `${payload.operation}:${payload.result}`,
      actorId,
      source: payload.source,
      occurredAt: asDate(payload.occurredAt),
      episodeId: payload.episodeId ?? null,
      correlationId: payload.correlationId ?? null,
      evidence: payload.evidence ?? {},
    };
  }

  return { record, samples, projection };
}

export function deriveProductionEdge({ previousValue, previousTimestamp, sample }) {
  if (sample.signalKey !== 'PieceAtExit' || sample.valueBool !== true || sample.isFresh !== true) return null;
  if (sample.evidenceStatus !== 'FIELD_VALIDATED') return null;
  if (!sample.sourceTimestamp || !sample.sampleTimestamp) return null;
  if (previousTimestamp && sample.sourceTimestamp <= previousTimestamp) return null;
  if (previousValue !== false) return null;
  const identity = `${sample.signalKey}\n${sample.sampleTimestamp.toISOString()}\n${sample.tag ?? ''}\ntrue`;
  return {
    eventKey: sha256(identity),
    eventType: 'piece_counted',
    signalKey: sample.signalKey,
    sourceTag: sample.tag,
    countDelta: 1,
    sourceTimestamp: sample.sourceTimestamp,
    receivedAt: sample.receivedAt,
    evidenceStatus: sample.evidenceStatus,
    originMethod: 'PHYSICAL_RISING_EDGE',
  };
}
