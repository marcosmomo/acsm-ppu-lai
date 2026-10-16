export const AAS_FUNCTIONAL_CARD_STATES = Object.freeze({
  DOCUMENT_PREVIEW: 'DOCUMENT_PREVIEW',
  BOUND: 'BOUND',
  UNAVAILABLE: 'UNAVAILABLE',
  CONFLICT: 'CONFLICT',
});

const clone = (value) => value == null ? value : structuredClone(value);
const text = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;
const identityFields = ['cpsId', 'plugEventId', 'plugCycleId', 'profileId'];
const conclusiveEvolutionStates = new Set(['BASELINE', 'NO_CHANGE', 'CHANGED', 'INDETERMINATE']);

function unavailable(cpsId, reason = 'AAS_DOCUMENT_UNAVAILABLE') {
  return { state: AAS_FUNCTIONAL_CARD_STATES.UNAVAILABLE, reason, cpsId: text(cpsId), aas: null, binding: null, evolution: { status: 'NOT_AVAILABLE' } };
}

function conflict(cpsId, reason) {
  return { state: AAS_FUNCTIONAL_CARD_STATES.CONFLICT, reason, cpsId: text(cpsId), aas: null, binding: null, evolution: { status: 'NOT_AVAILABLE' } };
}

function validProjection(document) {
  return document?.schemaVersion === 'verifiable-aas-projection/1.0' &&
    text(document.cpsId) && text(document.aasId) && text(document.assetId) &&
    /^[a-f0-9]{64}$/i.test(String(document.contentHash || '')) &&
    text(document.sourceId) && text(document.sourceType) && typeof document.operational === 'boolean' &&
    Array.isArray(document.capabilities) && Array.isArray(document.services);
}

export function buildAasFunctionalCardPresentation({ cpsId, document = null, binding = null, cycleReadModel = null } = {}) {
  const expectedCpsId = text(cpsId);
  if (!expectedCpsId) return unavailable(null, 'CPS_ID_UNAVAILABLE');
  if (!document) return unavailable(expectedCpsId);
  if (!validProjection(document) ||
      String(document.contentHash).toLowerCase() !== String(document.verifiedContentHash || '').toLowerCase()) {
    return conflict(expectedCpsId, 'AAS_DOCUMENT_PROJECTION_INVALID');
  }
  if (document.cpsId !== expectedCpsId) return conflict(expectedCpsId, 'AAS_DOCUMENT_CPS_MISMATCH');

  const aas = {
    cpsId: document.cpsId,
    aasId: document.aasId,
    assetId: document.assetId,
    version: document.version || document.administration?.version || null,
    revision: document.administration?.revision || null,
    contentHash: document.contentHash,
    sourceId: document.sourceId,
    sourceType: document.sourceType,
    evidenceLevel: document.evidenceLevel || 'DECLARED_ONLY',
    capabilities: clone(document.capabilities),
    services: clone(document.services),
  };

  if (!binding || !cycleReadModel) {
    return { state: AAS_FUNCTIONAL_CARD_STATES.DOCUMENT_PREVIEW, reason: 'CYCLE_BINDING_UNAVAILABLE', cpsId: expectedCpsId, aas, binding: null, evolution: { status: 'NOT_AVAILABLE' } };
  }
  if (cycleReadModel.identityCorrelationStatus === 'CONFLICT') return conflict(expectedCpsId, 'CYCLE_IDENTITY_CONFLICT');
  if (cycleReadModel.identityCorrelationStatus !== 'CORRELATED') {
    return { state: AAS_FUNCTIONAL_CARD_STATES.DOCUMENT_PREVIEW, reason: 'CYCLE_IDENTITY_NOT_CORRELATED', cpsId: expectedCpsId, aas, binding: null, evolution: { status: 'NOT_AVAILABLE' } };
  }

  const bindingIdentity = Object.fromEntries(identityFields.map((field) => [field, text(binding[field])]));
  if (identityFields.some((field) => !bindingIdentity[field])) return conflict(expectedCpsId, 'CYCLE_IDENTITY_INCOMPLETE');
  const identityMatches = identityFields.every((field) => bindingIdentity[field] === text(cycleReadModel.identity?.[field]));
  const bindingHash = binding.contentHash || binding.aasHash;
  const aasMatches = binding.aasId === aas.aasId && binding.assetId === aas.assetId &&
    String(bindingHash || '').toLowerCase() === aas.contentHash.toLowerCase() &&
    (binding.aasVersion == null || String(binding.aasVersion) === String(aas.version)) &&
    String(binding.sourceType || '').toUpperCase() === aas.sourceType.toUpperCase();
  const readModelMatches = cycleReadModel.aas?.availability === 'AVAILABLE' &&
    cycleReadModel.aas.aasId === aas.aasId && cycleReadModel.aas.assetId === aas.assetId &&
    String(cycleReadModel.aas.contentHash || '').toLowerCase() === aas.contentHash.toLowerCase() &&
    String(cycleReadModel.aas.sourceType || '').toUpperCase() === aas.sourceType.toUpperCase();
  if (!identityMatches || !aasMatches || !readModelMatches) return conflict(expectedCpsId, 'AAS_CYCLE_CORRELATION_CONFLICT');

  return {
    state: AAS_FUNCTIONAL_CARD_STATES.BOUND,
    reason: 'AUTHORITATIVE_CYCLE_CORRELATION',
    cpsId: expectedCpsId,
    aas,
    binding: { ...bindingIdentity, aasId: aas.aasId, assetId: aas.assetId, aasHash: aas.contentHash, aasVersion: aas.version, sourceType: aas.sourceType },
    evolution: cycleReadModel.evolution?.status === 'NOT_AVAILABLE'
      ? { status: 'NOT_AVAILABLE' }
      : clone(cycleReadModel.evolution || { status: 'NOT_AVAILABLE' }),
  };
}

