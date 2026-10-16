export const EVOLUTION_CYCLE_READ_MODEL_VERSION = 'evolution-cycle-read-model/1.0.0';

export const IDENTITY_CORRELATION_STATUS = Object.freeze({
  CORRELATED: 'CORRELATED',
  UNCORRELATED: 'UNCORRELATED',
  CONFLICT: 'CONFLICT',
  UNAVAILABLE: 'UNAVAILABLE',
});

const IDENTITY_FIELDS = Object.freeze(['cpsId', 'plugEventId', 'plugCycleId', 'profileId']);
const VALID_EVOLUTION_STATUS = new Set(['BASELINE', 'NO_CHANGE', 'CHANGED', 'INDETERMINATE', 'FAILED']);
const clone = (value) => value == null ? value : structuredClone(value);
const text = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;
const upper = (value) => text(value)?.toUpperCase() || null;

function identityOf(source) {
  const input = source?.identity || source || {};
  return Object.fromEntries(IDENTITY_FIELDS.map((field) => [field, text(input[field])]));
}

function complete(identity) {
  return IDENTITY_FIELDS.every((field) => identity[field]);
}

function values(sources, field) {
  return [...new Set(sources.map(({ identity }) => identity[field]).filter(Boolean))];
}

function scalarProjection(sources, field, normalize = text) {
  const candidates = [...new Set(sources.map(({ value }) => normalize(value?.[field])).filter(Boolean))];
  return { value: candidates.length === 1 ? candidates[0] : candidates.length > 1 ? 'CONFLICT' : 'UNAVAILABLE', candidates };
}

function issue(code, severity, message, details = {}) {
  return { code, severity, message, details };
}

function sanitizeDeclarations(items, expectedKind) {
  if (!Array.isArray(items)) return [];
  return items.filter((item) => item?.kind === expectedKind).map((item) => ({
    kind: expectedKind,
    name: text(item.name),
    enabled: typeof item.enabled === 'boolean' ? item.enabled : null,
    identity: text(item.identity),
    identityBasis: text(item.identityBasis),
    technicalIdentity: text(item.technicalIdentity),
    semanticReferences: clone(Array.isArray(item.semanticReferences) ? item.semanticReferences : []),
    attributes: clone(item.attributes && typeof item.attributes === 'object' ? item.attributes : {}),
    evidenceLevel: upper(item.evidenceLevel || item.evidence?.level) || 'DECLARED_ONLY',
    experimental: item.experimental === true,
  }));
}

function projectAas(aas, issues) {
  if (!aas) return {
    availability: 'NOT_AVAILABLE', aasId: null, assetId: null, version: null, contentHash: null,
    sourceType: 'UNKNOWN', operational: false, provenanceStatus: 'UNAVAILABLE', evidenceLevel: 'NOT_AVAILABLE',
    capabilities: [], services: [],
  };
  const provenance = aas.provenance || {};
  const sourceType = upper(aas.sourceType || provenance.sourceType) || 'UNKNOWN';
  const explicitlyExperimental = sourceType.includes('EXPERIMENTAL') || provenance.experimental === true;
  const explicitlyOperational = (aas.operational === true || provenance.operational === true) && !explicitlyExperimental;
  const sufficient = Boolean(explicitlyExperimental || (explicitlyOperational && text(provenance.sourceId) && text(aas.contentHash || aas.sha256)));
  if (!sufficient) issues.push(issue('AAS_PROVENANCE_INSUFFICIENT', 'WARNING', 'AAS origin is not sufficient to classify the document as operational.', { sourceType }));
  return {
    availability: 'AVAILABLE',
    aasId: text(aas.aasId), assetId: text(aas.assetId), version: text(aas.version || aas.aasVersion),
    contentHash: text(aas.contentHash || aas.sha256), sourceType,
    operational: Boolean(explicitlyOperational && sufficient),
    provenanceStatus: sufficient ? 'SUFFICIENT' : 'INSUFFICIENT',
    evidenceLevel: upper(aas.evidenceLevel) || 'DECLARED_ONLY',
    capabilities: sanitizeDeclarations(aas.capabilities, 'CAPABILITY'),
    services: sanitizeDeclarations(aas.services, 'SERVICE'),
  };
}

function projectEvolution(evolution) {
  if (!evolution) return {
    availability: 'NOT_AVAILABLE', status: 'NOT_AVAILABLE', snapshotId: null, comparisonId: null,
    previousSnapshotId: null, functionalHash: null, functionalVersion: null, differences: [], evidenceLevel: 'NOT_AVAILABLE',
  };
  const status = upper(evolution.status);
  return {
    availability: status && VALID_EVOLUTION_STATUS.has(status) ? 'AVAILABLE' : 'NOT_AVAILABLE',
    status: status && VALID_EVOLUTION_STATUS.has(status) ? status : 'NOT_AVAILABLE',
    snapshotId: text(evolution.snapshotId), comparisonId: text(evolution.comparisonId),
    previousSnapshotId: text(evolution.previousSnapshotId), functionalHash: text(evolution.functionalHash),
    functionalVersion: Number.isSafeInteger(evolution.functionalVersion) ? evolution.functionalVersion : null,
    differences: Array.isArray(evolution.differences) ? clone(evolution.differences).filter((item) => ['ADDED', 'REMOVED', 'CHANGED'].includes(upper(item?.type))) : [],
    evidenceLevel: upper(evolution.evidenceLevel) || 'DECLARED_ONLY',
  };
}

