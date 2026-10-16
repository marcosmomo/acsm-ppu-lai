import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  LIFECYCLE_CONFIRMATION_LEVELS as LEVEL,
  classifyLifecycleEvidenceRetry,
  createBackendLifecycleEvidence,
  lifecycleEvidenceReadiness,
  validateLifecycleEvidence,
} from '../lib/governance/lifecycleEvidence.mjs';

const identity = Object.freeze({
  cpsId: 'cps-test-1', plugEventId: 'plug-event-1',
  plugCycleId: 'plug-cycle-1', profileId: 'profile-1',
});
const source = Object.freeze({ system: 'acsm-test', component: 'lifecycle-test', instanceId: 'instance-1' });
const occurredAt = '2026-10-14T12:00:00.000Z';
const receivedAt = '2026-10-14T12:00:01.000Z';
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const sha256 = (value) => createHash('sha256').update(canonical(value)).digest('hex');

function authorityReceipt(permission) {
  return {
    verified: true,
    principal: { type: 'LIFECYCLE_AUTHORITY', ...source },
    authorizationId: 'test-authorization-1', scheme: 'isolated-test-verifier',
    claimsHash: 'test-claims-digest', permission,
  };
}

function transitionResult(overrides = {}) {
  return {
    resultKind: 'LIFECYCLE_TRANSITION_RESULT', ...identity,
    transitionId: 'transition-1', operation: 'PLUG',
    previousState: 'idle', resultingState: 'plug',
    accepted: true, outcome: 'ACCEPTED', source,
    occurredAt, correlationId: identity.plugCycleId, commandId: null,
    evidenceReference: {
      kind: 'BACKEND_TRANSITION_RECORD', recordId: 'transition-1', contentHash: 'a'.repeat(64),
    },
    ...overrides,
  };
}

function issuer(overrides = {}) {
  return createBackendLifecycleEvidence({
    now: () => receivedAt,
    verifyTransitionResult: (_result, { permission }) => authorityReceipt(permission),
    ...overrides,
  });
}

function validate(evidence, overrides = {}) {
  return validateLifecycleEvidence(evidence, {
    expectedIdentity: identity,
    expectedOperation: evidence.operation,
    expectedPreviousState: evidence.previousState,
    confirmationPolicy: { minimumConfirmationLevel: LEVEL.BACKEND_ACCEPTED },
    verifyEvidenceOrigin: (_record, { permission }) => authorityReceipt(permission),
    now: '2026-10-14T12:00:02.000Z',
    ...overrides,
  });
}

function fixtureEvidence({ operation = 'PLUG', level = LEVEL.BACKEND_ACCEPTED, overrides = {} } = {}) {
  const phase = operation === 'PLUG' ? 'plug' : 'unplug';
  const transitionId = `${operation.toLowerCase()}-transition-fixture`;
  const evidence = {
    schemaVersion: '1.0', evidenceId: '', transitionId, ...identity,
    operation, phase,
    previousState: operation === 'PLUG' ? 'idle' : 'plug',
    resultingState: operation === 'PLUG' ? 'plug' : 'unplug',
    outcome: level === LEVEL.BACKEND_ACCEPTED ? 'ACCEPTED' : level === LEVEL.COMMUNICATION_ACK ? 'ACKNOWLEDGED' : 'COMPLETED',
    confirmationLevel: level, source,
    authorityReceipt: authorityReceipt(`lifecycle.${phase}.record`),
    occurredAt, receivedAt, correlationId: identity.plugCycleId,
    commandId: level === LEVEL.BACKEND_ACCEPTED ? null : 'test-command-1',
    evidenceReference: {
      kind: level === LEVEL.PHYSICAL_STATE_CONFIRMED ? 'PHYSICAL_OBSERVATION_RECORD'
        : level === LEVEL.COMMUNICATION_ACK ? 'COMMUNICATION_ACK_RECORD' : 'BACKEND_TRANSITION_RECORD',
      recordId: transitionId, contentHash: 'b'.repeat(64),
    },
    ...overrides,
  };
  const { evidenceId: _evidenceId, contentHash: _contentHash, ...payload } = evidence;
  evidence.contentHash = sha256(payload);
  evidence.evidenceId = `lifecycle-evidence:${sha256({ transitionId, contentHash: evidence.contentHash })}`;
  return evidence;
}

