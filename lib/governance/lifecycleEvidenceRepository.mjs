import {
  classifyLifecycleEvidenceRetry,
  validateLifecycleEvidence,
} from './lifecycleEvidence.mjs';
import { governanceTransactionNoOp } from './governanceRepository.mjs';

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = (value) => structuredClone(value);

function storeError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = { code, ...details };
  return error;
}

function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw storeError('LIFECYCLE_EVIDENCE_FIELD_REQUIRED', `${name} is required.`, { field: name });
  }
  return value.trim();
}

function normalizedIdentity(input = {}) {
  return Object.freeze({
    cpsId: required(input.cpsId, 'cpsId'),
    plugEventId: required(input.plugEventId, 'plugEventId'),
    plugCycleId: required(input.plugCycleId, 'plugCycleId'),
    profileId: required(input.profileId, 'profileId'),
  });
}

function findExactCycle(document, identity) {
  const cycle = document.plugCycles?.[identity.plugCycleId];
  if (!cycle || cycle.cpsId !== identity.cpsId || cycle.plugEventId !== identity.plugEventId ||
      cycle.plugCycleId !== identity.plugCycleId || cycle.governanceProfileId !== identity.profileId) {
    throw storeError('LIFECYCLE_EVIDENCE_CYCLE_IDENTITY_CONFLICT', 'Evidence identity does not resolve to the exact governance cycle and profile.', identity);
  }
  const profile = (document.profileVersions?.[identity.cpsId] || []).find((item) =>
    item?.profileId === identity.profileId && item?.plugCycleId === identity.plugCycleId);
  if (!profile) throw storeError('LIFECYCLE_EVIDENCE_PROFILE_NOT_FOUND', 'The cycle has no matching versioned governance profile.', identity);
  return cycle;
}

function transitionEvidenceRecords(document) {
  const records = [];
  for (const cycle of Object.values(document.plugCycles || {})) {
    for (const item of Object.values(cycle?.lifecycleEvidence || {})) {
      if (item?.evidence) records.push(item.evidence);
    }
  }
  return records;
}

function defaultExpectedPreviousState(cycle, operation) {
  if (typeof cycle.authoritativeLifecycleState === 'string' && cycle.authoritativeLifecycleState.trim()) return cycle.authoritativeLifecycleState;
  if (operation === 'UNPLUG') {
    return cycle.lifecycleEvidence?.PLUG?.status === 'VALIDATED'
      ? cycle.lifecycleEvidence.PLUG.evidence?.resultingState || null
      : null;
  }
  return null;
}

function ensureOperationAllowed(cycle, operation) {
  if (operation === 'PLUG') {
    if (cycle.state === 'CLOSED') throw storeError('LIFECYCLE_EVIDENCE_CYCLE_CLOSED', 'A closed cycle cannot receive a new Plug evidence record.');
    return;
  }
  if (operation === 'UNPLUG' && cycle.state !== 'ACTIVE' && !(cycle.state === 'FAILED' && cycle.checkpoints?.lifecycleTransitioned === true)) {
    throw storeError('LIFECYCLE_EVIDENCE_UNPLUG_CYCLE_NOT_ACTIVE', 'Unplug evidence can only be recorded for an active or post-transition failed cycle.', { state: cycle.state });
  }
}

/**
 * Persists authenticated lifecycle documents in the same GovernanceRepository
 * transaction as their evidence-storage checkpoint. This does not activate or
 * close the cycle and does not mutate profile approval state.
 */
