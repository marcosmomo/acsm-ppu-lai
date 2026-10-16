import { coordinateAcceptedPlugEvolution } from './evolutionCoordinator.mjs';
import { createEvolutionCycleQuery } from './evolutionCycleQuery.mjs';

export const ACCEPTED_CYCLE_AAS_BINDING_VERSION = 'accepted-cycle-aas-binding/1.0.0';

const clone = (value) => value == null ? value : structuredClone(value);
const text = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;
const REQUIRED_AAS_FIELDS = ['aasReferenceId', 'aasId', 'assetId', 'contentHash', 'sourceId', 'sourceType', 'functionalHash'];

function compositionError(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function freezeIdentity(cpsId, referenceId, resolved) {
  const identity = {
    aasReferenceId: referenceId,
    aasId: resolved.aasId,
    assetId: resolved.assetId,
    contentHash: resolved.contentHash,
    sourceId: resolved.sourceId,
    sourceType: resolved.sourceType,
    aasVersion: resolved.version || null,
    aasRevision: resolved.administration?.revision || null,
    functionalHash: resolved.functionalHash,
  };
  if (REQUIRED_AAS_FIELDS.some((field) => !text(identity[field]))) {
    throw compositionError('ACCEPTED_AAS_IDENTITY_INCOMPLETE', 'Resolved AAS identity is incomplete.');
  }
  if (resolved.cpsId !== cpsId) throw compositionError('ACCEPTED_AAS_CPS_MISMATCH', 'Resolved AAS belongs to a different CPS.');
  if (!resolved.archiveReference?.contentHash || resolved.archiveReference.contentHash !== resolved.contentHash) {
    throw compositionError('ACCEPTED_AAS_ARCHIVE_REQUIRED', 'A content-addressed archive reference matching the verified AAS is required.');
  }
  return Object.freeze(identity);
}

function exactCycleRecord(adapters, requested) {
  const document = adapters.facade.read().document;
  const cycle = document.plugCycles?.[requested.plugCycleId];
  if (!cycle) return { document, cycle: null, profile: null };
  const profile = (document.profileVersions?.[requested.cpsId] || []).find((item) =>
    item?.profileId === cycle.governanceProfileId && item?.plugCycleId === cycle.plugCycleId && item?.plugEventId === cycle.plugEventId) || null;
  return { document, cycle: clone(cycle), profile: clone(profile) };
}

function assertAcceptedCycle(cycle, profile, binding) {
  if (!cycle || !profile || cycle.state !== 'ACTIVE' || cycle.checkpoints?.lifecycleTransitioned !== true ||
      !cycle.activationEvidence || profile.status !== 'PENDING_APPROVAL' && profile.status !== 'APPROVED') {
    throw compositionError('ACCEPTED_CYCLE_REQUIRED', 'Cycle must be accepted by transactional lifecycle authority before AAS binding.');
  }
  if (cycle.cpsId !== binding.cpsId || cycle.plugEventId !== binding.plugEventId ||
      cycle.plugCycleId !== binding.plugCycleId || cycle.governanceProfileId !== binding.profileId ||
      profile.profileId !== binding.profileId || profile.plugCycleId !== binding.plugCycleId) {
    throw compositionError('ACCEPTED_CYCLE_IDENTITY_CONFLICT', 'Cycle, event and governance profile identities do not match.');
  }
  const reference = cycle.aasReference;
  const expectedReference = {
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
  };
  if (!reference || Object.entries(expectedReference).some(([field, value]) => (reference[field] ?? null) !== value)) {
    throw compositionError('ACCEPTED_CYCLE_AAS_REFERENCE_CONFLICT', 'Accepted cycle does not retain its exact correlated AAS reference.');
  }
  for (const field of REQUIRED_AAS_FIELDS) {
    if (cycle.identity?.[field] !== binding[field]) {
      throw compositionError('ACCEPTED_CYCLE_AAS_IDENTITY_CONFLICT', `Accepted cycle does not retain the exact AAS field ${field}.`, { field });
    }
  }
}

/**
 * Isolated composition over injected authority, AAS source/archive and Evolution
 * Store. The accepted cycle record is the sole owner of the frozen AAS identity;
 * this class creates no binding Store and never accesses operational routes.
 */
export class AcceptedCycleAasComposition {
  constructor({ adapters, orchestrator, aasSource, evolutionStore, coordinate = coordinateAcceptedPlugEvolution, now = () => new Date() } = {}) {
    const repository = adapters?.facade?.repository;
    if (!repository || repository !== orchestrator?.lifecycleAuthority?.repository ||
        repository !== orchestrator?.evidenceRepository?.repository || adapters !== orchestrator?.adapters) {
      throw compositionError('ACCEPTED_CYCLE_SHARED_AUTHORITY_REQUIRED', 'Adapters, lifecycle authority and evidence must share the same injected transactional repository.');
    }
    if (typeof aasSource?.resolve !== 'function' || typeof evolutionStore?.inspect !== 'function' || typeof coordinate !== 'function') {
      throw compositionError('ACCEPTED_CYCLE_DEPENDENCIES_REQUIRED', 'Verified AAS source, Evolution Store and coordinator are required.');
    }
    this.adapters = adapters;
    this.orchestrator = orchestrator;
    this.aasSource = aasSource;
    this.evolutionStore = evolutionStore;
    this.coordinate = coordinate;
    this.now = now;
    this.readService = createEvolutionCycleQuery({
      cycleProvider: { readCycle: ({ cpsId, plugCycleId }) => exactCycleRecord(this.adapters, { cpsId, plugCycleId }) },
      aasSource: this.aasSource,
      evolutionProvider: this.evolutionStore,
      allowExperimentalSources: true,
    });
  }

  async acceptPlug({ cpsId, plugEventId, aasReferenceId, previousState = null } = {}) {
    const key = text(cpsId)?.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!key || !text(plugEventId) || !text(aasReferenceId)) {
      throw compositionError('ACCEPTED_CYCLE_PLUG_INPUT_REQUIRED', 'cpsId, plugEventId and authorized aasReferenceId are required.');
    }
    const resolved = await this.aasSource.resolve({ referenceId: aasReferenceId, cpsId: key });
    const aasIdentity = freezeIdentity(key, aasReferenceId, resolved);
    const plug = this.orchestrator.plug({
      cpsId: key,
      plugEventId,
      previousState,
      identity: aasIdentity,
    });
    const binding = Object.freeze({
      schemaVersion: ACCEPTED_CYCLE_AAS_BINDING_VERSION,
      cpsId: plug.cpsId,
      plugEventId: plug.plugEventId,
      plugCycleId: plug.plugCycleId,
      profileId: plug.profileId,
      aasId: resolved.aasId,
      assetId: resolved.assetId,
      contentHash: resolved.contentHash,
      functionalHash: resolved.functionalHash,
      sourceId: resolved.sourceId,
      sourceType: resolved.sourceType,
      aasVersion: resolved.version || null,
      aasRevision: resolved.administration?.revision || null,
      aasReferenceId,
      acceptedCycleState: plug.cycleState,
      bindingCreatedAfterAcceptance: true,
    });
    const { cycle, profile } = exactCycleRecord(this.adapters, binding);
    assertAcceptedCycle(cycle, profile, binding);

    const evolution = await this.coordinate({
      cpsId: binding.cpsId,
      plugEventId: binding.plugEventId,
      plugCycleId: binding.plugCycleId,
      resolvedAas: {
        functionalSnapshot: resolved.functionalSnapshot,
        identity: { cpsId: resolved.cpsId, aasId: resolved.aasId, assetId: resolved.assetId, version: resolved.version },
        integrity: { contentHash: resolved.contentHash },
        archiveReference: resolved.archiveReference,
        provenance: { sourceId: resolved.sourceId, sourceType: resolved.sourceType, operational: resolved.operational },
        evidenceScope: 'VERIFIED_DECLARED_FUNCTIONS',
        resolvedAt: this.now().toISOString(),
      },
      store: this.evolutionStore,
      plugAccepted: true,
      capturedAt: this.now(),
      provenance: { experiment: 'INT-EVO-8', simulation: true, operational: false },
    });
    return { binding, plug, evolution, projection: await this.readCycle(binding) };
  }

  approveWithFixture(binding, authorization) {
    if (!binding?.bindingCreatedAfterAcceptance || binding.acceptedCycleState !== 'ACTIVE') {
      throw compositionError('ACCEPTED_CYCLE_REQUIRED', 'Only an accepted cycle can receive a governance decision.');
    }
    return this.adapters.approveProfile({ ...binding, authorization });
  }

  playGate(binding) {
    return this.adapters.projectPlayGate({ ...binding, lifecyclePhase: 'play' });
  }

  async unplug(binding) {
    const before = await this.evolutionStore.inspect();
    const result = this.orchestrator.unplug(binding);
    const after = await this.evolutionStore.inspect();
    if (Object.keys(before.comparisons || {}).length !== Object.keys(after.comparisons || {}).length) {
      throw compositionError('ACCEPTED_CYCLE_UNPLUG_EVOLUTION_FORBIDDEN', 'Unplug must not create an Evolution comparison.');
    }
    return result;
  }

  async readCycle(requested = {}) {
    const key = text(requested.cpsId)?.toLowerCase().replace(/[^a-z0-9]/g, '');
    const result = await this.readService.query({
      cpsId: key,
      plugCycleId: requested.plugCycleId,
      expectedIdentity: requested,
    });
    return {
      ...result,
      binding: result.bindingStatus === 'BOUND' ? {
        schemaVersion: ACCEPTED_CYCLE_AAS_BINDING_VERSION,
        ...result.identity,
        aasId: result.aas.aasId,
        assetId: result.aas.assetId,
        contentHash: result.aas.contentHash,
        functionalHash: null,
        sourceId: result.aas.sourceId,
        sourceType: result.aas.sourceType,
        aasVersion: result.aas.version,
        aasRevision: result.aas.revision,
        aasReferenceId: result.aas.referenceId,
        bindingCreatedAfterAcceptance: true,
      } : null,
      history: {
        snapshotId: result.evolution.snapshotId || null,
        comparisonId: result.evolution.comparisonId || null,
        previousSnapshotId: result.evolution.previousSnapshotId || null,
      },
    };
  }
}
