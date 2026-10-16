import { createHash } from 'node:crypto';
import { createBackendLifecycleEvidence, LIFECYCLE_CONFIRMATION_LEVELS } from './lifecycleEvidence.mjs';
import { governanceTransactionNoOp } from './governanceRepository.mjs';

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = (value) => structuredClone(value);
const OPERATION = Object.freeze({ PLUG: 'PLUG', UNPLUG: 'UNPLUG' });
const resultingStates = Object.freeze({ PLUG: 'plug', UNPLUG: 'unplugged' });
const allowedPrevious = Object.freeze({ PLUG: new Set(['idle', 'unplugged']), UNPLUG: new Set(['plug', 'play']) });

function authorityError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = { code, ...details };
  return error;
}

function required(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw authorityError('LIFECYCLE_AUTHORITY_FIELD_REQUIRED', `${field} is required.`, { field });
  return value.trim();
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
}

function normalizeIdentity(input = {}) {
  return Object.freeze({
    cpsId: required(input.cpsId, 'cpsId'),
    plugEventId: required(input.plugEventId, 'plugEventId'),
    plugCycleId: required(input.plugCycleId, 'plugCycleId'),
    profileId: required(input.profileId, 'profileId'),
  });
}

function sourceDescriptor(input) {
  if (!isRecord(input)) throw authorityError('LIFECYCLE_AUTHORITY_SOURCE_REQUIRED', 'A server-side lifecycle authority descriptor is required.');
  return Object.freeze({
    system: required(input.system, 'source.system'),
    component: required(input.component, 'source.component'),
    instanceId: required(input.instanceId, 'source.instanceId'),
  });
}

function exactCycle(document, identity) {
  const cycle = document.plugCycles?.[identity.plugCycleId];
  if (!cycle || cycle.cpsId !== identity.cpsId || cycle.plugEventId !== identity.plugEventId ||
      cycle.plugCycleId !== identity.plugCycleId || cycle.governanceProfileId !== identity.profileId) {
    throw authorityError('LIFECYCLE_AUTHORITY_IDENTITY_CONFLICT', 'Identity does not resolve to the exact governance cycle/profile.', identity);
  }
  const profile = (document.profileVersions?.[identity.cpsId] || []).find((entry) =>
    entry?.profileId === identity.profileId && entry?.plugCycleId === identity.plugCycleId);
  if (!profile) throw authorityError('LIFECYCLE_AUTHORITY_PROFILE_NOT_FOUND', 'The cycle has no matching versioned governance profile.', identity);
  return cycle;
}

function transitionIdFor(identity, operation) {
  return `lifecycle-transition:${sha256({ schemaVersion: '1.0', ...identity, operation })}`;
}

function transitionReference(transition) {
  const { evidenceReference: _reference, ...payload } = transition;
  return {
    kind: 'BACKEND_TRANSITION_RECORD',
    recordId: transition.transitionId,
    contentHash: sha256(payload),
  };
}

/**
 * Isolated server-side logical lifecycle authority. It stores state and its
 * BACKEND_ACCEPTED evidence in one GovernanceRepository commit. It never calls
 * Plug Store, MQTT, REST, HCM, OPC UA or physical commands.
 */
export class TransactionalLifecycleAuthority {
  constructor({ repository, source, verifyTransitionResult, initialStateByCps = {}, now = () => new Date().toISOString() } = {}) {
    if (!repository || typeof repository.transact !== 'function' || typeof repository.read !== 'function') {
      throw authorityError('LIFECYCLE_AUTHORITY_REPOSITORY_REQUIRED', 'An explicitly injected GovernanceRepository is required.');
    }
    if (typeof verifyTransitionResult !== 'function') {
      throw authorityError('LIFECYCLE_AUTHORITY_VERIFIER_REQUIRED', 'A server-side authority verifier is required.');
    }
    this.repository = repository;
    this.source = sourceDescriptor(source);
    if (!initialStateByCps || typeof initialStateByCps !== 'object' || Array.isArray(initialStateByCps)) {
      throw authorityError('LIFECYCLE_AUTHORITY_INITIAL_STATE_INVALID', 'initialStateByCps must be an explicitly injected map.');
    }
    this.initialStateByCps = Object.freeze({ ...initialStateByCps });
    this.now = now;
    this.issueEvidence = createBackendLifecycleEvidence({
      now,
      verifyTransitionResult: (result, context) => verifyTransitionResult(result, { ...context, source: this.source }),
    });
  }

