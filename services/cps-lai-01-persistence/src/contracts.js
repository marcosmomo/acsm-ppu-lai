export const TOPICS = Object.freeze([
  'cpslai1/data',
  'cpslai1/status',
  'cpslai1/oee',
  'cpslai1/health',
]);

export const PPU_TOPIC = 'cpslai1/ppu/events';

export const PPU_OPERATIONS = Object.freeze([
  'PLUG',
  'PLAY',
  'STOP',
  'MAINTENANCE',
  'RETURN',
  'UNPLUG',
  'GOVERNANCE_APPROVAL',
  'GOVERNANCE_REJECTION',
]);

export const PPU_RESULTS = Object.freeze([
  'REQUESTED',
  'GOVERNANCE_DECIDED',
  'ACKNOWLEDGED',
  'COMPLETED',
  'FAILED',
]);

const ppuOperations = new Set(PPU_OPERATIONS);
const ppuResults = new Set(PPU_RESULTS);
const identifier = (value, max = 128) => typeof value === 'string' && value.length > 0 && value.length <= max &&
  /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const timestampLike = (value) => value === undefined || value === null ||
  (typeof value === 'string' && Number.isFinite(Date.parse(value)));

export function parsePayload(input) {
  if (Buffer.isBuffer(input)) input = input.toString('utf8');
  if (typeof input === 'string') {
    try { input = JSON.parse(input); } catch { return { ok: false, errors: ['invalid_json'] }; }
  }
  return isObject(input) ? { ok: true, payload: input } : { ok: false, errors: ['payload_must_be_object'] };
}

export function validateMessage(topic, rawPayload, cpsId = 'cpslai1') {
  if (!TOPICS.includes(topic) && topic !== PPU_TOPIC) return { ok: false, errors: ['unsupported_topic'] };
  const parsed = parsePayload(rawPayload);
  if (!parsed.ok) return parsed;
  const payload = parsed.payload;
  const errors = [];
  if (payload.cpsId !== cpsId) errors.push('cps_id_mismatch');
  if (payload.schemaVersion !== undefined && typeof payload.schemaVersion !== 'string') errors.push('invalid_schema_version');
  if (!timestampLike(payload.timestamp)) errors.push('invalid_publication_timestamp');

  if (topic === PPU_TOPIC) {
    if (payload.schemaVersion !== '1.0') errors.push('unsupported_ppu_schema_version');
    if (!identifier(payload.eventId)) errors.push('invalid_event_id');
    if (!ppuOperations.has(payload.operation)) errors.push('invalid_ppu_operation');
    if (!ppuResults.has(payload.result)) errors.push('invalid_ppu_result');
    if (typeof payload.occurredAt !== 'string' || !Number.isFinite(Date.parse(payload.occurredAt))) errors.push('invalid_occurred_at');
    if (typeof payload.source !== 'string' || payload.source.length < 1 || payload.source.length > 64) errors.push('invalid_ppu_source');
    for (const field of ['correlationId', 'commandId', 'episodeId']) {
      if (payload[field] !== undefined && payload[field] !== null && !identifier(payload[field])) errors.push(`invalid_${field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`);
    }
    for (const field of ['previousState', 'newState']) {
      if (payload[field] !== undefined && payload[field] !== null && typeof payload[field] !== 'string') errors.push(`invalid_${field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`);
    }
    if (payload.actor !== undefined && payload.actor !== null && typeof payload.actor !== 'string' && !isObject(payload.actor)) errors.push('invalid_actor');
    if (payload.humanDecision !== undefined && payload.humanDecision !== null && !isObject(payload.humanDecision)) errors.push('invalid_human_decision');
    if (payload.evidence !== undefined && payload.evidence !== null && !isObject(payload.evidence) && !Array.isArray(payload.evidence)) errors.push('invalid_evidence');
    if (payload.result === 'GOVERNANCE_DECIDED') {
      if (!isObject(payload.humanDecision)) errors.push('human_decision_required');
      else if (!['APPROVED', 'REJECTED'].includes(payload.humanDecision.decision)) errors.push('invalid_human_decision_value');
    }
  } else if (topic.endsWith('/data')) {
    if (!isObject(payload.evidence)) errors.push('missing_evidence_object');
    if (!payload.timestamp) errors.push('missing_publication_timestamp');
    if (payload.source !== 'OPC_UA') errors.push('unexpected_data_source');
  } else if (topic.endsWith('/status')) {
    if (typeof payload.operationalState !== 'string') errors.push('invalid_operational_state');
    if (payload.operationalStateEvidence !== undefined && !isObject(payload.operationalStateEvidence)) errors.push('invalid_operational_state_evidence');
  } else if (topic.endsWith('/oee')) {
    if (typeof payload.calculationState !== 'string') errors.push('missing_calculation_state');
    if (/SYNTHETIC/i.test(payload.calculationState || '') || /SYNTHETIC/i.test(payload.evidenceStatus || '')) errors.push('synthetic_oee_forbidden_for_cpslai1');
    if (payload.oee !== undefined && !isObject(payload.oee)) errors.push('invalid_oee_object');
    if (payload.reference !== undefined && !isObject(payload.reference)) errors.push('invalid_reference_object');
    if (payload.quality !== undefined && !isObject(payload.quality)) errors.push('invalid_quality_object');
  } else if (topic.endsWith('/health')) {
    if (typeof payload.healthType !== 'string') errors.push('missing_health_type');
    if (typeof payload.healthState !== 'string') errors.push('missing_health_state');
  }
  return errors.length ? { ok: false, errors, payload } : { ok: true, topic, cpsId, payload };
}
