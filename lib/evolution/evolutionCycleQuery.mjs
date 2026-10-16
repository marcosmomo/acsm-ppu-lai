import { buildEvolutionCycleReadModel } from './evolutionCycleReadModel.mjs';
import { buildAasFunctionalCardPresentation } from './aasFunctionalCardPresentation.mjs';

export const EVOLUTION_CYCLE_QUERY_VERSION = 'evolution-cycle-query/1.0.0';
const text = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;
const clone = (value) => value == null ? value : structuredClone(value);
const identityFields = ['cpsId', 'plugEventId', 'plugCycleId', 'profileId'];
const aasIdentityFields = ['aasReferenceId', 'aasId', 'assetId', 'contentHash', 'sourceId', 'sourceType', 'functionalHash'];
const optionalAasIdentityFields = ['aasVersion', 'aasRevision'];
const conflictCodes = new Set(['AAS_CONTENT_HASH_MISMATCH', 'AAS_EXPECTED_HASH_MISMATCH', 'AAS_IDENTITY_MISMATCH', 'AAS_REFERENCE_NOT_AUTHORIZED']);

function emptyProjection(cpsId, status, reason) {
  const readModel = buildEvolutionCycleReadModel();
  return {
    schemaVersion: EVOLUTION_CYCLE_QUERY_VERSION,
    status,
    correlationStatus: status === 'CONFLICT' ? 'CONFLICT' : status === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'UNCORRELATED',
    bindingStatus: status === 'UNBOUND' ? 'UNBOUND' : status === 'CONFLICT' ? 'CONFLICT' : 'UNAVAILABLE',
    evolutionStatus: 'EVOLUTION_NOT_PROCESSED',
    identity: Object.fromEntries(identityFields.map((field) => [field, null])),
    aas: null,
    evolution: { status: 'EVOLUTION_NOT_PROCESSED', differences: [], evidenceLevel: 'NOT_AVAILABLE' },
    evidenceLevel: 'NOT_AVAILABLE',
    issues: reason ? [{ code: reason }] : [],
    readModel,
    card: buildAasFunctionalCardPresentation({ cpsId }),
  };
}

function fail(cpsId, status, reason) {
  return emptyProjection(cpsId, status, reason);
}

function cycleFailure(cpsId, identity, cycle, status, reason, correlationOverride = null, counterpartIdentity = null) {
  const base = emptyProjection(cpsId, status, reason);
  const correlationStatus = correlationOverride || (status === 'CONFLICT' ? 'CONFLICT' : 'CORRELATED');
  const cycleProjection = cycle ? {
    state: cycle.state || 'UNAVAILABLE',
    lifecyclePhase: cycle.state === 'CLOSED' ? 'unplug' : 'plug',
    governanceStatus: null,
  } : null;
  const readModel = buildEvolutionCycleReadModel({
    cycleAuthority: { identity, lifecyclePhase: cycleProjection?.lifecyclePhase, cycleState: cycleProjection?.state, sourceType: 'TRANSACTIONAL_CYCLE_AUTHORITY' },
    ...(counterpartIdentity ? { governance: { identity: counterpartIdentity } } : {}),
  });
  return {
    ...base,
    correlationStatus,
    bindingStatus: status === 'CONFLICT' ? 'CONFLICT' : status === 'UNBOUND' ? 'UNBOUND' : 'UNAVAILABLE',
    identity: clone(identity),
    cycle: cycleProjection,
    readModel,
    card: status === 'CONFLICT'
      ? { state: 'CONFLICT', reason, cpsId, aas: null, binding: null, evolution: { status: 'NOT_AVAILABLE' } }
      : { state: 'UNAVAILABLE', reason, cpsId, aas: null, binding: null, evolution: { status: 'NOT_AVAILABLE' } },
  };
}

