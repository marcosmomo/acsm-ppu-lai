const text = (value) => String(value || '').trim();
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function contractError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function required(value, field) {
  const normalized = text(value);
  if (!normalized) throw contractError('GOVERNANCE_INTEGRATION_FIELD_REQUIRED', `${field} is required.`, { field });
  return normalized;
}

export function requireCycleIdentity(input = {}, { requireEvent = true } = {}) {
  const identity = {
    cpsId: required(input.cpsId, 'cpsId'),
    plugCycleId: required(input.plugCycleId, 'plugCycleId'),
    profileId: required(input.profileId, 'profileId'),
  };
  if (requireEvent) identity.plugEventId = required(input.plugEventId, 'plugEventId');
  return Object.freeze(identity);
}

export function requireExpectedRevision(expectedRevision) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw contractError('GOVERNANCE_EXPECTED_REVISION_REQUIRED', 'A non-negative expectedRevision is required for compare-and-set.');
  }
  return expectedRevision;
}

export function requireServerHumanAuthorization(context = {}, expectedPermission = null) {
  if (context.authenticated !== true || context.authorized !== true || context.trusted !== true ||
      context.provenance !== 'SERVER_AUTHENTICATION' || !text(context.subject) ||
      !Array.isArray(context.roles) || !context.roles.includes('GOVERNANCE_OPERATOR') ||
      !text(context.authenticationId) || !text(context.authenticatedAt) || !text(context.permission) ||
      (expectedPermission && text(context.permission) !== expectedPermission)) {
    throw contractError('GOVERNANCE_TRUSTED_SERVER_AUTHORIZATION_REQUIRED', 'A trusted server-authenticated governance operator is required.');
  }
  return Object.freeze({
    type: 'HUMAN', id: text(context.subject), authenticationId: text(context.authenticationId),
    authenticatedAt: text(context.authenticatedAt), provenance: context.provenance,
    permission: text(context.permission),
  });
}

export function requireCorrelatedLifecycleEvidence(identityInput, evidence = {}, expectedPhase) {
  const identity = requireCycleIdentity(identityInput);
  if (!isRecord(evidence) || evidence.accepted !== true || !text(evidence.transitionId) ||
      text(evidence.phase).toLowerCase() !== text(expectedPhase).toLowerCase()) {
    throw contractError('GOVERNANCE_CORRELATED_LIFECYCLE_EVIDENCE_REQUIRED', 'Accepted evidence with transitionId and expected phase is required.');
  }
  for (const field of ['cpsId', 'plugEventId', 'plugCycleId', 'profileId']) {
    if (text(evidence[field]) !== identity[field]) {
      throw contractError('GOVERNANCE_LIFECYCLE_EVIDENCE_IDENTITY_CONFLICT', 'Lifecycle evidence is not bound to the expected cycle.', { field });
    }
  }
  return Object.freeze({ ...structuredClone(evidence), phase: text(expectedPhase).toLowerCase() });
}

export function buildPlugIntegrationCommand(input = {}) {
  const cpsId = required(input.cpsId, 'cpsId');
  const plugEventId = required(input.plugEventId, 'plugEventId');
  if (!isRecord(input.identity) || !text(input.identity.aasId) ||
      (!text(input.identity.assetId) && !text(input.identity.functionalId))) {
    throw contractError('GOVERNANCE_PLUG_FUNCTIONAL_IDENTITY_REQUIRED', 'Plug requires aasId and assetId or functionalId.');
  }
  return Object.freeze({ cpsId, plugEventId, plugCycleId: input.plugCycleId ? text(input.plugCycleId) : null, identity: structuredClone(input.identity) });
}

export function buildHumanDecisionCommand(input = {}) {
  const decision = required(input.decision, 'decision').toUpperCase();
  if (!['APPROVED', 'DENIED'].includes(decision)) throw contractError('GOVERNANCE_HUMAN_DECISION_INVALID', 'Decision must be APPROVED or DENIED.');
  const expectedPermission = decision === 'APPROVED' ? 'governance.profile.approve' : 'governance.profile.reject';
  return Object.freeze({
    ...requireCycleIdentity(input, { requireEvent: false }),
    expectedRevision: requireExpectedRevision(input.expectedRevision),
    authorization: requireServerHumanAuthorization(input.authorization, expectedPermission), decision,
  });
}

export function buildLifecycleCommitCommand(input = {}, expectedPhase) {
  const identity = requireCycleIdentity(input);
  return Object.freeze({
    ...identity,
    expectedRevision: requireExpectedRevision(input.expectedRevision),
    evidence: requireCorrelatedLifecycleEvidence(identity, input.evidence, expectedPhase),
  });
}

export function buildExternalEffectIntent(input = {}) {
  return Object.freeze({
    intentId: required(input.intentId, 'intentId'), effectType: required(input.effectType, 'effectType'),
    ...requireCycleIdentity(input, { requireEvent: false }), payload: structuredClone(input.payload || {}), status: 'PENDING',
  });
}

export function assertGovernanceWriterPrincipal(principal = {}) {
  const subsystem = required(principal.subsystem, 'principal.subsystem').toUpperCase();
  if (subsystem === 'EVOLUTION') {
    throw contractError('GOVERNANCE_EVOLUTION_WRITE_FORBIDDEN', 'Evolution cannot create, decide, activate, fail or close governance records.');
  }
  if (!['ACSM_LIFECYCLE', 'GOVERNANCE_API', 'PPU_OUTBOX_WORKER', 'CUTOVER_ADMIN'].includes(subsystem)) {
    throw contractError('GOVERNANCE_WRITER_NOT_AUTHORIZED', 'Subsystem is not an authorized governance writer.', { subsystem });
  }
  return Object.freeze({ subsystem });
}