/**
 * Presents the read-only result of evolutionCycleQuery through the same card
 * projector. The query remains the sole owner of cycle lookup/correlation.
 */
export function buildAasFunctionalCardPresentationFromCycleQuery({ cpsId, projection } = {}) {
  if (!projection) return null;
  const expectedCpsId = text(cpsId);
  const identity = projection.identity || {};
  const aas = projection.aas;
  if (projection.correlationStatus !== 'CORRELATED' || projection.bindingStatus !== 'BOUND' ||
      !expectedCpsId || identity.cpsId !== expectedCpsId ||
      identityFields.some((field) => !text(identity[field])) || !aas) {
    return conflict(expectedCpsId, 'CYCLE_QUERY_PROJECTION_NOT_CORRELATED');
  }
  const queryEvolution = projection.evolution || {};
  const readModelEvolution = projection.readModel?.evolution || {};
  const evolutionStatus = text(readModelEvolution.status)?.toUpperCase();
  if (projection.schemaVersion === 'evolution-cycle-query/1.0.0' && conclusiveEvolutionStates.has(evolutionStatus) && (
      projection.evolutionStatus !== evolutionStatus ||
      text(queryEvolution.snapshotId) !== text(readModelEvolution.snapshotId) ||
      text(queryEvolution.comparisonId) !== text(readModelEvolution.comparisonId) ||
      String(queryEvolution.functionalHash || '') !== String(readModelEvolution.functionalHash || '')
  )) {
    return conflict(expectedCpsId, 'EVOLUTION_QUERY_PROJECTION_CONFLICT');
  }

  const document = {
    ...clone(aas),
    schemaVersion: 'verifiable-aas-projection/1.0',
    cpsId: expectedCpsId,
    verifiedContentHash: aas.contentHash,
  };
  const binding = {
    ...identity,
    aasId: aas.aasId,
    assetId: aas.assetId,
    contentHash: aas.contentHash,
    aasVersion: aas.version,
    sourceType: aas.sourceType,
  };
  return buildAasFunctionalCardPresentation({
    cpsId: expectedCpsId,
    document,
    binding,
    cycleReadModel: projection.readModel,
  });
}

const declaredValue = (attribute) => attribute?.value ?? null;

function changedAttributes(difference) {
  const before = difference?.before?.attributes || {};
  const current = difference?.current?.attributes || {};
  return [...new Set([...Object.keys(before), ...Object.keys(current)])]
    .filter((name) => JSON.stringify(before[name] ?? null) !== JSON.stringify(current[name] ?? null))
    .map((name) => ({ name, before: declaredValue(before[name]), current: declaredValue(current[name]) }));
}

/** Maps comparator output to compact UI data; it never compares AAS documents. */
export function buildFunctionalChangesPresentation(evolution = null) {
  const status = text(evolution?.status)?.toUpperCase();
  if (!conclusiveEvolutionStates.has(status)) return null;
  if (status === 'BASELINE') return { status, message: 'First known functional configuration.', differences: [] };
  if (status === 'NO_CHANGE') return { status, message: 'No functional differences identified.', differences: [] };
  if (status === 'INDETERMINATE') return { status, message: 'Evidence does not allow a reliable functional comparison.', differences: [] };

  const differences = (Array.isArray(evolution?.differences) ? evolution.differences : [])
    .filter((difference) => ['ADDED', 'REMOVED', 'CHANGED'].includes(String(difference?.type || '').toUpperCase()))
    .map((difference) => {
      const type = String(difference.type).toUpperCase();
      const declaration = type === 'REMOVED' ? difference.before : difference.current;
      return {
        type,
        identity: text(difference.identity),
        name: text(declaration?.name) || text(difference.current?.name) || text(difference.before?.name) || 'Unnamed declaration',
        kind: text(declaration?.kind) || 'FUNCTIONAL_DECLARATION',
        attributes: type === 'CHANGED' ? changedAttributes(difference) : [],
      };
    });
  return { status, message: differences.length ? null : 'No detailed functional differences were supplied.', differences };
}