/**
 * Builds a sanitized, immutable-by-copy read model. No Store, filesystem,
 * network, lifecycle or governance module is imported or initialized.
 */
export function buildEvolutionCycleReadModel(input = {}) {
  const rawSources = [
    ['cycleAuthority', input.cycleAuthority], ['lifecycle', input.lifecycle], ['governance', input.governance],
    ['plug', input.plug], ['play', input.play], ['evolution', input.evolution],
  ].filter(([, value]) => value != null);
  const sources = rawSources.map(([name, value]) => ({ name, value, identity: identityOf(value) }));
  const authority = identityOf(input.cycleAuthority);
  const issues = [];
  const conflicts = {};
  for (const field of IDENTITY_FIELDS) {
    const candidates = values(sources, field);
    if (candidates.length > 1) {
      conflicts[field] = candidates;
      issues.push(issue('IDENTITY_FIELD_CONFLICT', 'ERROR', `${field} differs between supplied sources.`, { field, candidates }));
    }
  }

  const anyIdentity = sources.some(({ identity }) => IDENTITY_FIELDS.some((field) => identity[field]));
  let identityCorrelationStatus;
  if (Object.keys(conflicts).length) identityCorrelationStatus = IDENTITY_CORRELATION_STATUS.CONFLICT;
  else if (!anyIdentity) identityCorrelationStatus = IDENTITY_CORRELATION_STATUS.UNAVAILABLE;
  else if (!complete(authority)) {
    identityCorrelationStatus = IDENTITY_CORRELATION_STATUS.UNCORRELATED;
    issues.push(issue('AUTHORITATIVE_CYCLE_IDENTITY_REQUIRED', 'WARNING', 'A complete authoritative cycle identity is required for correlation.'));
  } else identityCorrelationStatus = IDENTITY_CORRELATION_STATUS.CORRELATED;

  const lifecycleSources = sources.filter(({ name }) => ['cycleAuthority', 'lifecycle', 'plug', 'play'].includes(name));
  const governanceSources = sources.filter(({ name }) => ['cycleAuthority', 'governance', 'plug', 'play'].includes(name));
  const phase = scalarProjection(lifecycleSources, 'lifecyclePhase', (value) => text(value)?.toLowerCase() || null);
  const cycleState = scalarProjection(lifecycleSources, 'cycleState', upper);
  const governanceStatus = scalarProjection(governanceSources, 'governanceStatus', upper);
  for (const [field, projection] of [['lifecyclePhase', phase], ['cycleState', cycleState], ['governanceStatus', governanceStatus]]) {
    if (projection.value === 'CONFLICT') {
      identityCorrelationStatus = IDENTITY_CORRELATION_STATUS.CONFLICT;
      issues.push(issue('SOURCE_STATE_CONFLICT', 'ERROR', `${field} differs between supplied sources.`, { field, candidates: projection.candidates }));
    }
  }

  const aas = projectAas(input.aas, issues);
  const evolution = projectEvolution(input.evolution);
  const correlatedIdentity = complete(authority) ? authority : Object.fromEntries(IDENTITY_FIELDS.map((field) => [field, values(sources, field)[0] || null]));
  const dataProvenance = rawSources.map(([name, value]) => ({
    source: name,
    sourceType: upper(value?.provenance?.sourceType || value?.sourceType) || 'INJECTED_PROJECTION',
    authoritative: name === 'cycleAuthority',
    operational: value?.provenance?.operational === true || value?.operational === true,
  }));
  if (input.aas) dataProvenance.push({ source: 'aas', sourceType: aas.sourceType, authoritative: false, operational: aas.operational });

  return {
    schemaVersion: EVOLUTION_CYCLE_READ_MODEL_VERSION,
    identity: correlatedIdentity,
    lifecyclePhase: phase.value,
    cycleState: cycleState.value,
    governanceStatus: governanceStatus.value,
    identityCorrelationStatus,
    dataProvenance,
    aas,
    evolution,
    issues,
    sourceEvidence: Object.fromEntries(sources.map(({ name, value, identity }) => [name, {
      identity: clone(identity),
      lifecyclePhase: text(value.lifecyclePhase)?.toLowerCase() || null,
      cycleState: upper(value.cycleState),
      governanceStatus: upper(value.governanceStatus),
      sourceType: upper(value?.provenance?.sourceType || value?.sourceType) || 'INJECTED_PROJECTION',
    }])),
    visualState: {
      identity: identityCorrelationStatus,
      evolution: evolution.status === 'NOT_AVAILABLE' ? 'EVOLUTION_NOT_PROCESSED' : evolution.status,
      capabilities: aas.capabilities.length ? 'DECLARED_ONLY' : 'NOT_AVAILABLE',
    },
  };
}