export class LifecycleEvidenceRepository {
  constructor({ repository, verifyEvidenceOrigin, confirmationPolicy, now = () => new Date().toISOString(), resolveExpectedPreviousState = defaultExpectedPreviousState } = {}) {
    if (!repository || typeof repository.transact !== 'function' || typeof repository.read !== 'function') {
      throw storeError('LIFECYCLE_EVIDENCE_REPOSITORY_REQUIRED', 'An injected GovernanceRepository is required.');
    }
    if (typeof verifyEvidenceOrigin !== 'function') {
      throw storeError('LIFECYCLE_EVIDENCE_ORIGIN_VERIFIER_REQUIRED', 'A server-side origin verifier must be injected; callers cannot provide one per request.');
    }
    if (!isRecord(confirmationPolicy) || typeof confirmationPolicy.minimumConfirmationLevel !== 'string') {
      throw storeError('LIFECYCLE_CONFIRMATION_POLICY_REQUIRED', 'An explicit confirmation policy must be injected.');
    }
    if (typeof resolveExpectedPreviousState !== 'function') {
      throw storeError('LIFECYCLE_EXPECTED_STATE_RESOLVER_REQUIRED', 'A synchronous server-side lifecycle state resolver is required.');
    }
    this.repository = repository;
    this.verifyEvidenceOrigin = verifyEvidenceOrigin;
    this.confirmationPolicy = Object.freeze({ ...confirmationPolicy });
    this.now = now;
    this.resolveExpectedPreviousState = resolveExpectedPreviousState;
  }

  record({ identity: identityInput, evidence, expectedRevision } = {}) {
    const identity = normalizedIdentity(identityInput);
    if (!isRecord(evidence) || !['PLUG', 'UNPLUG'].includes(evidence.operation)) {
      throw storeError('LIFECYCLE_EVIDENCE_REQUIRED', 'A versioned Plug or Unplug evidence record is required.');
    }
    const operation = evidence.operation;
    return this.repository.transact((draft) => {
      const cycle = findExactCycle(draft, identity);
      const slot = operation;
      cycle.lifecycleEvidence ??= {};
      const existingForCycle = cycle.lifecycleEvidence[slot];
      const allExisting = transitionEvidenceRecords(draft);
      const retry = classifyLifecycleEvidenceRetry(allExisting, evidence);
      if (retry.idempotent) {
        if (evidence.cpsId !== identity.cpsId || evidence.plugEventId !== identity.plugEventId ||
            evidence.plugCycleId !== identity.plugCycleId || evidence.profileId !== identity.profileId ||
            existingForCycle?.evidence?.evidenceId !== evidence.evidenceId) {
          throw storeError('LIFECYCLE_EVIDENCE_CYCLE_IDENTITY_CONFLICT', 'transitionId was already persisted against a different cycle, profile or operation.');
        }
        return governanceTransactionNoOp({
          cycle: clone(cycle), evidence: clone(existingForCycle.evidence),
          status: existingForCycle.status, idempotent: true, committed: false,
        });
      }
      ensureOperationAllowed(cycle, operation);
      if (existingForCycle) {
        throw storeError('LIFECYCLE_EVIDENCE_OPERATION_SLOT_CONFLICT', `${operation} evidence is already stored for this cycle.`, { transitionId: existingForCycle.evidence?.transitionId });
      }

      const resolvedPreviousState = this.resolveExpectedPreviousState(clone(cycle), operation);
      const pendingReconciliation = typeof resolvedPreviousState !== 'string' || !resolvedPreviousState.trim();
      const validation = validateLifecycleEvidence(evidence, {
        expectedIdentity: identity,
        expectedOperation: operation,
        expectedPreviousState: pendingReconciliation ? evidence.previousState : resolvedPreviousState,
        confirmationPolicy: this.confirmationPolicy,
        verifyEvidenceOrigin: this.verifyEvidenceOrigin,
        now: this.now(),
      });
      const status = pendingReconciliation ? 'PENDING_RECONCILIATION' : 'VALIDATED';
      const storedAt = this.now();
      cycle.lifecycleEvidence[slot] = { evidence: clone(evidence), status, storedAt };
      cycle.checkpoints ??= {};
      cycle.checkpoints[operation === 'PLUG' ? 'plugEvidenceStored' : 'unplugEvidenceStored'] = true;
      const history = {
        eventId: `LIFECYCLE_EVIDENCE_STORED:${evidence.transitionId}`,
        eventType: 'GOVERNANCE_LIFECYCLE_EVIDENCE_STORED',
        cpsId: identity.cpsId, plugEventId: identity.plugEventId,
        plugCycleId: identity.plugCycleId, profileId: identity.profileId,
        operation, transitionId: evidence.transitionId,
        evidenceId: evidence.evidenceId, confirmationLevel: evidence.confirmationLevel,
        status, storedAt,
      };
      draft.history.push(history);
      return {
        cycle: clone(cycle), evidence: clone(evidence), status,
        validation, history: clone(history), idempotent: false,
      };
    }, { expectedRevision }).result;
  }