test('issues and validates only correlated BACKEND_ACCEPTED Plug evidence', () => {
  const evidence = issuer().issue(transitionResult(), identity);
  assert.equal(evidence.confirmationLevel, LEVEL.BACKEND_ACCEPTED);
  assert.equal(evidence.evidenceId, `lifecycle-evidence:${sha256({ transitionId: evidence.transitionId, contentHash: evidence.contentHash })}`);
  assert.equal(validate(evidence).valid, true);
  assert.equal(Object.isFrozen(evidence), true);
});

test('issues a correlated Unplug record but does not imply physical completion', () => {
  const result = transitionResult({
    transitionId: 'transition-unplug-1', operation: 'UNPLUG', previousState: 'plug', resultingState: 'unplugged',
    correlationId: identity.plugCycleId,
    evidenceReference: { kind: 'BACKEND_STATE_COMMIT', recordId: 'transition-unplug-1', contentHash: 'c'.repeat(64) },
  });
  const evidence = issuer().issue(result, identity);
  assert.equal(evidence.confirmationLevel, LEVEL.BACKEND_ACCEPTED);
  assert.equal(evidence.resultingState, 'unplugged');
  assert.equal(validate(evidence, { expectedOperation: 'UNPLUG', expectedPreviousState: 'plug' }).valid, true);
});

test('rejects booleans, isolated HTTP-like values, and missing or untrusted authority', () => {
  assert.throws(() => issuer().issue(true, identity), { code: 'LIFECYCLE_TRANSITION_RESULT_REQUIRED' });
  assert.throws(() => issuer().issue({ status: 200, body: { accepted: true } }, identity), { code: 'LIFECYCLE_TRANSITION_RESULT_REQUIRED' });
  assert.throws(() => createBackendLifecycleEvidence().issue(transitionResult(), identity), { code: 'LIFECYCLE_EVIDENCE_VERIFIER_REQUIRED' });
  const untrusted = createBackendLifecycleEvidence({ now: () => receivedAt, verifyTransitionResult: () => ({ verified: false }) });
  assert.throws(() => untrusted.issue(transitionResult(), identity), { code: 'LIFECYCLE_EVIDENCE_ORIGIN_UNTRUSTED' });
});

test('rejects incomplete or divergent cycle identity and stale-cycle Unplug evidence', () => {
  assert.throws(() => issuer().issue(transitionResult({ profileId: 'other-profile' }), identity), { code: 'LIFECYCLE_EVIDENCE_IDENTITY_CONFLICT' });
  const stale = fixtureEvidence({ operation: 'UNPLUG' });
  assert.throws(() => validate(stale, {
    expectedIdentity: { ...identity, plugCycleId: 'new-cycle' },
    expectedOperation: 'UNPLUG', expectedPreviousState: 'plug',
  }), { code: 'LIFECYCLE_EVIDENCE_IDENTITY_CONFLICT' });
  assert.throws(() => validateLifecycleEvidence(stale, { expectedOperation: 'UNPLUG' }), { code: 'LIFECYCLE_EVIDENCE_FIELD_REQUIRED' });
});

test('same transition and content is idempotent across a logical restart', () => {
  const first = issuer().issue(transitionResult(), identity);
  const recoveredIndex = JSON.parse(JSON.stringify([first]));
  const retryAfterRestart = issuer().issue(transitionResult(), identity);
  assert.deepEqual(classifyLifecycleEvidenceRetry(recoveredIndex, retryAfterRestart), {
    status: 'IDEMPOTENT', idempotent: true, evidenceId: first.evidenceId,
  });
  assert.equal(classifyLifecycleEvidenceRetry([], retryAfterRestart).status, 'NEW');
});

