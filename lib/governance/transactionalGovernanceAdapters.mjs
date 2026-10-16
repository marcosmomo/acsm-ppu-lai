import { normalizeCpsId } from '../acsm/config.js';

function adapterError(code, message, status = 400, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.details = { code, ...details };
  return error;
}

function required(value, field) {
  const normalized = String(value || '').trim();
  if (!normalized) throw adapterError('GOVERNANCE_ADAPTER_INPUT_REQUIRED', `${field} is required.`, 400, { field });
  return normalized;
}

function authorizedHuman(context) {
  if (!context || context.authenticated !== true || context.authorized !== true || context.trusted !== true) {
    throw adapterError(
      'GOVERNANCE_SERVER_AUTHORIZATION_REQUIRED',
      'A trusted server-side authorization context is required.',
      403
    );
  }
  return { type: 'HUMAN', id: required(context.subject, 'authorization.subject') };
}

function identity(input = {}) {
  return {
    cpsId: required(input.cpsId, 'cpsId'),
    profileId: required(input.profileId, 'profileId'),
    plugCycleId: required(input.plugCycleId, 'plugCycleId'),
  };
}

function cycleIdentity(input = {}) {
  return { ...identity(input), plugEventId: required(input.plugEventId, 'plugEventId') };
}

function clone(value) { return structuredClone(value); }

export function translateGovernanceAdapterError(error) {
  const code = error?.code || error?.details?.code || 'GOVERNANCE_INTERNAL_ERROR';
  const conflict = /CONFLICT|NOT_PENDING|NOT_ACTIVE|NOT_EDITABLE|ALREADY|CLOSED/.test(code);
  const missing = /NOT_FOUND/.test(code);
  return {
    status: Number(error?.status) || (missing ? 404 : conflict ? 409 : 400),
    error: error?.message || 'Governance operation failed.',
    details: { ...(error?.details || {}), code },
  };
}

export class TransactionalGovernanceAdapters {
  constructor({ facade } = {}) {
    if (!facade || typeof facade.read !== 'function' || typeof facade.reserveAndCreatePendingProfile !== 'function') {
      throw adapterError('GOVERNANCE_FACADE_REQUIRED', 'An injected TransactionalGovernanceFacade-compatible instance is required.');
    }
    this.facade = facade;
  }

  reservePlug(input = {}) {
    const result = this.facade.reserveAndCreatePendingProfile({
      cpsId: input.cpsId, cps: input.cps || {}, plugEventId: input.plugEventId,
      identity: input.identity, plugCycleId: input.plugCycleId || null,
      previousState: input.previousState || null, initialPpuEvent: input.initialPpuEvent || null,
      expectedRevision: input.expectedRevision,
    });
    return {
      ...result,
      plugEventId: result.cycle.plugEventId,
      plugCycleId: result.cycle.plugCycleId,
      profileId: result.profile.profileId,
      activeProfile: result.profile,
      governanceStatus: result.profile.status,
      lifecycleEffectRequired: result.created === true,
    };
  }

  activatePlug(input = {}) {
    return this.facade.activateCycle({
      ...cycleIdentity(input), lifecycleEvidence: input.lifecycleEvidence,
      expectedRevision: input.expectedRevision,
    });
  }

  activatePlugFromPersistedEvidence(input = {}) {
    if (typeof this.facade.activateCycleFromPersistedLifecycleEvidence !== 'function') {
      throw adapterError('GOVERNANCE_PERSISTED_EVIDENCE_ACTIVATION_UNAVAILABLE', 'Facade does not support persisted-evidence activation.', 501);
    }
    return this.facade.activateCycleFromPersistedLifecycleEvidence({ ...cycleIdentity(input), expectedRevision: input.expectedRevision });
  }

  recordPlugFailure(input = {}) {
    return this.facade.recordCycleFailure({
      ...cycleIdentity(input), stage: input.stage, error: input.error, evidence: input.evidence || null,
      expectedRevision: input.expectedRevision,
    });
  }

  approveProfile(input = {}) {
    const result = this.facade.approveProfile({
      ...identity(input), actor: authorizedHuman(input.authorization), expectedRevision: input.expectedRevision,
    });
    return { ...result, governanceStatus: result.profile.status, ppuEvent: result.outbox?.entry?.payload || null, ppuOutbox: result.outbox };
  }

  rejectProfile(input = {}) {
    const result = this.facade.rejectProfile({
      ...identity(input), actor: authorizedHuman(input.authorization), expectedRevision: input.expectedRevision,
    });
    return { ...result, governanceStatus: result.profile.status, ppuEvent: result.outbox?.entry?.payload || null, ppuOutbox: result.outbox };
  }

  updatePolicies(input = {}) {
    const result = this.facade.updatePolicies({
      ...identity(input), policies: input.policies,
      actor: authorizedHuman(input.authorization), expectedRevision: input.expectedRevision,
    });
    return { ...result, governanceStatus: result.profile.status };
  }

  createGovernedAction(input = {}) {
    return this.facade.createPendingAction({ ...input, ...identity(input) });
  }

  decideGovernedAction(input = {}) {
    return this.facade.decideAction({
      actionId: input.actionId, decision: input.decision, ...identity(input),
      actor: authorizedHuman(input.authorization), expectedRevision: input.expectedRevision,
    });
  }