function identityConflict(cpsId, identity, expectedIdentity) {
  const base = emptyProjection(cpsId, 'CONFLICT', 'REQUESTED_CYCLE_IDENTITY_CONFLICT');
  const requested = Object.fromEntries(identityFields.map((field) => [field, text(expectedIdentity?.[field]) || identity[field]]));
  const readModel = buildEvolutionCycleReadModel({
    cycleAuthority: { identity, lifecyclePhase: 'plug', cycleState: 'ACTIVE', governanceStatus: 'UNAVAILABLE' },
    governance: { identity: requested, governanceStatus: 'UNAVAILABLE' },
  });
  return {
    ...base,
    identity: clone(identity),
    readModel,
    card: { state: 'CONFLICT', reason: 'CYCLE_IDENTITY_CONFLICT', cpsId, aas: null, binding: null, evolution: { status: 'NOT_AVAILABLE' } },
  };
}

function findEvolution(document, identity, contentHash) {
  const snapshots = Object.values(document?.snapshots || {}).filter((item) =>
    item.cpsId === identity.cpsId && item.plugEventId === identity.plugEventId && item.plugCycleId === identity.plugCycleId);
  const comparisons = Object.values(document?.comparisons || {}).filter((item) =>
    item.cpsId === identity.cpsId && item.plugEventId === identity.plugEventId && item.plugCycleId === identity.plugCycleId);
  if (snapshots.length > 1 || comparisons.length > 1 || snapshots.length !== comparisons.length) {
    return { conflict: 'EVOLUTION_RECORD_NOT_UNIQUE', value: null };
  }
  if (!snapshots.length) return { conflict: null, value: null };
  const snapshot = snapshots[0];
  const comparison = comparisons[0];
  if (snapshot.aasReference?.contentHash !== contentHash || comparison.aasReference?.contentHash !== contentHash ||
      snapshot.snapshotId !== comparison.currentSnapshotId || snapshot.plugCycleId !== identity.plugCycleId ||
      comparison.plugCycleId !== identity.plugCycleId) {
    return { conflict: 'EVOLUTION_AAS_OR_CYCLE_MISMATCH', value: null };
  }
  return {
    conflict: null,
    value: {
      status: comparison.status,
      snapshotId: snapshot.snapshotId,
      comparisonId: comparison.comparisonId,
      previousSnapshotId: snapshot.previousSnapshotId,
      functionalHash: snapshot.functionalHash,
      functionalVersion: snapshot.functionalVersion,
      differences: clone(comparison.differences || []),
      evidenceLevel: 'DECLARED_ONLY',
    },
  };
}

function toReadModelAas(resolved) {
  return {
    aasId: resolved.aasId, assetId: resolved.assetId, version: resolved.version,
    contentHash: resolved.contentHash, sourceType: resolved.sourceType,
    operational: resolved.operational, evidenceLevel: resolved.evidenceLevel,
    provenance: { sourceId: resolved.sourceId, sourceType: resolved.sourceType, operational: resolved.operational, experimental: resolved.sourceType.includes('EXPERIMENTAL') },
    capabilities: resolved.capabilities, services: resolved.services,
  };
}

/**
 * Query-only projection over injected providers. Providers must expose reads;
 * AAS resolution explicitly disables archive writes and Evolution is inspected,
 * never calculated. No filesystem, Store or operational module is imported.
 */
