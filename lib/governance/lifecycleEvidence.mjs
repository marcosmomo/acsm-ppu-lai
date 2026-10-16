import { createHash } from 'node:crypto';

export const LIFECYCLE_EVIDENCE_SCHEMA_VERSION = '1.0';

export const LIFECYCLE_CONFIRMATION_LEVELS = Object.freeze({
  BACKEND_ACCEPTED: 'BACKEND_ACCEPTED',
  COMMUNICATION_ACK: 'COMMUNICATION_ACK',
  PHYSICAL_STATE_CONFIRMED: 'PHYSICAL_STATE_CONFIRMED',
});

export const LIFECYCLE_CONFIRMATION_RANK = Object.freeze({
  BACKEND_ACCEPTED: 1,
  COMMUNICATION_ACK: 2,
  PHYSICAL_STATE_CONFIRMED: 3,
});

export const LIFECYCLE_OPERATION_PHASE = Object.freeze({ PLUG: 'plug', UNPLUG: 'unplug' });

const confirmationToOutcome = Object.freeze({
  BACKEND_ACCEPTED: 'ACCEPTED',
  COMMUNICATION_ACK: 'ACKNOWLEDGED',
  PHYSICAL_STATE_CONFIRMED: 'COMPLETED',
});
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' ? value.trim() : '';

function evidenceError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = { code, ...details };
  return error;
}