test('same transitionId with divergent content is a conflict', () => {
  const first = issuer().issue(transitionResult(), identity);
  const divergent = issuer().issue(transitionResult({ resultingState: 'plug', occurredAt: '2026-10-14T12:00:00.500Z' }), identity);
  assert.notEqual(first.contentHash, divergent.contentHash);
  assert.throws(() => classifyLifecycleEvidenceRetry([first], divergent), { code: 'LIFECYCLE_TRANSITION_ID_CONFLICT' });
});

test('rejects out-of-order, wrong operation, malformed timestamps and tampered payloads', () => {
  const plug = fixtureEvidence();
  assert.throws(() => validate(plug, { expectedPreviousState: 'unplug' }), { code: 'LIFECYCLE_EVIDENCE_OUT_OF_ORDER' });
  assert.throws(() => validate(plug, { expectedOperation: 'UNPLUG' }), { code: 'LIFECYCLE_EVIDENCE_OPERATION_CONFLICT' });
  const invalidTime = fixtureEvidence({ overrides: { occurredAt: 'not-a-time' } });
  assert.throws(() => validate(invalidTime), { code: 'LIFECYCLE_EVIDENCE_TIMESTAMP_INVALID' });
  const tampered = { ...plug, receivedAt: '2026-10-14T12:00:01.500Z' };
  assert.throws(() => validate(tampered), { code: 'LIFECYCLE_EVIDENCE_INTEGRITY_INVALID' });
});

test('confirmation policy is explicit and cannot promote ACK to physical confirmation', () => {
  const backendOnly = fixtureEvidence();
  assert.throws(() => validate(backendOnly, {
    confirmationPolicy: { minimumConfirmationLevel: LEVEL.PHYSICAL_STATE_CONFIRMED },
  }), { code: 'LIFECYCLE_EVIDENCE_CONFIRMATION_INSUFFICIENT' });
  const ackFixture = fixtureEvidence({ level: LEVEL.COMMUNICATION_ACK });
  assert.throws(() => validate(ackFixture, {
    confirmationPolicy: { minimumConfirmationLevel: LEVEL.PHYSICAL_STATE_CONFIRMED },
  }), { code: 'LIFECYCLE_EVIDENCE_CONFIRMATION_INSUFFICIENT' });
  assert.equal(validate(fixtureEvidence({ level: LEVEL.PHYSICAL_STATE_CONFIRMED }), {
    confirmationPolicy: { minimumConfirmationLevel: LEVEL.PHYSICAL_STATE_CONFIRMED },
  }).confirmationLevel, LEVEL.PHYSICAL_STATE_CONFIRMED);
});

test('rejects missing evidence, origin verifier, correlation and inconsistent ACK level', () => {
  assert.throws(() => validateLifecycleEvidence(null), { code: 'LIFECYCLE_EVIDENCE_REQUIRED' });
  const record = fixtureEvidence();
  assert.throws(() => validateLifecycleEvidence(record, {
    expectedIdentity: identity, expectedOperation: 'PLUG', expectedPreviousState: 'idle',
    confirmationPolicy: { minimumConfirmationLevel: LEVEL.BACKEND_ACCEPTED },
  }), { code: 'LIFECYCLE_EVIDENCE_ORIGIN_VERIFIER_REQUIRED' });
  assert.throws(() => validate(fixtureEvidence({ overrides: { correlationId: 'wrong-cycle' } })), { code: 'LIFECYCLE_EVIDENCE_CORRELATION_CONFLICT' });
  const inconsistent = fixtureEvidence({ level: LEVEL.COMMUNICATION_ACK, overrides: { outcome: 'ACCEPTED' } });
  assert.throws(() => validate(inconsistent), { code: 'LIFECYCLE_EVIDENCE_OUTCOME_LEVEL_CONFLICT' });
});

test('readiness stays BLOCKED until an operational durable source exists', () => {
  const readiness = lifecycleEvidenceReadiness();
  assert.equal(readiness.status, 'BLOCKED');
  assert.ok(readiness.blockers.includes('NO_DURABLE_TRANSITION_RESULT_SOURCE'));
  assert.ok(readiness.blockers.includes('NO_CORRELATED_PHYSICAL_CONFIRMATION'));
});