export function createEvolutionCycleQuery({ cycleProvider, aasSource, evolutionProvider, allowExperimentalSources = false } = {}) {
  if (typeof cycleProvider?.readCycle !== 'function' || typeof aasSource?.resolve !== 'function' ||
      typeof evolutionProvider?.inspect !== 'function') {
    throw new TypeError('Cycle, verified AAS and Evolution read providers are required.');
  }

  return Object.freeze({
    async query({ cpsId, plugCycleId, expectedIdentity = null } = {}) {
      const key = text(cpsId)?.toLowerCase().replace(/[^a-z0-9]/g, '') || null;
      const cycleId = text(plugCycleId);
      if (!key || !cycleId) return fail(key, 'UNAVAILABLE', 'CYCLE_QUERY_IDENTITY_REQUIRED');

      let record;
      try { record = await cycleProvider.readCycle({ cpsId: key, plugCycleId: cycleId }); }
      catch (error) { return fail(key, 'UNAVAILABLE', error?.code || 'CYCLE_SOURCE_UNAVAILABLE'); }
      const cycle = record?.cycle;
      const profile = record?.profile;
      if (!cycle) return fail(key, 'UNAVAILABLE', 'CYCLE_NOT_FOUND_OR_UNAVAILABLE');
      if (cycle.cpsId !== key || cycle.plugCycleId !== cycleId) return fail(key, 'CONFLICT', 'CYCLE_AUTHORITY_IDENTITY_CONFLICT');
      const cycleIdentity = {
        cpsId: cycle.cpsId, plugEventId: cycle.plugEventId,
        plugCycleId: cycle.plugCycleId, profileId: cycle.governanceProfileId || null,
      };
      if (!profile || cycle.governanceProfileId !== profile.profileId || profile.plugCycleId !== cycle.plugCycleId ||
          profile.plugEventId !== cycle.plugEventId || (profile.cpsId && profile.cpsId !== key) || !text(profile.status)) {
        const profileIdentity = profile ? {
          cpsId: profile.cpsId || key, plugEventId: profile.plugEventId || null,
          plugCycleId: profile.plugCycleId || null, profileId: profile.profileId || null,
        } : null;
        return cycleFailure(key, cycleIdentity, cycle, profile ? 'CONFLICT' : 'UNAVAILABLE', 'CYCLE_GOVERNANCE_PROFILE_MISMATCH', profile ? 'CONFLICT' : 'UNAVAILABLE', profileIdentity);
      }
      if (!['ACTIVE', 'CLOSED'].includes(cycle.state) || cycle.checkpoints?.lifecycleTransitioned !== true || !cycle.activationEvidence) {
        return cycleFailure(key, cycleIdentity, cycle, 'UNBOUND', 'CYCLE_NOT_ACCEPTED_BY_LIFECYCLE_AUTHORITY');
      }

      const identity = { ...cycleIdentity, profileId: profile.profileId };
      if (expectedIdentity && identityFields.some((field) => text(expectedIdentity[field]) && text(expectedIdentity[field]) !== identity[field])) {
        return identityConflict(key, identity, expectedIdentity);
      }
      const frozenAas = cycle.aasReference ? {
        aasReferenceId: cycle.aasReference.referenceId,
        aasId: cycle.aasReference.aasId,
        assetId: cycle.aasReference.assetId,
        contentHash: cycle.aasReference.contentHash,
        sourceId: cycle.aasReference.sourceId,
        sourceType: cycle.aasReference.sourceType,
        aasVersion: cycle.aasReference.version ?? null,
        aasRevision: cycle.aasReference.revision ?? null,
        functionalHash: cycle.identity?.functionalHash ?? null,
      } : cycle.identity || {};
      if (aasIdentityFields.some((field) => !text(frozenAas[field]))) return cycleFailure(key, identity, cycle, 'UNBOUND', 'AAS_REFERENCE_NOT_FROZEN_IN_CYCLE');
      if (!allowExperimentalSources && String(frozenAas.sourceType).toUpperCase().includes('EXPERIMENTAL')) {
        return cycleFailure(key, identity, cycle, 'UNBOUND', 'EXPERIMENTAL_AAS_NOT_OPERATIONAL');
      }

      let resolved;
      try {
        resolved = await aasSource.resolve({
          referenceId: frozenAas.aasReferenceId, cpsId: key, aasId: frozenAas.aasId,
          assetId: frozenAas.assetId, contentHash: frozenAas.contentHash,
        }, { archive: false });
      } catch (error) {
        const status = conflictCodes.has(error?.code) ? 'CONFLICT' : 'UNAVAILABLE';
        return cycleFailure(key, identity, cycle, status, error?.code || 'AAS_SOURCE_UNAVAILABLE');
      }
      const resolvedIdentity = {
        ...resolved,
        aasReferenceId: resolved?.referenceId,
        aasVersion: resolved?.version || null,
        aasRevision: resolved?.administration?.revision || null,
      };
      const mismatch = [...aasIdentityFields, ...optionalAasIdentityFields]
        .some((field) => text(resolvedIdentity[field]) !== text(frozenAas[field]));
      if (!resolved || mismatch || resolved.cpsId !== key || resolved.contentHash !== frozenAas.contentHash) {
        return cycleFailure(key, identity, cycle, 'CONFLICT', 'RESOLVED_AAS_DIFFERS_FROM_FROZEN_CYCLE_IDENTITY');
      }

      let evolutionDocument;
      let evolutionSourceUnavailable = false;
      try { evolutionDocument = await evolutionProvider.inspect(); }
      catch (error) { evolutionDocument = null; evolutionSourceUnavailable = true; }
      const evolutionResult = findEvolution(evolutionDocument, identity, frozenAas.contentHash);
      const evolution = evolutionResult.value;
      const lifecyclePhase = cycle.state === 'CLOSED' ? 'unplug' : 'plug';
      const readModel = buildEvolutionCycleReadModel({
        cycleAuthority: { identity, lifecyclePhase, cycleState: cycle.state, governanceStatus: profile.status, sourceType: 'TRANSACTIONAL_CYCLE_AUTHORITY' },
        lifecycle: { identity, lifecyclePhase, cycleState: cycle.state },
        governance: { identity, governanceStatus: profile.status },
        aas: toReadModelAas(resolved),
        evolution,
      });
      if (expectedIdentity && readModel.identityCorrelationStatus !== 'CONFLICT' && readModel.identityCorrelationStatus !== 'CORRELATED') {
        return fail(key, 'CONFLICT', 'CYCLE_SOURCES_NOT_CORRELATED');
      }
      const binding = {
        ...identity,
        aasId: resolved.aasId,
        assetId: resolved.assetId,
        contentHash: resolved.contentHash,
        aasVersion: resolved.version || null,
        aasRevision: resolved.administration?.revision || null,
        sourceType: resolved.sourceType,
      };
      const card = buildAasFunctionalCardPresentation({
        cpsId: key,
        document: { ...resolved, verifiedContentHash: resolved.contentHash },
        binding,
        cycleReadModel: readModel,
      });
      const correlationStatus = readModel.identityCorrelationStatus;
      const evolutionStatus = evolutionSourceUnavailable ? 'UNAVAILABLE' : evolutionResult.conflict ? 'CONFLICT' : evolution?.status || 'EVOLUTION_NOT_PROCESSED';
      const aasProjection = {
        referenceId: resolved.referenceId,
        aasId: resolved.aasId, assetId: resolved.assetId, version: resolved.version || null,
        contentHash: resolved.contentHash, sourceId: resolved.sourceId, sourceType: resolved.sourceType,
        operational: resolved.operational === true, capabilities: clone(resolved.capabilities),
        services: clone(resolved.services), evidenceLevel: resolved.evidenceLevel || 'DECLARED_ONLY',
        revision: resolved.administration?.revision || null,
      };
      return {
        schemaVersion: EVOLUTION_CYCLE_QUERY_VERSION,
        status: card.state === 'BOUND' && correlationStatus === 'CORRELATED' ? 'CORRELATED' : correlationStatus,
        correlationStatus,
        bindingStatus: card.state === 'BOUND' ? 'BOUND' : card.state === 'CONFLICT' ? 'CONFLICT' : 'UNBOUND',
        evolutionStatus,
        identity: clone(identity),
        aas: aasProjection,
        evolution: evolution ? clone(evolution) : { status: evolutionStatus, differences: [], evidenceLevel: 'NOT_AVAILABLE' },
        evidenceLevel: aasProjection.evidenceLevel,
        cycle: { state: cycle.state, lifecyclePhase, governanceStatus: profile.status },
        issues: [evolutionResult.conflict, !evolutionDocument ? 'EVOLUTION_SOURCE_UNAVAILABLE' : null].filter(Boolean).map((code) => ({ code })),
        readModel,
        card,
      };
    },
  });
}
