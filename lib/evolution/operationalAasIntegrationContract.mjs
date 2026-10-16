export const OPERATIONAL_AAS_INTEGRATION_CONTRACT_VERSION = 'operational-aas-integration/1.0.0';

const clone = (value) => value == null ? value : structuredClone(value);
const text = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;
const identityFields = ['cpsId', 'plugEventId', 'plugCycleId', 'profileId'];
const aasFields = ['aasId', 'assetId', 'contentHash', 'sourceId', 'sourceType'];

function contractError(code, message) {
  return Object.assign(new Error(message), { code });
}

function assertOperationalBinding(binding) {
  if (binding?.schemaVersion !== 'accepted-cycle-aas-binding/1.0.0' ||
      binding.bindingCreatedAfterAcceptance !== true || binding.acceptedCycleState !== 'ACTIVE' ||
      identityFields.some((field) => !text(binding[field])) ||
      aasFields.some((field) => !text(binding[field])) || !text(binding.aasReferenceId) ||
      !/^[a-f0-9]{64}$/i.test(String(binding.contentHash || ''))) {
    throw contractError('OPERATIONAL_AAS_BINDING_INVALID', 'An accepted cycle with complete frozen AAS identity is required.');
  }
  if (String(binding.sourceType).toUpperCase().includes('EXPERIMENTAL')) {
    throw contractError('EXPERIMENTAL_AAS_OPERATIONAL_BINDING_FORBIDDEN', 'Experimental AAS sources cannot satisfy the operational integration contract.');
  }
}

/**
 * Builds an additive response envelope from an already accepted transactional
 * composition result. It performs no Plug, Evolution, Store or network action.
 */
export function buildAcceptedPlugAasEnvelope({ operationalResponse = {}, acceptedResult } = {}) {
  const binding = acceptedResult?.binding;
  const projection = acceptedResult?.projection;
  assertOperationalBinding(binding);
  if (acceptedResult?.plug?.governanceStatus !== 'PENDING_APPROVAL') {
    throw contractError('PENDING_APPROVAL_PROFILE_REQUIRED', 'Accepted Plug must retain its own PENDING_APPROVAL profile.');
  }
  if (projection?.correlationStatus !== 'CORRELATED' || projection?.bindingStatus !== 'BOUND' ||
      identityFields.some((field) => projection.identity?.[field] !== binding[field]) ||
      projection.aas?.referenceId !== binding.aasReferenceId ||
      aasFields.some((field) => projection.aas?.[field] !== binding[field]) ||
      projection.aas?.operational !== true) {
    throw contractError('ACCEPTED_PLUG_PROJECTION_CONFLICT', 'Cycle query projection does not match the accepted operational AAS binding.');
  }
  const existingProfile = operationalResponse?.activeProfile;
  if (existingProfile && (existingProfile.profileId !== binding.profileId ||
      existingProfile.plugCycleId !== binding.plugCycleId ||
      existingProfile.plugEventId !== binding.plugEventId)) {
    throw contractError('OPERATIONAL_RESPONSE_PROFILE_CONFLICT', 'Existing response profile differs from the accepted cycle identity.');
  }

  return {
    ...clone(operationalResponse),
    aasIntegration: {
      schemaVersion: OPERATIONAL_AAS_INTEGRATION_CONTRACT_VERSION,
      status: 'CORRELATED',
      binding: {
        cpsId: binding.cpsId,
        plugEventId: binding.plugEventId,
        plugCycleId: binding.plugCycleId,
        profileId: binding.profileId,
        referenceId: binding.aasReferenceId,
        aasId: binding.aasId,
        assetId: binding.assetId,
        contentHash: binding.contentHash,
        sourceId: binding.sourceId,
        sourceType: binding.sourceType,
        version: binding.aasVersion ?? null,
        revision: binding.aasRevision ?? null,
      },
      projection: clone(projection),
    },
  };
}

export function buildAasCardQueryRequest({ cpsId, plugCycleId } = {}) {
  const key = text(cpsId)?.toLowerCase().replace(/[^a-z0-9]/g, '') || null;
  const cycleId = text(plugCycleId);
  if (!key || !cycleId) throw contractError('AAS_CARD_QUERY_IDENTITY_REQUIRED', 'cpsId and exact plugCycleId are required.');
  return { cpsId: key, plugCycleId: cycleId };
}

/** Validates a read-only evolutionCycleQuery response for the requested cycle. */
export function buildAasCardQueryEnvelope({ request, projection } = {}) {
  const exact = buildAasCardQueryRequest(request);
  const allowed = new Set(['CORRELATED', 'UNBOUND', 'UNAVAILABLE', 'CONFLICT']);
  if (!projection || !allowed.has(projection.correlationStatus)) {
    throw contractError('AAS_CARD_QUERY_RESPONSE_INVALID', 'Unsupported cycle query response.');
  }
  if (projection.correlationStatus === 'CORRELATED' &&
      (projection.identity?.cpsId !== exact.cpsId || projection.identity?.plugCycleId !== exact.plugCycleId)) {
    throw contractError('AAS_CARD_QUERY_CYCLE_CONFLICT', 'Projection belongs to another cycle.');
  }
  return {
    schemaVersion: OPERATIONAL_AAS_INTEGRATION_CONTRACT_VERSION,
    request: exact,
    status: projection.correlationStatus,
    bindingStatus: projection.bindingStatus,
    evolutionStatus: projection.evolutionStatus || 'EVOLUTION_NOT_PROCESSED',
    projection: clone(projection),
  };
}
