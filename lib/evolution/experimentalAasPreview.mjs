import artifact from '../../docs/experiments/avm7-cpslai1-functional-projection.json' with { type: 'json' };
import { IDENTITY_CORRELATION_STATUS } from './evolutionCycleReadModel.mjs';

export const EXPERIMENTAL_AAS_PREVIEW_VERSION = 'experimental-aas-cycle-presentation/2.0.0';
export const AAS_CYCLE_PRESENTATION_STATE = Object.freeze({ BOUND: 'BOUND', UNBOUND: 'UNBOUND', UNAVAILABLE: 'UNAVAILABLE' });

const clone = (value) => structuredClone(value);
const text = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;
const IDENTITY_FIELDS = ['cpsId', 'plugEventId', 'plugCycleId', 'profileId'];

function empty(state, cpsId, reason) {
  return {
    schemaVersion: EXPERIMENTAL_AAS_PREVIEW_VERSION,
    state,
    reason,
    cpsId: text(cpsId),
    boundToOperationalPlugCycle: false,
    binding: null,
    aas: null,
    evolution: { status: 'NOT_AVAILABLE' },
  };
}

export function buildExperimentalAasCyclePresentation({ cpsId, binding = null, cycleReadModel = null } = {}) {
  const expectedCpsId = text(cpsId);
  if (!expectedCpsId) return empty(AAS_CYCLE_PRESENTATION_STATE.UNAVAILABLE, null, 'CPS_ID_UNAVAILABLE');
  if (!binding || !cycleReadModel) return empty(AAS_CYCLE_PRESENTATION_STATE.UNBOUND, expectedCpsId, 'AAS_BINDING_NOT_PROVIDED');

  const normalizedBinding = Object.fromEntries([
    ...IDENTITY_FIELDS.map((field) => [field, text(binding[field])]),
    ['aasId', text(binding.aasId)], ['aasHash', text(binding.aasHash)],
    ['aasVersion', text(binding.aasVersion)?.toLowerCase() || null], ['sourceType', text(binding.sourceType)],
    ['correlationStatus', text(binding.correlationStatus)?.toUpperCase() || null],
  ]);
  const complete = [...IDENTITY_FIELDS, 'aasId', 'aasHash', 'aasVersion', 'sourceType', 'correlationStatus']
    .every((field) => normalizedBinding[field]);
  if (!complete || expectedCpsId !== normalizedBinding.cpsId) {
    return empty(AAS_CYCLE_PRESENTATION_STATE.UNBOUND, expectedCpsId, 'AAS_BINDING_REJECTED');
  }
  const correlated = normalizedBinding.correlationStatus === IDENTITY_CORRELATION_STATUS.CORRELATED &&
    cycleReadModel.identityCorrelationStatus === IDENTITY_CORRELATION_STATUS.CORRELATED;
  const identityMatches = IDENTITY_FIELDS.every((field) => normalizedBinding[field] === text(cycleReadModel.identity?.[field]));
  const readModelAasMatches = cycleReadModel.aas?.availability === 'AVAILABLE' &&
    normalizedBinding.aasId === text(cycleReadModel.aas.aasId) &&
    normalizedBinding.aasHash === text(cycleReadModel.aas.contentHash) &&
    normalizedBinding.aasVersion === text(cycleReadModel.aas.version)?.toLowerCase() &&
    normalizedBinding.sourceType.toUpperCase() === text(cycleReadModel.aas.sourceType)?.toUpperCase();
  const source = artifact.versions.find((item) => item.version === normalizedBinding.aasVersion);
  const artifactMatches = source && source.cpsId === normalizedBinding.cpsId && source.aasId === normalizedBinding.aasId &&
    source.sha256 === normalizedBinding.aasHash && source.sourceClassification.toUpperCase() === normalizedBinding.sourceType.toUpperCase();

  if (!correlated || !identityMatches || !readModelAasMatches || !artifactMatches) {
    return empty(AAS_CYCLE_PRESENTATION_STATE.UNBOUND, expectedCpsId, 'AAS_BINDING_REJECTED');
  }
  return clone({
    schemaVersion: EXPERIMENTAL_AAS_PREVIEW_VERSION,
    state: AAS_CYCLE_PRESENTATION_STATE.BOUND,
    reason: 'AAS_BINDING_CORRELATED',
    cpsId: expectedCpsId,
    boundToOperationalPlugCycle: true,
    binding: normalizedBinding,
    aas: {
      version: source.version, aasId: source.aasId, assetId: source.assetId, sha256: source.sha256,
      sourceClassification: source.sourceClassification, capabilities: source.capabilities, services: source.services,
      evidenceLevel: cycleReadModel.aas.evidenceLevel || 'DECLARED_ONLY', physicalValidationClaimed: false,
    },
    evolution: { status: cycleReadModel.evolution?.status || 'NOT_AVAILABLE' },
  });
}
