export const CPS_LAI_02_MODE_MARKERS = Object.freeze({
  MANUAL: Object.freeze({ tag: 'sys_man', nodeId: 'ns=3;s="sys_man"' }),
  AUTOMATIC: Object.freeze({ tag: 'sys_sup', nodeId: 'ns=3;s="sys_sup"' }),
  STEP_BY_STEP: Object.freeze({ tag: 'sys_man2', nodeId: 'ns=3;s="sys_man2"' }),
});

const DERIVATION_SOURCE = 'PHYSICAL_OPCUA_MARKERS';
const SEMANTIC_STATUS = 'PHYSICALLY_VALIDATED';

const baseResult = (operationMode, reason, derivedAt) => ({
  operationMode,
  source: DERIVATION_SOURCE,
  semanticValidationStatus: SEMANTIC_STATUS,
  reason,
  derivedAt,
  tagsUsed: Object.entries(CPS_LAI_02_MODE_MARKERS).map(([role, marker]) => ({ role, ...marker })),
});

export const deriveCpsLai2OperationMode = (data = {}, derivedAt = new Date().toISOString()) => {
  const samples = Object.values(CPS_LAI_02_MODE_MARKERS).map((marker) => data?.[marker.tag]);
  if (samples.some((sample) => !sample || typeof sample !== 'object')) {
    return baseResult('UNKNOWN', 'MISSING_MODE_MARKER', derivedAt);
  }
  if (samples.some((sample) => String(sample.dataType ?? sample.datatype ?? '').toLowerCase() !== 'boolean')) {
    return baseResult('UNKNOWN', 'INCOMPATIBLE_MARKER_DATATYPE', derivedAt);
  }
  if (samples.some((sample) => sample.stale === true)) {
    return baseResult('UNKNOWN', 'STALE_MODE_MARKER', derivedAt);
  }
  if (samples.some((sample) => sample.valid !== true)) {
    return baseResult('UNKNOWN', 'INVALID_MODE_MARKER', derivedAt);
  }
  if (samples.some((sample) => !/^Good(?:\b|\s|\()/i.test(String(sample.statusCode ?? sample.quality ?? '')))) {
    return baseResult('UNKNOWN', 'BAD_OPCUA_QUALITY', derivedAt);
  }
  if (samples.some((sample) => typeof sample.value !== 'boolean')) {
    return baseResult('UNKNOWN', 'NON_BOOLEAN_MARKER_VALUE', derivedAt);
  }

  const [manual, automatic, stepByStep] = samples.map((sample) => sample.value);
  const activeCount = samples.filter((sample) => sample.value).length;
  if (activeCount === 0) return baseResult('UNKNOWN', 'NO_ACTIVE_MODE_MARKER', derivedAt);
  if (activeCount > 1) return baseResult('UNKNOWN', 'NON_EXCLUSIVE_MODE_MARKERS', derivedAt);
  if (manual) return baseResult('MANUAL', 'EXCLUSIVE_MANUAL_MARKER', derivedAt);
  if (automatic) return baseResult('AUTOMATIC', 'EXCLUSIVE_AUTOMATIC_MARKER', derivedAt);
  if (stepByStep) return baseResult('STEP_BY_STEP', 'EXCLUSIVE_STEP_BY_STEP_MARKER', derivedAt);
  return baseResult('UNKNOWN', 'UNCLASSIFIED_MARKER_COMBINATION', derivedAt);
};
