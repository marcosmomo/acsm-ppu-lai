const EVIDENCE_STATUS = 'RULE_DERIVED_FROM_VALIDATED_OPERATIONAL_EVIDENCE';
const NOTE =
  'Operational Health derived from validated communication freshness and operational state. Machine-condition health is not inferred.';

const HEALTH_BY_OPERATIONAL_STATE = Object.freeze({
  RUNNING: { health: 100, healthState: 'HEALTHY' },
  STOPPED: { health: 70, healthState: 'DEGRADED' },
  MAINTENANCE: { health: 60, healthState: 'MAINTENANCE' },
  UNKNOWN: { health: 40, healthState: 'UNKNOWN_OPERATIONAL_STATE' },
});

export function buildCpsLai1OperationalHealth({
  communication,
  operationalState,
  timestamp = new Date(),
} = {}) {
  if (typeof communication?.dataFresh !== 'boolean') return null;

  const normalizedOperationalState = String(operationalState || 'UNKNOWN').trim().toUpperCase();
  const effectiveOperationalState = HEALTH_BY_OPERATIONAL_STATE[normalizedOperationalState]
    ? normalizedOperationalState
    : 'UNKNOWN';
  const derived = communication.dataFresh
    ? HEALTH_BY_OPERATIONAL_STATE[effectiveOperationalState]
    : { health: 0, healthState: 'COMMUNICATION_LOST' };
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;

  return {
    schemaVersion: '1.0',
    cpsId: 'cpslai1',
    timestamp: date.toISOString(),
    health: derived.health,
    current: derived.health,
    score: derived.health,
    healthState: derived.healthState,
    state: derived.healthState,
    healthType: 'OPERATIONAL_HEALTH',
    communication: {
      dataFresh: communication.dataFresh,
      dataAgeMs: Number.isFinite(Number(communication.dataAgeMs))
        ? Number(communication.dataAgeMs)
        : null,
    },
    evidence: {
      communicationFresh: communication.dataFresh,
      operationalState: effectiveOperationalState,
      evidenceStatus: EVIDENCE_STATUS,
    },
    note: NOTE,
  };
}

export function publishCpsLai1OperationalHealth({ client, topic, status } = {}) {
  const payload = buildCpsLai1OperationalHealth(status);
  if (!payload || !client?.connected || !topic) return null;
  client.publish(topic, JSON.stringify(payload), { qos: 1, retain: true });
  return payload;
}