  transition({ identity: identityInput, operation, expectedRevision } = {}) {
    const identity = normalizeIdentity(identityInput);
    const normalizedOperation = String(operation || '').trim().toUpperCase();
    if (!Object.hasOwn(OPERATION, normalizedOperation)) {
      throw authorityError('LIFECYCLE_AUTHORITY_OPERATION_INVALID', 'operation must be PLUG or UNPLUG.');
    }
    const transitionId = transitionIdFor(identity, normalizedOperation);
    return this.repository.transact((draft) => {
      const cycle = exactCycle(draft, identity);
      cycle.logicalTransitions ??= {};
      cycle.lifecycleEvidence ??= {};
      const existing = cycle.logicalTransitions[normalizedOperation];
      if (existing) {
        if (existing.transitionId !== transitionId || existing.operation !== normalizedOperation ||
            existing.cpsId !== identity.cpsId || existing.plugEventId !== identity.plugEventId ||
            existing.plugCycleId !== identity.plugCycleId || existing.profileId !== identity.profileId) {
          throw authorityError('LIFECYCLE_AUTHORITY_RETRY_CONFLICT', 'The operation slot already contains a different transition identity.');
        }
        const storedEvidence = cycle.lifecycleEvidence[normalizedOperation]?.evidence;
        if (!storedEvidence || storedEvidence.transitionId !== transitionId) {
          throw authorityError('LIFECYCLE_AUTHORITY_EVIDENCE_MISSING', 'A prior logical transition is missing its atomic evidence record.');
        }
        return governanceTransactionNoOp({
          transition: clone(existing), evidence: clone(storedEvidence),
          cycle: clone(cycle), idempotent: true, confirmationLevel: storedEvidence.confirmationLevel,
        });
      }

      if (cycle.state === 'CLOSED') throw authorityError('LIFECYCLE_AUTHORITY_CYCLE_CLOSED', 'A closed governance cycle cannot accept a new lifecycle transition.');
      const priorClosedState = Object.values(draft.plugCycles || {})
        .filter((candidate) => candidate.cpsId === identity.cpsId && candidate.state === 'CLOSED' &&
          typeof candidate.authoritativeLifecycleState === 'string' && candidate.authoritativeLifecycleState.trim())
        .sort((left, right) => Date.parse(right.closedAt || right.reservedAt || 0) - Date.parse(left.closedAt || left.reservedAt || 0))[0]
        ?.authoritativeLifecycleState;
      const previousState = required(cycle.authoritativeLifecycleState || priorClosedState || this.initialStateByCps[identity.cpsId], 'authoritativeLifecycleState').toLowerCase();
      if (!allowedPrevious[normalizedOperation].has(previousState)) {
        throw authorityError('LIFECYCLE_AUTHORITY_TRANSITION_NOT_ALLOWED', 'The persisted logical state does not allow this transition.', {
          operation: normalizedOperation, previousState,
        });
      }
      const existingEvidence = cycle.lifecycleEvidence[normalizedOperation];
      if (existingEvidence || cycle.logicalTransitions[normalizedOperation]) {
        throw authorityError('LIFECYCLE_AUTHORITY_OPERATION_SLOT_CONFLICT', 'The lifecycle operation slot is already occupied.');
      }

      const occurredAt = this.now();
      const resultingState = resultingStates[normalizedOperation];
      const transition = {
        resultKind: 'LIFECYCLE_TRANSITION_RESULT',
        transitionId,
        ...identity,
        operation: normalizedOperation,
        previousState,
        resultingState,
        outcome: 'ACCEPTED',
        accepted: true,
        source: this.source,
        occurredAt,
        correlationId: identity.plugCycleId,
        commandId: null,
      };
      transition.evidenceReference = transitionReference(transition);
      const evidence = this.issueEvidence.issue(transition, identity);
      const storedAt = this.now();

      cycle.authoritativeLifecycleState = resultingState;
      cycle.logicalTransitions[normalizedOperation] = {
        transitionId,
        ...identity,
        operation: normalizedOperation,
        previousState,
        resultingState,
        outcome: 'ACCEPTED',
        source: clone(this.source),
        occurredAt,
        storedAt,
        evidenceReference: clone(transition.evidenceReference),
      };
      cycle.lifecycleEvidence[normalizedOperation] = { evidence: clone(evidence), status: 'VALIDATED', storedAt };
      cycle.checkpoints ??= {};
      cycle.checkpoints[normalizedOperation === 'PLUG' ? 'plugEvidenceStored' : 'unplugEvidenceStored'] = true;
      const history = {
        eventId: `LIFECYCLE_TRANSITION_ACCEPTED:${transitionId}`,
        eventType: 'GOVERNANCE_LIFECYCLE_TRANSITION_ACCEPTED',
        ...identity,
        operation: normalizedOperation,
        previousState,
        resultingState,
        transitionId,
        evidenceId: evidence.evidenceId,
        confirmationLevel: evidence.confirmationLevel,
        occurredAt,
        storedAt,
      };
      draft.history.push(history);
      return {
        transition: clone(cycle.logicalTransitions[normalizedOperation]),
        evidence: clone(evidence), cycle: clone(cycle), history: clone(history),
        idempotent: false,
        confirmationLevel: LIFECYCLE_CONFIRMATION_LEVELS.BACKEND_ACCEPTED,
      };
    }, { expectedRevision }).result;
  }

  read({ identity: identityInput } = {}) {
    const identity = normalizeIdentity(identityInput);
    const { document, revision } = this.repository.read();
    const cycle = exactCycle(document, identity);
    return Object.freeze({
      revision,
      identity,
      cycle: clone(cycle),
      logicalState: cycle.authoritativeLifecycleState || null,
      cycleState: cycle.state,
      plug: clone(cycle.logicalTransitions?.PLUG || null),
      unplug: clone(cycle.logicalTransitions?.UNPLUG || null),
      plugEvidence: clone(cycle.lifecycleEvidence?.PLUG?.evidence || null),
      unplugEvidence: clone(cycle.lifecycleEvidence?.UNPLUG?.evidence || null),
    });
  }

  readiness() {
    return Object.freeze({
      status: 'BLOCKED',
      mode: 'ISOLATED_PROTOTYPE',
      blockers: Object.freeze([
        'NO_OPERATIONAL_LIFECYCLE_AUTHORITY',
        'NO_OPERATIONAL_SERVICE_IDENTITY',
        'NO_PHYSICAL_CONFIRMATION_SOURCE',
        'NO_RUNTIME_INTEGRATION_OR_WRITER_SUSPENSION',
      ]),
    });
  }
}
