const EVIDENCE_STATUS = 'RULE_DERIVED_FROM_VALIDATED_OPERATIONAL_EVIDENCE';
const NOTE =
  'Operational Health derived from validated communication freshness and operational state. Machine-condition health is not inferred.';

const HEALTH_BY_OPERATIONAL_STATE = Object.freeze({
  RUNNING: { health: 100, healthState: 'HEALTHY' },
  STOPPED: { health: 70, healthState: 'DEGRADED' },
  MAINTENANCE: { health: 60, healthState: 'MAINTENANCE' },
  UNKNOWN: { health: 40, healthState: 'UNKNOWN_OPERATIONAL_STATE' },
});

const OPERATIONAL_HEALTH_CPS_IDS = new Set(['cpslai1']);

const normalizeCpsId = (value) =>
  String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/^([a-z]+)0*([0-9]+)$/, '$1$2');

export function buildCpsOperationalHealth({
  cpsId,
  communication,
  operationalState,
  timestamp = new Date(),
} = {}) {
  const normalizedCpsId = normalizeCpsId(cpsId);
  if (!OPERATIONAL_HEALTH_CPS_IDS.has(normalizedCpsId)) return null;
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
    cpsId: normalizedCpsId,
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

export function publishCpsOperationalHealth({ client, topic, cpsId, status } = {}) {
  const normalizedCpsId = normalizeCpsId(cpsId ?? status?.cpsId);
  const payload = buildCpsOperationalHealth({ ...status, cpsId: normalizedCpsId });
  const topicOwnsCps = String(topic ?? '')
    .split('/')
    .some((segment) => normalizeCpsId(segment) === normalizedCpsId);
  if (!payload || !client?.connected || !topic || !topicOwnsCps) return null;
  client.publish(topic, JSON.stringify(payload), { qos: 1, retain: true });
  return payload;
}

// Compatibility aliases for callers outside the ACSM context. The identity is
// still explicit at the generic boundary and cannot leak between CPS instances.
export const buildCpsLai1OperationalHealth = (status = {}) =>
  buildCpsOperationalHealth({ ...status, cpsId: 'cpslai1' });

export const publishCpsLai1OperationalHealth = ({ status, ...options } = {}) =>
  publishCpsOperationalHealth({ ...options, cpsId: 'cpslai1', status });

const CPS_LAI_02_ID = 'cpslai2';
const CPS_LAI_02_ESSENTIAL_TAGS = Object.freeze(['sys_man', 'sys_sup', 'sys_man2']);
const CPS_LAI_02_SEMANTIC_STATUS = 'PHYSICALLY_VALIDATED_MODE_MARKER';

const parseTimestamp = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const isGoodQuality = (sample = {}) =>
  /^Good(?:\b|\s|\()/i.test(String(sample.statusCode ?? sample.quality ?? '').trim());

const sampleEvidence = (tag, sample, referenceMs, freshnessLimitMs) => {
  if (!sample || typeof sample !== 'object' || Array.isArray(sample)) {
    return { tag, present: false, failedChecks: ['MISSING_TAG'] };
  }

  const failedChecks = [];
  const collectedAtMs = parseTimestamp(sample.collectedAt);
  if (typeof sample.value !== 'boolean') failedChecks.push('NON_BOOLEAN_VALUE');
  if (String(sample.dataType ?? sample.datatype ?? '').trim().toLowerCase() !== 'boolean') {
    failedChecks.push('INCOMPATIBLE_DATATYPE');
  }
  if (!isGoodQuality(sample)) failedChecks.push('BAD_OPCUA_QUALITY');
  if (sample.valid !== true) failedChecks.push('INVALID_SAMPLE');
  if (sample.stale === true) failedChecks.push('STALE_SAMPLE');
  if (collectedAtMs === null) {
    failedChecks.push('INVALID_COLLECTED_AT');
  } else if (
    referenceMs < collectedAtMs ||
    referenceMs - collectedAtMs > freshnessLimitMs
  ) {
    failedChecks.push('COLLECTED_AT_OUTSIDE_FRESHNESS_LIMIT');
  }
  if (sample.semanticMappingStatus !== CPS_LAI_02_SEMANTIC_STATUS) {
    failedChecks.push('INVALID_SEMANTIC_MAPPING');
  }

  return {
    tag,
    present: true,
    value: typeof sample.value === 'boolean' ? sample.value : null,
    dataType: sample.dataType ?? sample.datatype ?? null,
    statusCode: sample.statusCode ?? null,
    quality: sample.quality ?? sample.statusCode ?? null,
    valid: sample.valid === true,
    stale: sample.stale === true,
    collectedAt: sample.collectedAt ?? null,
    semanticMappingStatus: sample.semanticMappingStatus ?? null,
    failedChecks,
  };
};

export function buildCpsLai2TechnicalHealth({
  cpsId,
  communication,
  telemetry,
  timestamp,
} = {}) {
  if (normalizeCpsId(cpsId) !== CPS_LAI_02_ID) return null;
  if (typeof communication?.dataFresh !== 'boolean') return null;

  const calculationMs = parseTimestamp(
    timestamp ?? telemetry?.publishedAt ?? telemetry?.timestamp ?? new Date()
  );
  if (calculationMs === null) return null;
  const calculationTimestamp = new Date(calculationMs).toISOString();

  if (communication.dataFresh === false) {
    return {
      schemaVersion: '1.0',
      cpsId: CPS_LAI_02_ID,
      timestamp: calculationTimestamp,
      health: 0,
      current: 0,
      score: 0,
      healthState: 'COMMUNICATION_LOST',
      state: 'COMMUNICATION_LOST',
      healthType: 'CPS_LAI_02_TECHNICAL_HEALTH',
      communication: {
        dataFresh: false,
        dataAgeMs: Number.isFinite(Number(communication.dataAgeMs))
          ? Number(communication.dataAgeMs)
          : null,
      },
      evidence: {
        source: 'CPS_LAI_02_OPCUA_MODE_MARKERS',
        evidenceStatus: 'COMMUNICATION_LOSS_CONFIRMED',
        essentialTags: [...CPS_LAI_02_ESSENTIAL_TAGS],
        failedChecks: ['COMMUNICATION_TIMEOUT'],
      },
      note: 'Simplified operational/technical health; communication loss confirmed. Mechanical health is not inferred.',
    };
  }

  const data = telemetry?.data;
  const hasOpcUaEvidence = data && typeof data === 'object' && !Array.isArray(data) &&
    CPS_LAI_02_ESSENTIAL_TAGS.some((tag) => data[tag] && typeof data[tag] === 'object');
  if (!hasOpcUaEvidence) return null;

  const freshnessLimitMs = Number(telemetry?.staleAfterMs);
  if (!Number.isFinite(freshnessLimitMs) || freshnessLimitMs <= 0) return null;
  const samples = CPS_LAI_02_ESSENTIAL_TAGS.map((tag) =>
    sampleEvidence(tag, data[tag], calculationMs, freshnessLimitMs)
  );
  const failedChecks = samples.flatMap((sample) =>
    sample.failedChecks.map((check) => `${sample.tag}:${check}`)
  );
  const healthy = failedChecks.length === 0;
  const score = healthy ? 100 : 70;
  const healthState = healthy ? 'HEALTHY' : 'DEGRADED';

  return {
    schemaVersion: '1.0',
    cpsId: CPS_LAI_02_ID,
    timestamp: calculationTimestamp,
    health: score,
    current: score,
    score,
    healthState,
    state: healthState,
    healthType: 'CPS_LAI_02_TECHNICAL_HEALTH',
    communication: {
      dataFresh: true,
      dataAgeMs: Number.isFinite(Number(communication.dataAgeMs))
        ? Number(communication.dataAgeMs)
        : null,
    },
    evidence: {
      source: 'CPS_LAI_02_OPCUA_MODE_MARKERS',
      evidenceStatus: healthy ? 'ALL_ESSENTIAL_TAGS_VALID' : 'PARTIAL_TECHNICAL_EVIDENCE',
      essentialTags: [...CPS_LAI_02_ESSENTIAL_TAGS],
      freshnessLimitMs,
      snapshotComplete: telemetry?.snapshotComplete === true,
      availableTagCount: Number.isFinite(Number(telemetry?.availableTagCount))
        ? Number(telemetry.availableTagCount)
        : null,
      expectedTagCount: Number.isFinite(Number(telemetry?.expectedTagCount))
        ? Number(telemetry.expectedTagCount)
        : null,
      publishedAt: telemetry?.publishedAt ?? telemetry?.timestamp ?? null,
      samples,
      failedChecks,
    },
    note: healthy
      ? 'Simplified operational/technical health based on three current validated OPC UA mode markers. Mechanical health is not inferred.'
      : 'Simplified operational/technical health is degraded because essential OPC UA evidence is incomplete or invalid. Mechanical failure is not inferred.',
  };
}

const CPS_LAI_03_ID = 'cpslai3';
const CPS_LAI_03_MODE_MARKERS = Object.freeze({
  sys_man: 'ns=3;s="sys_man"',
  sys_sup: 'ns=3;s="sys_sup"',
  sys_man2: 'ns=3;s="sys_man2"',
});
const CPS_LAI_03_MODE_SEMANTIC_STATUS = 'PHYSICALLY_VALIDATED_MODE_MARKER';

const cpsLai3MarkerEvidence = (tag, expectedNodeId, sample, referenceMs, freshnessLimitMs) => {
  if (!sample || typeof sample !== 'object' || Array.isArray(sample)) {
    return { tag, present: false, value: null, failedChecks: ['MISSING_TAG'] };
  }

  const failedChecks = [];
  const collectedAtMs = parseTimestamp(sample.collectedAt);
  if (sample.nodeId !== expectedNodeId) failedChecks.push('UNEXPECTED_NODEID');
  if (String(sample.dataType ?? sample.datatype ?? '').trim().toLowerCase() !== 'boolean') {
    failedChecks.push('INCOMPATIBLE_DATATYPE');
  }
  if (sample.dataTypeNodeId !== 'ns=0;i=1') failedChecks.push('DATATYPE_NODEID_NOT_PROVEN');
  if (sample.dataTypeEvidence !== 'OPC_UA_ATTRIBUTE_DATATYPE') {
    failedChecks.push('DATATYPE_EVIDENCE_NOT_PROVEN');
  }
  if (typeof sample.value !== 'boolean') failedChecks.push('NON_BOOLEAN_VALUE');
  const hasGoodQuality = [sample.statusCode, sample.quality].some((quality) =>
    /^Good(?:\b|\s|\()/i.test(String(quality ?? '').trim())
  );
  if (!hasGoodQuality) {
    failedChecks.push('BAD_OPCUA_QUALITY');
  }
  if (sample.valid !== true) failedChecks.push('INVALID_SAMPLE');
  if (sample.stale === true) failedChecks.push('STALE_SAMPLE');
  if (!Number.isFinite(freshnessLimitMs) || freshnessLimitMs <= 0) {
    failedChecks.push('INVALID_FRESHNESS_LIMIT');
  } else if (collectedAtMs === null) {
    failedChecks.push('INVALID_COLLECTED_AT');
  } else if (referenceMs < collectedAtMs || referenceMs - collectedAtMs > freshnessLimitMs) {
    failedChecks.push('COLLECTED_AT_OUTSIDE_FRESHNESS_LIMIT');
  }
  if (sample.semanticMappingStatus !== CPS_LAI_03_MODE_SEMANTIC_STATUS) {
    failedChecks.push('INVALID_SEMANTIC_MAPPING');
  }

  return {
    tag,
    present: true,
    value: typeof sample.value === 'boolean' ? sample.value : null,
    nodeId: sample.nodeId ?? null,
    dataType: sample.dataType ?? sample.datatype ?? null,
    dataTypeNodeId: sample.dataTypeNodeId ?? null,
    dataTypeEvidence: sample.dataTypeEvidence ?? null,
    statusCode: sample.statusCode ?? null,
    quality: sample.quality ?? sample.statusCode ?? null,
    valid: sample.valid === true,
    stale: sample.stale === true,
    collectedAt: sample.collectedAt ?? null,
    semanticMappingStatus: sample.semanticMappingStatus ?? null,
    failedChecks,
  };
};

export function buildCpsLai3TechnicalHealth({
  cpsId,
  communication,
  telemetry,
  timestamp,
  timeoutConfirmed = false,
} = {}) {
  if (normalizeCpsId(cpsId) !== CPS_LAI_03_ID) return null;

  const calculationMs = parseTimestamp(timestamp ?? new Date());
  if (calculationMs === null) return null;
  const calculationTimestamp = new Date(calculationMs).toISOString();
  const dataMessageReceived = communication?.dataMessageReceived === true;
  const connectionKnown = typeof communication?.connected === 'boolean';
  const base = {
    schemaVersion: '1.0',
    cpsId: CPS_LAI_03_ID,
    timestamp: calculationTimestamp,
    healthType: 'CPS_LAI_03_TECHNICAL_HEALTH',
  };

  if (timeoutConfirmed === true) {
    return {
      ...base,
      health: 0,
      current: 0,
      score: 0,
      healthState: 'COMMUNICATION_LOST',
      state: 'COMMUNICATION_LOST',
      communication: {
        connected: communication?.connected ?? null,
        dataFresh: communication?.dataFresh ?? null,
        dataMessageReceived,
        timeoutConfirmed: true,
      },
      evidence: {
        source: 'CPS_LAI_03_OPCUA_MODE_MARKERS',
        evidenceStatus: 'ACSM_DATA_RECEIPT_TIMEOUT',
        essentialTags: Object.keys(CPS_LAI_03_MODE_MARKERS),
        failedChecks: ['CPSLAI3_DATA_RECEIPT_TIMEOUT'],
      },
      note: 'Simplified operational/technical health; ACSM receipt timeout confirmed. Mechanical health is not inferred.',
    };
  }

  // An explicit disconnect in a newly received snapshot is independent of
  // dataFresh. Missing/stale samples alone must never produce score zero.
  if (
    dataMessageReceived && connectionKnown && communication.connected === false &&
    communication.connectedConfirmed === true
  ) {
    return {
      ...base,
      health: 0,
      current: 0,
      score: 0,
      healthState: 'COMMUNICATION_LOST',
      state: 'COMMUNICATION_LOST',
      communication: {
        connected: false,
        connectedConfirmed: true,
        dataFresh: communication?.dataFresh ?? null,
        dataMessageReceived: true,
        timeoutConfirmed: false,
      },
      evidence: {
        source: 'CPS_LAI_03_OPCUA_MODE_MARKERS',
        evidenceStatus: 'OPCUA_DISCONNECTION_CONFIRMED',
        essentialTags: Object.keys(CPS_LAI_03_MODE_MARKERS),
        failedChecks: ['OPCUA_CONNECTED_FALSE'],
      },
      note: 'Simplified operational/technical health; OPC UA disconnection explicitly reported. Mechanical health is not inferred.',
    };
  }

  const communicationCurrent = dataMessageReceived && connectionKnown && communication.connected === true;
  const data = telemetry?.data;
  const hasMarkerEvidence = data && typeof data === 'object' && !Array.isArray(data) &&
    Object.keys(CPS_LAI_03_MODE_MARKERS).some((tag) =>
      Object.prototype.hasOwnProperty.call(data, tag) && data[tag] !== undefined && data[tag] !== null
    );
  if (!communicationCurrent || !hasMarkerEvidence) return null;

  const freshnessLimitMs = Number(telemetry?.staleAfterMs);
  const samples = Object.entries(CPS_LAI_03_MODE_MARKERS).map(([tag, nodeId]) =>
    cpsLai3MarkerEvidence(tag, nodeId, data[tag], calculationMs, freshnessLimitMs)
  );
  const failedChecks = samples.flatMap((sample) =>
    sample.failedChecks.map((check) => `${sample.tag}:${check}`)
  );
  if (communication.dataFresh === false) failedChecks.push('COMMUNICATION:DATA_NOT_FRESH');
  const healthy = failedChecks.length === 0;
  const score = healthy ? 100 : 70;
  const healthState = healthy ? 'HEALTHY' : 'DEGRADED';

  return {
    ...base,
    health: score,
    current: score,
    score,
    healthState,
    state: healthState,
    communication: {
      connected: true,
      connectedConfirmed: communication.connectedConfirmed === true,
      dataFresh: communication?.dataFresh ?? null,
      dataMessageReceived: true,
      timeoutConfirmed: false,
    },
    evidence: {
      source: 'CPS_LAI_03_OPCUA_MODE_MARKERS',
      evidenceStatus: healthy ? 'ALL_ESSENTIAL_TAGS_VALID' : 'PARTIAL_TECHNICAL_EVIDENCE',
      essentialTags: Object.keys(CPS_LAI_03_MODE_MARKERS),
      freshnessLimitMs,
      snapshotComplete: telemetry?.snapshotComplete === true,
      availableTagCount: Number.isFinite(Number(telemetry?.availableTagCount))
        ? Number(telemetry.availableTagCount)
        : null,
      expectedTagCount: Number.isFinite(Number(telemetry?.expectedTagCount))
        ? Number(telemetry.expectedTagCount)
        : null,
      publishedAt: telemetry?.publishedAt ?? telemetry?.timestamp ?? null,
      samples,
      failedChecks,
    },
    note: healthy
      ? 'Simplified operational/technical health based on three current validated OPC UA mode markers. Marker values and physical mode do not affect the score; mechanical health is not inferred.'
      : 'Simplified operational/technical health is degraded because one or more essential marker samples are incomplete or invalid. Mechanical failure is not inferred.',
  };
}