function required(value, field) {
  const result = text(value);
  if (!result) throw evidenceError('LIFECYCLE_EVIDENCE_FIELD_REQUIRED', `${field} is required.`, { field });
  return result;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (record(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
}

function timestamp(value, field) {
  const normalized = required(value, field);
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== normalized) {
    throw evidenceError('LIFECYCLE_EVIDENCE_TIMESTAMP_INVALID', `${field} must be a canonical ISO-8601 timestamp.`, { field });
  }
  return parsed;
}

export function requireLifecycleCycleIdentity(input = {}) {
  return Object.freeze({
    cpsId: required(input.cpsId, 'cpsId'),
    plugEventId: required(input.plugEventId, 'plugEventId'),
    plugCycleId: required(input.plugCycleId, 'plugCycleId'),
    profileId: required(input.profileId, 'profileId'),
  });
}

function validateOperationState(operation, previousState, resultingState) {
  const op = required(operation, 'operation').toUpperCase();
  if (!Object.hasOwn(LIFECYCLE_OPERATION_PHASE, op)) {
    throw evidenceError('LIFECYCLE_EVIDENCE_OPERATION_INVALID', 'operation must be PLUG or UNPLUG.');
  }
  const previous = required(previousState, 'previousState').toLowerCase();
  const resulting = required(resultingState, 'resultingState').toLowerCase();
  const allowedResult = op === 'PLUG' ? ['plug'] : ['unplug', 'unplugged'];
  if (!allowedResult.includes(resulting) || previous === resulting) {
    throw evidenceError('LIFECYCLE_EVIDENCE_STATE_TRANSITION_INVALID', 'States do not describe the requested lifecycle transition.', {
      operation: op, previousState: previous, resultingState: resulting,
    });
  }
  return { operation: op, phase: LIFECYCLE_OPERATION_PHASE[op], previousState: previous, resultingState: resulting };
}

function validateAuthorityReceipt(receipt, source, permission) {
  if (!record(receipt) || receipt.verified !== true || !record(receipt.principal) ||
      receipt.principal.type !== 'LIFECYCLE_AUTHORITY' ||
      text(receipt.principal.system) !== source.system ||
      text(receipt.principal.component) !== source.component ||
      text(receipt.principal.instanceId) !== source.instanceId ||
      !text(receipt.authorizationId) || !text(receipt.scheme) || !text(receipt.claimsHash) ||
      receipt.permission !== permission) {
    throw evidenceError('LIFECYCLE_EVIDENCE_ORIGIN_UNTRUSTED', 'Server origin verifier did not authorize this lifecycle source.');
  }
  return Object.freeze({
    verified: true,
    principal: Object.freeze({
      type: 'LIFECYCLE_AUTHORITY', system: source.system,
      component: source.component, instanceId: source.instanceId,
    }),
    authorizationId: text(receipt.authorizationId),
    scheme: text(receipt.scheme),
    claimsHash: text(receipt.claimsHash),
    permission,
  });
}

function validateSource(source) {
  if (!record(source)) throw evidenceError('LIFECYCLE_EVIDENCE_SOURCE_REQUIRED', 'source object is required.');
  return Object.freeze({
    system: required(source.system, 'source.system'),
    component: required(source.component, 'source.component'),
    instanceId: required(source.instanceId, 'source.instanceId'),
  });
}

function payloadForHash(evidence) {
  const { evidenceId: _evidenceId, contentHash: _contentHash, ...payload } = evidence;
  return payload;
}

/**
 * Issues only a BACKEND_ACCEPTED evidence record. The verifier is the server
 * trust boundary and must authenticate the lifecycle authority and the exact
 * transition result. A request/HTTP response/boolean alone is insufficient.
 */
export function createBackendLifecycleEvidence({ verifyTransitionResult, now = () => new Date().toISOString() } = {}) {
  if (typeof verifyTransitionResult !== 'function') {
    throw evidenceError('LIFECYCLE_EVIDENCE_VERIFIER_REQUIRED', 'A server-side transition result verifier is required.');
  }

  return Object.freeze({
    issue(transitionResult, expectedIdentityInput) {
      if (!record(transitionResult) || transitionResult.resultKind !== 'LIFECYCLE_TRANSITION_RESULT') {
        throw evidenceError('LIFECYCLE_TRANSITION_RESULT_REQUIRED', 'A typed lifecycle transition result is required.');
      }
      const expectedIdentity = requireLifecycleCycleIdentity(expectedIdentityInput);
      const identity = requireLifecycleCycleIdentity(transitionResult);
      for (const field of Object.keys(expectedIdentity)) {
        if (identity[field] !== expectedIdentity[field]) {
          throw evidenceError('LIFECYCLE_EVIDENCE_IDENTITY_CONFLICT', 'Transition result does not match expected cycle identity.', { field });
        }
      }
      const transitionId = required(transitionResult.transitionId, 'transitionId');
      const states = validateOperationState(transitionResult.operation, transitionResult.previousState, transitionResult.resultingState);
      const occurredAt = required(transitionResult.occurredAt, 'occurredAt');
      timestamp(occurredAt, 'occurredAt');
      if (transitionResult.outcome !== 'ACCEPTED' || transitionResult.accepted !== true) {
        throw evidenceError('LIFECYCLE_TRANSITION_NOT_ACCEPTED', 'Only an accepted backend transition result can produce BACKEND_ACCEPTED evidence.');
      }
      const source = validateSource(transitionResult.source);
      const permission = `lifecycle.${states.phase}.record`;
      const authorityReceipt = validateAuthorityReceipt(
        verifyTransitionResult(transitionResult, { identity, transitionId, operation: states.operation, permission }),
        source,
        permission
      );
      const receivedAt = required(now(), 'receivedAt');
      timestamp(receivedAt, 'receivedAt');
      if (Date.parse(receivedAt) < Date.parse(occurredAt)) {
        throw evidenceError('LIFECYCLE_EVIDENCE_TIME_ORDER_INVALID', 'receivedAt cannot precede occurredAt.');
      }
      const correlationId = required(transitionResult.correlationId, 'correlationId');
      if (correlationId !== identity.plugCycleId) {
        throw evidenceError('LIFECYCLE_EVIDENCE_CORRELATION_CONFLICT', 'correlationId must equal the expected plugCycleId.');
      }
      const commandId = transitionResult.commandId == null ? null : required(transitionResult.commandId, 'commandId');
      const evidenceReference = transitionResult.evidenceReference;
      if (!record(evidenceReference) || !['BACKEND_TRANSITION_RECORD', 'BACKEND_STATE_COMMIT'].includes(evidenceReference.kind) ||
          required(evidenceReference.recordId, 'evidenceReference.recordId') !== transitionId ||
          !/^[a-f0-9]{64}$/i.test(required(evidenceReference.contentHash, 'evidenceReference.contentHash'))) {
        throw evidenceError('LIFECYCLE_EVIDENCE_REFERENCE_INVALID', 'A durable backend transition reference and SHA-256 hash are required.');
      }
      const evidence = {
        schemaVersion: LIFECYCLE_EVIDENCE_SCHEMA_VERSION,
        evidenceId: '',
        transitionId,
        ...identity,
        operation: states.operation,
        phase: states.phase,
        previousState: states.previousState,
        resultingState: states.resultingState,
        outcome: 'ACCEPTED',
        confirmationLevel: LIFECYCLE_CONFIRMATION_LEVELS.BACKEND_ACCEPTED,
        source,
        authorityReceipt,
        occurredAt,
        receivedAt,
        correlationId,
        commandId,
        evidenceReference: Object.freeze({ ...evidenceReference }),
      };
      const contentHash = sha256(payloadForHash(evidence));
      evidence.contentHash = contentHash;
      evidence.evidenceId = `lifecycle-evidence:${sha256({ transitionId, contentHash })}`;
      return Object.freeze(evidence);
    },
  });
}

function expectedPermission(phase) { return `lifecycle.${phase}.record`; }

/** Validate a record against caller-supplied cycle, order and confirmation policy. */
export function validateLifecycleEvidence(evidence, {
  expectedIdentity: expectedIdentityInput,
  expectedOperation,
  expectedPreviousState,
  confirmationPolicy,
  verifyEvidenceOrigin,
  now = new Date().toISOString(),
  maxFutureSkewMs = 0,
} = {}) {
  if (!record(evidence)) throw evidenceError('LIFECYCLE_EVIDENCE_REQUIRED', 'Lifecycle evidence is required.');
  if (evidence.schemaVersion !== LIFECYCLE_EVIDENCE_SCHEMA_VERSION) {
    throw evidenceError('LIFECYCLE_EVIDENCE_SCHEMA_UNSUPPORTED', 'Unsupported lifecycle evidence schema version.');
  }
  const expectedIdentity = requireLifecycleCycleIdentity(expectedIdentityInput);
  const identity = requireLifecycleCycleIdentity(evidence);
  for (const field of Object.keys(expectedIdentity)) {
    if (identity[field] !== expectedIdentity[field]) {
      throw evidenceError('LIFECYCLE_EVIDENCE_IDENTITY_CONFLICT', 'Evidence belongs to another cycle or profile.', { field });
    }
  }
  const transitionId = required(evidence.transitionId, 'transitionId');
  const states = validateOperationState(evidence.operation, evidence.previousState, evidence.resultingState);
  if (evidence.phase !== states.phase || text(expectedOperation).toUpperCase() !== states.operation) {
    throw evidenceError('LIFECYCLE_EVIDENCE_OPERATION_CONFLICT', 'Evidence operation or phase differs from the expected transition.', {
      expectedOperation, actualOperation: states.operation, expectedPhase: LIFECYCLE_OPERATION_PHASE[String(expectedOperation || '').toUpperCase()] || null,
    });
  }
  if (text(expectedPreviousState).toLowerCase() !== states.previousState) {
    throw evidenceError('LIFECYCLE_EVIDENCE_OUT_OF_ORDER', 'Evidence previousState does not match the currently expected state.', {
      expectedPreviousState, actualPreviousState: states.previousState,
    });
  }
  const level = text(evidence.confirmationLevel);
  if (!Object.hasOwn(LIFECYCLE_CONFIRMATION_RANK, level)) {
    throw evidenceError('LIFECYCLE_EVIDENCE_CONFIRMATION_LEVEL_INVALID', 'Unknown lifecycle confirmation level.');
  }
  if (evidence.outcome !== confirmationToOutcome[level]) {
    throw evidenceError('LIFECYCLE_EVIDENCE_OUTCOME_LEVEL_CONFLICT', 'Outcome does not match confirmationLevel.', { outcome: evidence.outcome, confirmationLevel: level });
  }
  if (!record(confirmationPolicy) || !Object.hasOwn(LIFECYCLE_CONFIRMATION_RANK, confirmationPolicy.minimumConfirmationLevel)) {
    throw evidenceError('LIFECYCLE_CONFIRMATION_POLICY_REQUIRED', 'An explicit minimum confirmation policy is required.');
  }
  const source = validateSource(evidence.source);
  if (typeof verifyEvidenceOrigin !== 'function') {
    throw evidenceError('LIFECYCLE_EVIDENCE_ORIGIN_VERIFIER_REQUIRED', 'A server-side evidence origin verifier is required.');
  }
  const receipt = validateAuthorityReceipt(
    verifyEvidenceOrigin(evidence, { source, identity, transitionId, permission: expectedPermission(states.phase) }),
    source,
    expectedPermission(states.phase)
  );
  if (canonical(receipt) !== canonical(evidence.authorityReceipt)) {
    throw evidenceError('LIFECYCLE_EVIDENCE_AUTHORITY_RECEIPT_CONFLICT', 'Origin verifier result does not match the recorded authority receipt.');
  }
  const occurredAtMs = timestamp(evidence.occurredAt, 'occurredAt');
  const receivedAtMs = timestamp(evidence.receivedAt, 'receivedAt');
  const nowMs = timestamp(now, 'now');
  if (occurredAtMs > receivedAtMs || receivedAtMs > nowMs + Math.max(0, Number(maxFutureSkewMs) || 0)) {
    throw evidenceError('LIFECYCLE_EVIDENCE_TIME_ORDER_INVALID', 'Evidence timestamps are inconsistent or too far in the future.');
  }
  if (text(evidence.correlationId) !== identity.plugCycleId) {
    throw evidenceError('LIFECYCLE_EVIDENCE_CORRELATION_CONFLICT', 'correlationId must equal plugCycleId.');
  }
  if (level !== LIFECYCLE_CONFIRMATION_LEVELS.BACKEND_ACCEPTED && !text(evidence.commandId)) {
    throw evidenceError('LIFECYCLE_EVIDENCE_COMMAND_ID_REQUIRED', 'Communication or physical evidence requires commandId.');
  }
  if (!record(evidence.evidenceReference) ||
      !['BACKEND_TRANSITION_RECORD', 'BACKEND_STATE_COMMIT', 'COMMUNICATION_ACK_RECORD', 'PHYSICAL_OBSERVATION_RECORD'].includes(evidence.evidenceReference.kind) ||
      text(evidence.evidenceReference.recordId) !== transitionId ||
      !/^[a-f0-9]{64}$/i.test(text(evidence.evidenceReference?.contentHash)) ||
      !/^[a-f0-9]{64}$/i.test(text(evidence.contentHash)) ||
      sha256(payloadForHash(evidence)) !== evidence.contentHash) {
    throw evidenceError('LIFECYCLE_EVIDENCE_INTEGRITY_INVALID', 'Evidence content hash or reference is invalid.');
  }
  const expectedEvidenceId = `lifecycle-evidence:${sha256({ transitionId, contentHash: evidence.contentHash })}`;
  if (evidence.evidenceId !== expectedEvidenceId) {
    throw evidenceError('LIFECYCLE_EVIDENCE_ID_INVALID', 'evidenceId is not derived from transitionId and contentHash.');
  }
  const minimum = LIFECYCLE_CONFIRMATION_RANK[confirmationPolicy.minimumConfirmationLevel];
  if (LIFECYCLE_CONFIRMATION_RANK[level] < minimum) {
    throw evidenceError('LIFECYCLE_EVIDENCE_CONFIRMATION_INSUFFICIENT', 'Evidence level does not satisfy the injected confirmation policy.', {
      actual: level, minimum: confirmationPolicy.minimumConfirmationLevel,
    });
  }
  return Object.freeze({
    valid: true,
    status: 'VALID',
    confirmationLevel: level,
    satisfiesPolicy: true,
    identity,
    transitionId,
    operation: states.operation,
    phase: states.phase,
  });
}

/** Compare against a durable global list/index of previously accepted evidence. */
export function classifyLifecycleEvidenceRetry(existingEvidence, candidate) {
  if (!Array.isArray(existingEvidence) || !record(candidate)) {
    throw evidenceError('LIFECYCLE_EVIDENCE_INDEX_INVALID', 'An existing evidence array and candidate record are required.');
  }
  const transitionId = required(candidate.transitionId, 'transitionId');
  const matches = existingEvidence.filter((item) => item?.transitionId === transitionId);
  if (!matches.length) return Object.freeze({ status: 'NEW', idempotent: false });
  const same = matches.find((item) => item?.evidenceId === candidate.evidenceId && item?.contentHash === candidate.contentHash);
  if (same && matches.every((item) => item.evidenceId === candidate.evidenceId && item.contentHash === candidate.contentHash)) {
    return Object.freeze({ status: 'IDEMPOTENT', idempotent: true, evidenceId: candidate.evidenceId });
  }
  throw evidenceError('LIFECYCLE_TRANSITION_ID_CONFLICT', 'transitionId was already used with different content or identity.', {
    transitionId, existingEvidenceIds: matches.map((item) => item.evidenceId),
  });
}

export function lifecycleEvidenceReadiness() {
  return Object.freeze({
    status: 'BLOCKED',
    blockers: Object.freeze([
      'NO_OPERATIONAL_AUTHORITY_VERIFIER',
      'NO_DURABLE_TRANSITION_RESULT_SOURCE',
      'NO_CORRELATED_COMMUNICATION_ACK',
      'NO_CORRELATED_PHYSICAL_CONFIRMATION',
      'NO_OPERATIONAL_EVIDENCE_PERSISTENCE',
    ]),
  });
}