  reconcile({ identity: identityInput, operation, expectedRevision } = {}) {
    const identity = normalizedIdentity(identityInput);
    if (!['PLUG', 'UNPLUG'].includes(operation)) throw storeError('LIFECYCLE_EVIDENCE_OPERATION_INVALID', 'operation must be PLUG or UNPLUG.');
    return this.repository.transact((draft) => {
      const cycle = findExactCycle(draft, identity);
      const stored = cycle.lifecycleEvidence?.[operation];
      if (!stored) throw storeError('LIFECYCLE_EVIDENCE_NOT_FOUND', 'No persisted evidence exists for this cycle and operation.');
      if (stored.status === 'VALIDATED') return governanceTransactionNoOp({ cycle: clone(cycle), evidence: clone(stored.evidence), status: stored.status, idempotent: true, committed: false });
      ensureOperationAllowed(cycle, operation);
      const expectedPreviousState = this.resolveExpectedPreviousState(clone(cycle), operation);
      if (typeof expectedPreviousState !== 'string' || !expectedPreviousState.trim()) {
        return governanceTransactionNoOp({ cycle: clone(cycle), evidence: clone(stored.evidence), status: 'PENDING_RECONCILIATION', idempotent: true, committed: false });
      }
      const validation = validateLifecycleEvidence(stored.evidence, {
        expectedIdentity: identity,
        expectedOperation: operation,
        expectedPreviousState,
        confirmationPolicy: this.confirmationPolicy,
        verifyEvidenceOrigin: this.verifyEvidenceOrigin,
        now: this.now(),
      });
      const reconciledAt = this.now();
      cycle.lifecycleEvidence[operation] = { ...stored, status: 'VALIDATED', reconciledAt };
      cycle.checkpoints[operation === 'PLUG' ? 'plugEvidenceStored' : 'unplugEvidenceStored'] = true;
      const history = {
        eventId: `LIFECYCLE_EVIDENCE_RECONCILED:${stored.evidence.transitionId}`,
        eventType: 'GOVERNANCE_LIFECYCLE_EVIDENCE_RECONCILED',
        cpsId: identity.cpsId, plugEventId: identity.plugEventId,
        plugCycleId: identity.plugCycleId, profileId: identity.profileId,
        operation, transitionId: stored.evidence.transitionId,
        evidenceId: stored.evidence.evidenceId, confirmationLevel: stored.evidence.confirmationLevel,
        status: 'VALIDATED', reconciledAt,
      };
      draft.history.push(history);
      return { cycle: clone(cycle), evidence: clone(stored.evidence), status: 'VALIDATED', validation, history: clone(history), idempotent: false };
    }, { expectedRevision }).result;
  }

  readCycle({ identity: identityInput } = {}) {
    const identity = normalizedIdentity(identityInput);
    const { document, revision } = this.repository.read();
    const cycle = findExactCycle(document, identity);
    return Object.freeze({
      revision,
      cycle: clone(cycle),
      plug: clone(cycle.lifecycleEvidence?.PLUG || null),
      unplug: clone(cycle.lifecycleEvidence?.UNPLUG || null),
      processingState: cycle.state,
    });
  }

  listPendingReconciliation() {
    const { document, revision } = this.repository.read();
    const pending = [];
    for (const cycle of Object.values(document.plugCycles || {})) {
      for (const [operation, stored] of Object.entries(cycle.lifecycleEvidence || {})) {
        if (stored?.status === 'PENDING_RECONCILIATION') {
          pending.push({
            cpsId: cycle.cpsId, plugEventId: cycle.plugEventId,
            plugCycleId: cycle.plugCycleId, profileId: cycle.governanceProfileId,
            operation, transitionId: stored.evidence?.transitionId,
            evidenceId: stored.evidence?.evidenceId, storedAt: stored.storedAt,
          });
        }
      }
    }
    return Object.freeze({ revision, pending: Object.freeze(pending) });
  }
}
