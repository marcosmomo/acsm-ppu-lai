const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const CPS_LAI_02_MODE_TAGS = ['sys_man', 'sys_sup', 'sys_man2'];
const CPS_LAI_02_MODES = new Set(['MANUAL', 'AUTOMATIC', 'STEP_BY_STEP', 'UNKNOWN']);

const finiteTimestamp = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export const getTelemetrySampleTimestamp = (sample = {}) =>
  finiteTimestamp(sample.collectedAt) ??
  finiteTimestamp(sample.sourceTimestamp) ??
  finiteTimestamp(sample.serverTimestamp) ??
  null;

export const isGoodOpcUaQuality = (sample = {}) => {
  if (sample.valid === false) return false;
  const quality = String(sample.statusCode ?? sample.quality ?? '').trim();
  return /^Good(?:\b|\s|\()/i.test(quality);
};

export const normalizeTelemetrySample = (tag, sample = {}) => {
  if (!sample || typeof sample !== 'object' || Array.isArray(sample)) return null;

  const valueAvailable = hasOwn(sample, 'value') && sample.value !== null && sample.value !== undefined;
  const valid = valueAvailable && isGoodOpcUaQuality(sample);

  return {
    field: sample.field || tag,
    value: hasOwn(sample, 'value') ? sample.value : null,
    nodeId: sample.nodeId ?? null,
    dataType: sample.dataType ?? sample.datatype ?? null,
    dataTypeNodeId: sample.dataTypeNodeId ?? null,
    dataTypeEvidence: sample.dataTypeEvidence ?? null,
    invalidReason: sample.invalidReason ?? null,
    statusCode: sample.statusCode ?? null,
    quality: sample.quality ?? sample.statusCode ?? null,
    collectedAt: sample.collectedAt ?? null,
    timestamp: sample.timestamp ?? null,
    sourceTimestamp: sample.sourceTimestamp ?? null,
    serverTimestamp: sample.serverTimestamp ?? null,
    semanticMappingStatus: sample.semanticMappingStatus ?? null,
    ageMs: sample.ageMs ?? null,
    stale: sample.stale === true,
    valid,
    available: valueAvailable,
  };
};

const shouldReplaceSample = (previous, incoming) => {
  if (!previous) return true;
  const previousTs = getTelemetrySampleTimestamp(previous);
  const incomingTs = getTelemetrySampleTimestamp(incoming);
  if (previousTs !== null && incomingTs !== null) return incomingTs >= previousTs;
  if (previousTs !== null && incomingTs === null) return false;
  return true;
};

const sameSampleEvidence = (left, right) =>
  left?.field === right?.field &&
  left?.value === right?.value &&
  left?.nodeId === right?.nodeId &&
  left?.dataType === right?.dataType &&
  left?.dataTypeNodeId === right?.dataTypeNodeId &&
  left?.dataTypeEvidence === right?.dataTypeEvidence &&
  left?.invalidReason === right?.invalidReason &&
  left?.statusCode === right?.statusCode &&
  left?.quality === right?.quality &&
  left?.collectedAt === right?.collectedAt &&
  left?.timestamp === right?.timestamp &&
  left?.sourceTimestamp === right?.sourceTimestamp &&
  left?.serverTimestamp === right?.serverTimestamp &&
  left?.semanticMappingStatus === right?.semanticMappingStatus &&
  left?.stale === right?.stale &&
  left?.valid === right?.valid &&
  left?.available === right?.available;

const sameDerivedEvidence = (left, right) => {
  if (left === right) return true;
  if (!left || !right) return left === right;
  return left.operationMode === right.operationMode &&
    left.source === right.source &&
    left.semanticValidationStatus === right.semanticValidationStatus &&
    left.reason === right.reason &&
    JSON.stringify(left.tagsUsed || []) === JSON.stringify(right.tagsUsed || []);
};

const newerDerivedEvidence = (previous, incoming) => {
  if (!incoming) return previous;
  if (!previous) return incoming;
  const previousAt = finiteTimestamp(previous.derivedAt);
  const incomingAt = finiteTimestamp(incoming.derivedAt);
  if (previousAt !== null && incomingAt !== null && incomingAt < previousAt) return previous;
  return incoming;
};

export const isCpsLai2SnapshotEquivalent = (previous, incoming = {}) => {
  if (!previous || !incoming?.data || typeof incoming.data !== 'object') return false;
  const derived = newerDerivedEvidence(previous.derived, incoming.derived);
  if (!sameDerivedEvidence(previous.derived, derived)) return false;
  if (previous.staleAfterMs !== (incoming.staleAfterMs ?? previous.staleAfterMs)) return false;

  return Object.entries(incoming.data).every(([tag, rawSample]) => {
    const sample = normalizeTelemetrySample(tag, rawSample);
    const previousSample = previous.data?.[tag];
    if (!sample || !previousSample) return false;
    if (!shouldReplaceSample(previousSample, sample)) return true;
    return sameSampleEvidence(previousSample, sample);
  });
};

export const mergeCpsTelemetry = (previous = null, payload = {}) => {
  const incomingData = payload?.data;
  if (!incomingData || typeof incomingData !== 'object' || Array.isArray(incomingData)) return previous;

  let changed = false;
  const mergedData = { ...(previous?.data || {}) };

  for (const [tag, rawSample] of Object.entries(incomingData)) {
    const sample = normalizeTelemetrySample(tag, rawSample);
    if (!sample || !shouldReplaceSample(mergedData[tag], sample)) continue;
    if (sameSampleEvidence(mergedData[tag], sample)) continue;
    mergedData[tag] = sample;
    changed = true;
  }

  const derived = newerDerivedEvidence(previous?.derived, payload.derived);
  if (!sameDerivedEvidence(previous?.derived, derived)) changed = true;
  const metadataChanged =
    previous?.staleAfterMs !== (payload.staleAfterMs ?? previous?.staleAfterMs) ||
    previous?.snapshotComplete !== (payload.snapshotComplete ?? previous?.snapshotComplete) ||
    previous?.availableTagCount !== (payload.availableTagCount ?? previous?.availableTagCount) ||
    previous?.expectedTagCount !== (payload.expectedTagCount ?? previous?.expectedTagCount) ||
    previous?.publishedAt !== (payload.publishedAt ?? previous?.publishedAt);
  if (!changed && !metadataChanged) return previous;

  return {
    cpsId: payload.cpsId ?? previous?.cpsId ?? null,
    formalCpsId: payload.formalCpsId ?? previous?.formalCpsId ?? null,
    displayName: payload.displayName ?? previous?.displayName ?? null,
    source: payload.source ?? previous?.source ?? null,
    endpoint: payload.endpoint ?? previous?.endpoint ?? null,
    timestamp: payload.timestamp ?? payload.collectedAt ?? previous?.timestamp ?? null,
    collectedAt: payload.collectedAt ?? payload.timestamp ?? previous?.collectedAt ?? null,
    publishedAt: payload.publishedAt ?? payload.timestamp ?? previous?.publishedAt ?? null,
    snapshotComplete: payload.snapshotComplete ?? previous?.snapshotComplete ?? null,
    availableTagCount: payload.availableTagCount ?? previous?.availableTagCount ?? null,
    expectedTagCount: payload.expectedTagCount ?? previous?.expectedTagCount ?? null,
    staleAfterMs: payload.staleAfterMs ?? previous?.staleAfterMs ?? null,
    derived: derived ?? null,
    data: mergedData,
  };
};

export const getCpsLai2PhysicalOperationMode = (entry = null, communicationFresh = true) => {
  const derived = entry?.derived;
  const mode = String(derived?.operationMode || '').trim().toUpperCase();

  if (!derived || !CPS_LAI_02_MODES.has(mode)) return 'UNKNOWN';
  if (derived.source !== 'PHYSICAL_OPCUA_MARKERS') return 'UNKNOWN';
  if (derived.semanticValidationStatus !== 'PHYSICALLY_VALIDATED') return 'UNKNOWN';
  if (communicationFresh !== true) return 'UNKNOWN';

  // The adapter evaluates age and quality using its own collection clock.
  // Keep timestamp presence as evidence without comparing to the browser clock.
  if (finiteTimestamp(derived.derivedAt) === null) return 'UNKNOWN';

  for (const tag of CPS_LAI_02_MODE_TAGS) {
    const sample = normalizeTelemetrySample(tag, entry?.data?.[tag]);
    if (
      !sample ||
      String(sample.dataType || '').toLowerCase() !== 'boolean' ||
      typeof sample.value !== 'boolean' ||
      sample.valid !== true ||
      sample.stale === true ||
      finiteTimestamp(sample.collectedAt) === null
    ) {
      return 'UNKNOWN';
    }
  }

  return mode;
};

export const applyCpsLai2PhysicalOperationMode = (
  cps,
  entry = null,
  communicationFresh = true
) => {
  if (!cps) return cps;
  const cpsId = String(cps?.id ?? cps?.cpsId ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/^([a-z]+)0*([0-9]+)$/, '$1$2');
  if (cpsId !== 'cpslai2') return cps;
  const operationMode = getCpsLai2PhysicalOperationMode(entry, communicationFresh);
  if (cps?.operationalData?.operationMode === operationMode) return cps;
  return {
    ...cps,
    operationalData: {
      ...(cps?.operationalData || {}),
      operationMode,
    },
  };
};

export const isCpsLai2TelemetryCommunicationFresh = (
  lastReceivedAt,
  now = Date.now(),
  timeoutMs = 6000
) => {
  const receivedAt = Number(lastReceivedAt);
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const limit = Number(timeoutMs);
  return Number.isFinite(receivedAt) &&
    Number.isFinite(nowMs) &&
    Number.isFinite(limit) &&
    limit > 0 &&
    nowMs >= receivedAt &&
    nowMs - receivedAt < limit;
};

export const mergeTelemetryState = (state = {}, cpsId, payload = {}) => {
  const normalizedCpsId = String(cpsId || payload?.cpsId || '').trim().toLowerCase();
  if (!normalizedCpsId) return state;
  const previous = state[normalizedCpsId] || null;
  const merged = mergeCpsTelemetry(previous, payload);
  if (merged === previous) return state;
  return { ...state, [normalizedCpsId]: { ...merged, cpsId: normalizedCpsId } };
};

export const buildTelemetryRows = (entry = null) =>
  Object.entries(entry?.data || {})
    .map(([tag, sample]) => ({ tag, ...normalizeTelemetrySample(tag, sample) }))
    .filter((sample) => sample.field)
    .sort((left, right) => left.tag.localeCompare(right.tag));

export const shouldUseLocalTelemetryModal = (cpsOrId) => {
  const raw = typeof cpsOrId === 'object' ? cpsOrId?.id ?? cpsOrId?.cpsId ?? cpsOrId?.topic : cpsOrId;
  return String(raw || '').toLowerCase().replace(/[^a-z0-9]/g, '') === 'cpslai2';
};

export const formatTelemetryValue = (sample = {}) => {
  if (!sample.valid || !sample.available) return 'Unavailable';
  if (typeof sample.value === 'boolean') return sample.value ? 'true' : 'false';
  if (sample.value === 0) return '0';
  if (typeof sample.value === 'object') return JSON.stringify(sample.value);
  return String(sample.value);
};
