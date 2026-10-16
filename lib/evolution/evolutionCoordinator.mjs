import { buildFunctionalSnapshot } from './functionalNormalizer.mjs';
import { compareFunctionalSnapshots } from './functionalComparator.mjs';

export const EVOLUTION_COORDINATOR_VERSION = 'evolution-coordinator/1.0.0';

const normalizeCpsId = (value) => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '')
  .replace(/^cpslai0+([123])$/, 'cpslai$1');
const supportedCps = new Set(['cpslai1', 'cpslai2', 'cpslai3']);

function coordinatorError(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function validateStore(store) {
  const methods = ['recordPending', 'recordFailure', 'recordCapture', 'getAcceptedBaseline'];
  if (!store || methods.some((method) => typeof store[method] !== 'function')) {
    throw coordinatorError('EVOLUTION_STORE_REQUIRED', 'An injected Evolution Store instance is required.');
  }
}

function validateInput({ cpsId, plugEventId, plugCycleId, aas, functionalSnapshot, store, plugAccepted }) {
  const normalizedCpsId = normalizeCpsId(cpsId);
  if (!supportedCps.has(normalizedCpsId)) {
    throw coordinatorError('EVOLUTION_CPS_UNSUPPORTED', 'Coordinator accepts only CPS-LAI-01, CPS-LAI-02 and CPS-LAI-03.');
  }
  if (!String(plugEventId || '').trim()) {
    throw coordinatorError('EVOLUTION_PLUG_EVENT_REQUIRED', 'plugEventId is required.');
  }
  if (!String(plugCycleId || '').trim()) {
    throw coordinatorError('EVOLUTION_PLUG_CYCLE_REQUIRED', 'plugCycleId is required.');
  }
  if (plugAccepted !== true) {
    throw coordinatorError(
      'EVOLUTION_ACCEPTED_PLUG_REQUIRED',
      'Evolution capture requires an explicit accepted Plug context; an AAS alone is insufficient.',
    );
  }
  if ((!aas || typeof aas !== 'object' || Array.isArray(aas)) &&
      (!functionalSnapshot || typeof functionalSnapshot !== 'object' || !Array.isArray(functionalSnapshot.declarations))) {
    throw coordinatorError('EVOLUTION_AAS_REQUIRED', 'The current AAS environment is required.');
  }
  validateStore(store);
  return normalizedCpsId;
}

function declaredEvidence(snapshot) {
  const declarations = snapshot.declarations || [];
  return {
    capabilityCount: declarations.filter((item) => item.kind === 'CAPABILITY').length,
    serviceCount: declarations.filter((item) => item.kind === 'SERVICE').length,
    physicallyValidatedCount: declarations.filter((item) => item.evidence?.physicallyValidated === true).length,
    bindingConfirmedCount: declarations.filter((item) => item.evidence?.bindingStatus === 'CONFIRMED').length,
    pendingEvidenceCount: declarations.filter((item) =>
      item.evidence?.bindingStatus === 'PENDING' || (item.evidence?.incompleteFields || []).length > 0).length,
    scope: 'DECLARED_FUNCTIONAL_CONTRACT',
    physicalValidationInferred: false,
  };
}

export async function coordinateAcceptedPlugEvolution({
  cpsId,
  plugEventId,
  plugCycleId,
  aas,
  store,
  plugAccepted = false,
  capturedAt = new Date(),
  provenance = {},
  resolvedAas = null,
} = {}) {
  // A resolved AAS can be supplied without changing the original coordinator contract.
  // Its document is the same in-memory document extracted below; no source reread occurs.
  if (resolvedAas && ((!resolvedAas.document || typeof resolvedAas.document !== 'object') &&
      (!resolvedAas.functionalSnapshot || !Array.isArray(resolvedAas.functionalSnapshot.declarations)))) {
    throw coordinatorError('EVOLUTION_RESOLVED_AAS_INVALID', 'resolvedAas must contain a verified document or normalized functional snapshot.');
  }
  const currentAas = resolvedAas?.document || aas;
  const normalizedCpsId = validateInput({
    cpsId, plugEventId, plugCycleId, aas: currentAas,
    functionalSnapshot: resolvedAas?.functionalSnapshot, store, plugAccepted,
  });
  if (resolvedAas?.identity?.cpsId && normalizeCpsId(resolvedAas.identity.cpsId) !== normalizedCpsId) {
    throw coordinatorError('EVOLUTION_AAS_CPS_MISMATCH', 'Resolved AAS identity does not match the Evolution CPS.');
  }
  const resolvedContentHash = resolvedAas?.integrity?.contentHash || resolvedAas?.resolvedReference?.contentHash || null;
  const archivedContentHash = resolvedAas?.archiveReference?.contentHash || null;
  if (resolvedContentHash && archivedContentHash && resolvedContentHash !== archivedContentHash) {
    throw coordinatorError('EVOLUTION_AAS_ARCHIVE_MISMATCH', 'Resolved AAS and archive reference have different content hashes.');
  }
  if (resolvedAas?.functionalSnapshot &&
      (resolvedAas.functionalSnapshot.source?.aasId !== resolvedAas.identity?.aasId ||
       resolvedAas.functionalSnapshot.source?.assetId !== resolvedAas.identity?.assetId)) {
    throw coordinatorError('EVOLUTION_AAS_FUNCTIONAL_SNAPSHOT_MISMATCH', 'Normalized functional snapshot identity differs from the verified AAS reference.');
  }
  const normalizedPlugEventId = String(plugEventId).trim();
  const normalizedPlugCycleId = String(plugCycleId).trim();
  const snapshot = resolvedAas?.functionalSnapshot || buildFunctionalSnapshot(currentAas);
  const previous = await store.getAcceptedBaseline(normalizedCpsId);
  const preview = previous?.snapshot?.snapshot
    ? compareFunctionalSnapshots(previous.snapshot.snapshot, snapshot)
    : compareFunctionalSnapshots(null, snapshot);
  const storageInput = {
    cpsId: normalizedCpsId,
    plugEventId: normalizedPlugEventId,
    plugCycleId: normalizedPlugCycleId,
    snapshot,
    aasReference: resolvedAas ? {
      cpsId: resolvedAas.identity?.cpsId || normalizedCpsId,
      aasId: resolvedAas.identity?.aasId || null,
      assetId: resolvedAas.identity?.assetId || null,
      version: resolvedAas.identity?.version || null,
      revision: resolvedAas.identity?.revision || null,
      contentHash: resolvedAas.integrity?.contentHash || resolvedAas.resolvedReference?.contentHash || null,
      canonicalHash: resolvedAas.integrity?.canonicalHash || resolvedAas.resolvedReference?.canonicalHash || null,
      sourceId: resolvedAas.provenance?.sourceId || null,
      sourceType: resolvedAas.provenance?.sourceType || null,
      operational: resolvedAas.provenance?.operational === true,
      sourceRevision: resolvedAas.provenance?.sourceRevision || null,
      resolverVersion: resolvedAas.resolverVersion || null,
      resolvedAt: resolvedAas.resolvedAt || null,
      archiveReference: resolvedAas.archiveReference?.reference || null,
      archiveContentHash: resolvedAas.archiveReference?.contentHash || null,
      evidenceScope: resolvedAas.evidenceScope || 'STATIC_DOCUMENT_DECLARATION',
      physicalStateInferred: false,
    } : null,
    capturedAt,
    provenance: {
      ...provenance,
      coordinatorVersion: EVOLUTION_COORDINATOR_VERSION,
      source: 'ACCEPTED_PLUG_CONTEXT',
    },
    pending: snapshot.issues.filter((item) => item.severity === 'WARNING'),
  };

  try {
    await store.recordPending(storageInput);
    const persisted = await store.recordCapture(storageInput);
    return {
      schemaVersion: '1.0',
      coordinatorVersion: EVOLUTION_COORDINATOR_VERSION,
      cpsId: normalizedCpsId,
      plugEventId: normalizedPlugEventId,
      plugCycleId: normalizedPlugCycleId,
      plugAccepted: true,
      status: persisted.comparison.status,
      reason: persisted.comparison.reason || null,
      duplicate: persisted.duplicate,
      promoted: persisted.promoted,
      snapshotId: persisted.snapshot.snapshotId,
      previousSnapshotId: persisted.snapshot.previousSnapshotId,
      comparisonId: persisted.comparison.comparisonId,
      functionalVersion: persisted.snapshot.functionalVersion,
      functionalHash: persisted.snapshot.functionalHash,
      aasContentHash: persisted.snapshot.aasReference?.contentHash || null,
      aasArchiveReference: persisted.snapshot.aasReference?.archiveReference || null,
      completeness: persisted.snapshot.completeness,
      evidence: declaredEvidence(snapshot),
      differences: persisted.comparison.differences,
      ambiguities: persisted.comparison.ambiguities,
      issues: persisted.snapshot.issues,
      processingState: persisted.processing.state,
      previewStatus: preview.status,
    };
  } catch (error) {
    if (error?.code !== 'EVOLUTION_IDENTITY_CONFLICT') {
      try {
        await store.recordFailure({ ...storageInput, error });
      } catch {
        // The primary storage failure remains authoritative; recovery may be impossible.
      }
    }
    throw error;
  }
}