  enqueueOutbox(event, options = {}) { return this.facade.enqueueOutbox(event, options); }

  markOutboxPublished(eventId, options = {}) {
    required(options.publicationId, 'publicationId');
    return this.facade.markOutboxPublished(eventId, options);
  }

  markOutboxFailed(eventId, error, options = {}) {
    required(options.attemptId, 'attemptId');
    return this.facade.markOutboxFailed(eventId, error, options);
  }

  listOutbox() {
    return Object.values(this.facade.read().document.ppuOutbox || {})
      .sort((a, b) => Date.parse(a.createdAt || 0) - Date.parse(b.createdAt || 0));
  }

  listPendingActions() {
    return Object.values(this.facade.read().document.pendingActions || {})
      .filter((item) => item?.status === 'PENDING_HUMAN_APPROVAL')
      .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
  }

  prepareUnplug(input = {}) {
    const expected = cycleIdentity(input);
    const document = this.facade.read().document;
    const cycle = document.plugCycles?.[expected.plugCycleId];
    const profile = (document.profileVersions?.[normalizeCpsId(expected.cpsId)] || []).find(
      (item) => item?.profileId === expected.profileId && item?.plugCycleId === expected.plugCycleId
    );
    if (!cycle || !profile || cycle.cpsId !== normalizeCpsId(expected.cpsId) ||
        cycle.plugEventId !== expected.plugEventId || cycle.governanceProfileId !== expected.profileId ||
        !['ACTIVE', 'FAILED'].includes(cycle.state)) {
      throw adapterError('GOVERNANCE_UNPLUG_IDENTITY_CONFLICT', 'Unplug identities do not select the current closable cycle.', 409);
    }
    return { validated: true, cpsId: cycle.cpsId, plugEventId: cycle.plugEventId, plugCycleId: cycle.plugCycleId, profileId: profile.profileId, cycle: clone(cycle), profile: clone(profile), effects: [] };
  }

  closeUnplug(input = {}) {
    return this.facade.closeCorrelatedCycle({
      ...cycleIdentity(input), unplugEvidence: input.unplugEvidence,
      closedBy: input.closedBy || 'verified-unplug', expectedRevision: input.expectedRevision,
    });
  }

  closeUnplugFromPersistedEvidence(input = {}) {
    if (typeof this.facade.closeCycleFromPersistedLifecycleEvidence !== 'function') {
      throw adapterError('GOVERNANCE_PERSISTED_EVIDENCE_CLOSE_UNAVAILABLE', 'Facade does not support persisted-evidence closure.', 501);
    }
    return this.facade.closeCycleFromPersistedLifecycleEvidence({
      ...cycleIdentity(input), closedBy: input.closedBy || 'verified-unplug', expectedRevision: input.expectedRevision,
    });
  }

  getProfile(cpsId) {
    const key = normalizeCpsId(required(cpsId, 'cpsId'));
    const document = this.facade.read().document;
    const versions = clone(document.profileVersions?.[key] || []);
    const profile = document.profiles?.[key] ? clone(document.profiles[key]) : null;
    return { profile, activeProfile: profile?.plugCycleStatus === 'ACTIVE' ? profile : null, governanceStatus: profile?.status || 'NOT_DEFINED', profiles: versions, history: versions };
  }

  projectPlayGate(input = {}) {
    const key = normalizeCpsId(required(input.cpsId, 'cpsId'));
    const expectedProfileId = required(input.profileId, 'profileId');
    const expectedCycleId = required(input.plugCycleId, 'plugCycleId');
    const expectedPhase = String(input.expectedPhase || 'play').trim().toLowerCase();
    const lifecyclePhase = String(input.lifecyclePhase || '').trim().toLowerCase();
    const document = this.facade.read().document;
    const cycle = document.plugCycles?.[expectedCycleId] || null;
    const profile = document.profiles?.[key] || null;
    const correlated = Boolean(cycle && profile && cycle.cpsId === key && cycle.governanceProfileId === expectedProfileId &&
      profile.profileId === expectedProfileId && profile.plugCycleId === expectedCycleId);
    const cycleActive = correlated && cycle.state === 'ACTIVE' && profile.plugCycleStatus === 'ACTIVE';
    const approved = cycleActive && profile.status === 'APPROVED';
    const phaseCompatible = lifecyclePhase === expectedPhase;
    return {
      ok: approved && phaseCompatible,
      status: approved && phaseCompatible ? 200 : 409,
      cpsId: key, plugCycleId: expectedCycleId, profileId: expectedProfileId,
      cycleState: cycle?.state || null, governanceStatus: profile?.status || 'NOT_DEFINED',
      lifecyclePhase: lifecyclePhase || null, expectedPhase, correlated, cycleActive, approved, phaseCompatible,
      reason: !correlated ? 'GOVERNANCE_IDENTITY_CONFLICT' : !cycleActive ? 'GOVERNANCE_ACTIVE_CYCLE_REQUIRED' :
        !approved ? 'GOVERNANCE_APPROVAL_REQUIRED' : !phaseCompatible ? 'LIFECYCLE_PHASE_INCOMPATIBLE' : 'GOVERNANCE_GATE_PASSED',
    };
  }
}
