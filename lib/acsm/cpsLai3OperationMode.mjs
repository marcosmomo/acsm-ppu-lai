const CPS_LAI_03_ID = 'cpslai3';
const DERIVATION_SOURCE = 'CPS_LAI_03_PHYSICAL_MODE_MARKERS';
const SEMANTIC_STATUS = 'PHYSICALLY_VALIDATED';

export const CPS_LAI_03_MODE_MARKERS = Object.freeze({
  MANUAL: Object.freeze({ tag: 'sys_man', nodeId: 'ns=3;s="sys_man"' }),
  AUTOMATIC: Object.freeze({ tag: 'sys_sup', nodeId: 'ns=3;s="sys_sup"' }),
  STEP_BY_STEP: Object.freeze({ tag: 'sys_man2', nodeId: 'ns=3;s="sys_man2"' }),
});

const normalizeCpsId = (value) =>
  String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/^([a-z]+)0*([0-9]+)$/, '$1$2');

const finiteTimestamp = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const result = (operationMode, valid, reason, evidence, samples = []) => ({
  operationMode,
  valid,
  reason,
  source: DERIVATION_SOURCE,
  derivedAt: evidence?.derived?.derivedAt ?? evidence?.publishedAt ?? null,
  tagsUsed: Object.entries(CPS_LAI_03_MODE_MARKERS).map(([role, marker], index) => ({
    role,
    ...marker,
    value: samples[index]?.value ?? null,
  })),
});

// Revalidate all physical samples: an adapter-provided mode/status alone is insufficient.
export const deriveCpsLai3PhysicalOperationMode = ({ cpsId, evidence, communication } = {}) => {
  if (normalizeCpsId(cpsId) !== CPS_LAI_03_ID) {
    return result('UNKNOWN', false, 'CPS_ID_MISMATCH', evidence);
  }
  if (communication?.dataFresh !== true) {
    return result('UNKNOWN', false,
      communication?.dataFresh === false ? 'COMMUNICATION_LOST' : 'COMMUNICATION_UNCONFIRMED', evidence);
  }

  const derived = evidence?.derived;
  if (
    derived?.source !== DERIVATION_SOURCE ||
    derived?.semanticValidationStatus !== SEMANTIC_STATUS ||
    finiteTimestamp(derived?.derivedAt) === null
  ) {
    return result('UNKNOWN', false, 'MODE_EVIDENCE_NOT_VALIDATED', evidence);
  }

  const markers = Object.values(CPS_LAI_03_MODE_MARKERS);
  const samples = markers.map((marker) => evidence?.data?.[marker.tag]);
  if (samples.some((sample) => !sample || typeof sample !== 'object')) {
    return result('UNKNOWN', false, 'MISSING_MODE_MARKER', evidence, samples);
  }
  if (samples.some((sample, index) => sample.nodeId !== markers[index].nodeId)) {
    return result('UNKNOWN', false, 'MODE_MARKER_NODEID_MISMATCH', evidence, samples);
  }
  if (samples.some((sample) => String(sample.dataType ?? sample.datatype ?? '').toLowerCase() !== 'boolean')) {
    return result('UNKNOWN', false, 'INCOMPATIBLE_MARKER_DATATYPE', evidence, samples);
  }
  if (samples.some((sample) =>
    sample.dataTypeNodeId !== 'ns=0;i=1' || sample.dataTypeEvidence !== 'OPC_UA_ATTRIBUTE_DATATYPE'
  )) {
    return result('UNKNOWN', false, 'DATATYPE_EVIDENCE_NOT_PROVEN', evidence, samples);
  }
  if (samples.some((sample) => sample.stale === true)) {
    return result('UNKNOWN', false, 'STALE_MODE_MARKER', evidence, samples);
  }
  if (samples.some((sample) => sample.valid !== true)) {
    return result('UNKNOWN', false, 'INVALID_MODE_MARKER', evidence, samples);
  }
  if (samples.some((sample) => !/^Good(?:\b|\s|\()/i.test(String(sample.statusCode ?? sample.quality ?? '')))) {
    return result('UNKNOWN', false, 'BAD_OPCUA_QUALITY', evidence, samples);
  }
  if (samples.some((sample) => typeof sample.value !== 'boolean')) {
    return result('UNKNOWN', false, 'NON_BOOLEAN_MARKER_VALUE', evidence, samples);
  }
  if (samples.some((sample) => finiteTimestamp(sample.collectedAt) === null)) {
    return result('UNKNOWN', false, 'MISSING_MARKER_TIMESTAMP', evidence, samples);
  }

  const [manual, automatic, stepByStep] = samples.map((sample) => sample.value);
  const activeCount = samples.filter((sample) => sample.value).length;
  let operationMode = 'UNKNOWN';
  let reason = 'NO_ACTIVE_MODE_MARKER';
  if (activeCount > 1) reason = 'NON_EXCLUSIVE_MODE_MARKERS';
  else if (manual) [operationMode, reason] = ['MANUAL', 'EXCLUSIVE_MANUAL_MARKER'];
  else if (automatic) [operationMode, reason] = ['AUTOMATIC', 'EXCLUSIVE_AUTOMATIC_MARKER'];
  else if (stepByStep) [operationMode, reason] = ['STEP_BY_STEP', 'EXCLUSIVE_STEP_BY_STEP_MARKER'];

  if (derived.operationMode !== operationMode || derived.reason !== reason) {
    return result('UNKNOWN', false, 'ADAPTER_DERIVATION_MISMATCH', evidence, samples);
  }
  return result(operationMode, operationMode !== 'UNKNOWN', reason, evidence, samples);
};

export const cpsLai3UnknownPhysicalModeEvidence = (reason = 'INSUFFICIENT_PHYSICAL_EVIDENCE') => ({
  operationMode: 'UNKNOWN',
  valid: false,
  reason,
});
