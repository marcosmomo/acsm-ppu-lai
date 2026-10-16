import path from 'node:path';
import { GovernanceRepository } from './governanceRepository.mjs';
import { TransactionalGovernanceFacade } from './transactionalGovernanceFacade.mjs';
import { TransactionalGovernanceAdapters } from './transactionalGovernanceAdapters.mjs';
import { requireCycleIdentity, requireCorrelatedLifecycleEvidence } from './cutoverIntegrationContracts.mjs';

function integrationError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

const enabled = (value) => String(value || '').trim().toLowerCase() === 'true';
const clone = (value) => structuredClone(value);
const normalizePhase = (value) => String(value || '').trim().toLowerCase();

export const GOVERNANCE_SHADOW_FLAGS = Object.freeze({
  shadow: 'TRANSACTIONAL_GOVERNANCE_SHADOW_ENABLED',
  writes: 'TRANSACTIONAL_GOVERNANCE_WRITES_ENABLED',
  evolution: 'EVOLUTION_ENABLED',
});

export function resolveGovernanceShadowConfig(env = {}) {
  const shadowEnabled = enabled(env[GOVERNANCE_SHADOW_FLAGS.shadow]);
  const writesRequested = enabled(env[GOVERNANCE_SHADOW_FLAGS.writes]);
  const evolutionRequested = enabled(env[GOVERNANCE_SHADOW_FLAGS.evolution]);
  return Object.freeze({
    mode: shadowEnabled ? 'shadow' : 'disabled',
    shadowEnabled,
    writesEnabled: false,
    writesRequested,
    evolutionEnabled: false,
    evolutionRequested,
    blocked: writesRequested || evolutionRequested,
    blockers: [
      ...(writesRequested ? ['TRANSACTIONAL_WRITES_NOT_AUTHORIZED'] : []),
      ...(evolutionRequested ? ['EVOLUTION_MUST_REMAIN_DISABLED'] : []),
    ],
  });
}

export function projectSnapshotForGovernance(snapshot = {}) {
  const assets = Array.isArray(snapshot?.assets) ? snapshot.assets : [];
  return Object.freeze({
    observations: assets.map((asset) => {
      const cpsId = String(asset?.cps?.cpsId || asset?.cps?.id || asset?.cpsId || asset?.interfaces?.baseTopic || '').trim();
      const lifecyclePhase = normalizePhase(asset?.cps?.lifecyclePhase || asset?.cps?.lifecycle?.currentPhase || asset?.lifecyclePhase);
      const unplugObserved = ['unplug', 'unplugged'].includes(lifecyclePhase);
      return Object.freeze({
        cpsId: cpsId || null,
        lifecyclePhase: lifecyclePhase || null,
        observationOnly: true,
        governanceMutation: null,
        closureStatus: unplugObserved ? 'CORRELATED_UNPLUG_REQUIRED' : 'NO_CLOSE_REQUESTED',
        requiredIdentity: unplugObserved ? ['cpsId', 'plugEventId', 'plugCycleId', 'profileId'] : [],
      });
    }),
    effects: [],
  });
}

export function prepareShadowUnplugCommand({ observation, identity, evidence, expectedRevision } = {}) {
  if (!observation || observation.closureStatus !== 'CORRELATED_UNPLUG_REQUIRED') {
    throw integrationError('GOVERNANCE_UNPLUG_OBSERVATION_REQUIRED', 'An unplugged snapshot observation is required.');
  }
  const correlated = requireCycleIdentity(identity);
  if (observation.cpsId !== correlated.cpsId) {
    throw integrationError('GOVERNANCE_UNPLUG_OBSERVATION_CONFLICT', 'Snapshot CPS differs from the expected cycle.', { observedCpsId: observation.cpsId });
  }
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw integrationError('GOVERNANCE_EXPECTED_REVISION_REQUIRED', 'expectedRevision is required.');
  }
  return Object.freeze({
    ...correlated,
    expectedRevision,
    evidence: requireCorrelatedLifecycleEvidence(correlated, evidence, 'unplug'),
    preparedOnly: true,
    effects: [],
  });
}

function blockedWriter() {
  throw integrationError('GOVERNANCE_SHADOW_WRITE_FORBIDDEN', 'Shadow/read-only composition does not expose governance writers.');
}

export function createGovernanceShadowComposition({
  config = resolveGovernanceShadowConfig(), filePath = null,
  repositoryFactory = (options) => new GovernanceRepository(options),
  facadeFactory = (options) => new TransactionalGovernanceFacade(options),
  adaptersFactory = (options) => new TransactionalGovernanceAdapters(options),
  now,
} = {}) {
  if (!config.shadowEnabled) {
    return Object.freeze({ mode: 'disabled', initialized: false, comparisonStarted: false, repository: null, reader: null, writers: null, blockers: clone(config.blockers || []) });
  }
  if (config.writesRequested || config.evolutionRequested || config.blocked) {
    throw integrationError('GOVERNANCE_SHADOW_CONFIGURATION_BLOCKED', 'Shadow configuration requests a forbidden writer or Evolution capability.', { blockers: config.blockers });
  }
  if (!filePath || !path.isAbsolute(filePath)) {
    throw integrationError('GOVERNANCE_SHADOW_ABSOLUTE_PATH_REQUIRED', 'An explicit absolute candidate Store path is required.');
  }
  const repository = repositoryFactory({ filePath });
  const facade = facadeFactory({ repository, ...(now ? { now } : {}) });
  const adapters = adaptersFactory({ facade });
  const reader = Object.freeze({
    read: () => facade.read(),
    getProfile: (cpsId) => adapters.getProfile(cpsId),
    projectPlayGate: (input) => adapters.projectPlayGate(input),
    listOutbox: () => adapters.listOutbox(),
    listPendingActions: () => adapters.listPendingActions(),
  });
  return Object.freeze({
    mode: 'shadow', initialized: false, comparisonStarted: false,
    repositoryType: repository.constructor?.name || 'InjectedRepository',
    facadeType: facade.constructor?.name || 'InjectedFacade',
    adaptersType: adapters.constructor?.name || 'InjectedAdapters',
    reader,
    writers: Object.freeze({
      reservePlug: blockedWriter, activatePlug: blockedWriter, closeUnplug: blockedWriter,
      approveProfile: blockedWriter, rejectProfile: blockedWriter, updatePolicies: blockedWriter,
      createGovernedAction: blockedWriter, decideGovernedAction: blockedWriter,
      enqueueOutbox: blockedWriter, markOutboxPublished: blockedWriter, markOutboxFailed: blockedWriter,
    }),
    blockers: ['SHADOW_READ_ONLY'],
  });
}
