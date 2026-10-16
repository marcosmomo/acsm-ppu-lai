import crypto from 'node:crypto';
import { normalizeCpsId } from '../acsm/config.js';
import { governanceTransactionNoOp } from './governanceRepository.mjs';
import {
  GOVERNANCE_ACTION_STATUS,
  GOVERNANCE_STATUS,
  buildGovernanceProfile,
  buildGovernanceProfileId,
  normalizeGovernanceStatus,
} from './policies.js';
import { buildGovernanceDecisionPpuEvent, buildPlugRequestedPpuEvent } from '../acsm/ppuEventBuilder.mjs';
import {
  enqueuePpuOutbox,
  markPpuOutboxFailed,
  markPpuOutboxPublished,
} from '../acsm/ppuOutbox.mjs';

const EDITABLE_ACTIONS = new Set([
  'ADJUST_WELDING_CURRENT',
  'ADJUST_INSPECTION_THRESHOLD',
  'ADJUST_TRANSPORT_SPEED',
  'ADJUST_JOINING_FORCE',
  'ADJUST_SORTING_THRESHOLD',
]);

function domainError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function required(value, field) {
  const normalized = String(value || '').trim();
  if (!normalized) throw domainError('GOVERNANCE_DOMAIN_INPUT_REQUIRED', `${field} is required.`, { field });
  return normalized;
}

function clone(value) { return structuredClone(value); }
function versionOf(profile) { return Math.max(1, Number(profile?.profileVersion) || 1); }
function sortVersions(versions = []) { return [...versions].sort((a, b) => versionOf(a) - versionOf(b)); }

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function expectedIdentity(identity) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity) || !Object.keys(identity).length) {
    throw domainError('GOVERNANCE_PLUG_IDENTITY_REQUIRED', 'Expected functional/AAS identity is required.');
  }
  return { value: clone(identity), hash: stableHash(identity) };
}

function deterministicCycleId(cpsId, plugEventId) {
  const token = stableHash({ cpsId, plugEventId }).slice(0, 32);
  return `${cpsId}-cycle-${token}`;
}

function actorId(actor) {
  if (!actor || actor.type !== 'HUMAN' || !String(actor.id || '').trim()) {
    throw domainError('GOVERNANCE_HUMAN_ACTOR_REQUIRED', 'An explicit HUMAN actor is required.');
  }
  return String(actor.id).trim();
}

function replaceVersion(draft, cpsId, profile) {
  const versions = draft.profileVersions[cpsId] || [];
  let matched = false;
  draft.profileVersions[cpsId] = sortVersions(versions.map((item) => {
    if (item?.profileId === profile.profileId && item?.plugCycleId === profile.plugCycleId) {
      matched = true;
      return profile;
    }
    return item;
  }));
  if (!matched) throw domainError('GOVERNANCE_PROFILE_VERSION_NOT_FOUND', 'Expected profile version is missing.', { cpsId, profileId: profile.profileId });
  draft.profiles[cpsId] = profile;
}

function expectedProfile(draft, { cpsId, profileId, plugCycleId, requireActive = true }) {
  const key = normalizeCpsId(required(cpsId, 'cpsId'));
  const expectedProfileId = required(profileId, 'profileId');
  const expectedCycleId = required(plugCycleId, 'plugCycleId');
  const profile = draft.profiles[key];
  if (!profile || profile.profileId !== expectedProfileId || profile.plugCycleId !== expectedCycleId) {
    throw domainError('GOVERNANCE_PROFILE_IDENTITY_CONFLICT', 'CPS, profile and cycle do not identify the current profile.', {
      cpsId: key, expectedProfileId, expectedCycleId,
      actualProfileId: profile?.profileId || null, actualCycleId: profile?.plugCycleId || null,
    });
  }
  if (requireActive && profile.plugCycleStatus !== 'ACTIVE') {
    throw domainError('GOVERNANCE_PROFILE_NOT_ACTIVE', 'The expected profile is not in an active Plug cycle.', { profileId: expectedProfileId });
  }
  const cycle = draft.plugCycles?.[expectedCycleId];
  if (cycle && (cycle.cpsId !== key || cycle.governanceProfileId !== expectedProfileId || (requireActive && cycle.state !== 'ACTIVE'))) {
    throw domainError('GOVERNANCE_CYCLE_IDENTITY_CONFLICT', 'Cycle record does not match the expected active profile.', {
      cpsId: key, profileId: expectedProfileId, plugCycleId: expectedCycleId, cycleState: cycle.state,
    });
  }
  return { key, profile };
}

function exactCycle(draft, { cpsId, plugEventId, plugCycleId, profileId }) {
  const key = normalizeCpsId(required(cpsId, 'cpsId'));
  const eventId = required(plugEventId, 'plugEventId');
  const cycleId = required(plugCycleId, 'plugCycleId');
  const expectedProfileId = required(profileId, 'profileId');
  const cycle = draft.plugCycles?.[cycleId];
  if (!cycle || cycle.cpsId !== key || cycle.plugEventId !== eventId || cycle.governanceProfileId !== expectedProfileId) {
    throw domainError('GOVERNANCE_CYCLE_IDENTITY_CONFLICT', 'CPS, event, cycle and profile do not identify the same cycle.', {
      cpsId: key, plugEventId: eventId, plugCycleId: cycleId, profileId: expectedProfileId,
    });
  }
  const profile = (draft.profileVersions[key] || []).find((item) =>
    item?.profileId === expectedProfileId && item?.plugCycleId === cycleId && item?.plugEventId === eventId);
  if (!profile) throw domainError('GOVERNANCE_PROFILE_IDENTITY_CONFLICT', 'The cycle-associated profile version was not found.');
  return { key, eventId, cycleId, profileId: expectedProfileId, cycle, profile };
}

function requirePersistedLifecycleEvidence(exact, operation) {
  const stored = exact.cycle.lifecycleEvidence?.[operation];
  const transition = exact.cycle.logicalTransitions?.[operation];
  const evidence = stored?.evidence;
  if (stored?.status !== 'VALIDATED' || !evidence || !transition ||
      evidence.operation !== operation || evidence.outcome !== 'ACCEPTED' ||
      evidence.confirmationLevel !== 'BACKEND_ACCEPTED' ||
      evidence.transitionId !== transition.transitionId ||
      evidence.cpsId !== exact.key || evidence.plugEventId !== exact.eventId ||
      evidence.plugCycleId !== exact.cycleId || evidence.profileId !== exact.profileId ||
      transition.cpsId !== exact.key || transition.plugEventId !== exact.eventId ||
      transition.plugCycleId !== exact.cycleId || transition.profileId !== exact.profileId ||
      transition.operation !== operation || transition.outcome !== 'ACCEPTED' ||
      exact.cycle.checkpoints?.[operation === 'PLUG' ? 'plugEvidenceStored' : 'unplugEvidenceStored'] !== true) {
    throw domainError('GOVERNANCE_VALIDATED_LIFECYCLE_EVIDENCE_REQUIRED', `Persisted validated ${operation} evidence is required.`, {
      cpsId: exact.key, plugEventId: exact.eventId, plugCycleId: exact.cycleId,
      profileId: exact.profileId, operation,
    });
  }
  return evidence;
}

function validateCycleReference(draft, { cpsId, plugEventId, plugCycleId }) {
  const cycles = draft.plugCycles || {};
  const cycle = cycles[plugCycleId];
  if (!cycle) return;
  if (cycle.cpsId !== cpsId || cycle.plugEventId !== plugEventId || cycle.plugCycleId !== plugCycleId || cycle.state === 'CLOSED') {
    throw domainError('GOVERNANCE_CYCLE_IDENTITY_CONFLICT', 'Existing cycle does not match the requested profile identity.', { cpsId, plugEventId, plugCycleId });
  }
}

function recordHistory(draft, now, event) {
  const entry = {
    id: `gov_hist_${crypto.randomUUID()}`,
    timestamp: now(),
    ...clone(event),
  };
  draft.history = [entry, ...(draft.history || [])].slice(0, 500);
  return entry;
}

function policyUpdates(policies = {}) {
  const actions = Array.isArray(policies?.governableActions) ? policies.governableActions : [];
  if (!actions.length) throw domainError('GOVERNANCE_POLICIES_REQUIRED', 'At least one governable action update is required.');
  return actions.map((item) => {
    const action = String(item?.action || '').trim().toUpperCase();
    const autonomousLimit = Number(item?.autonomousLimit);
    const humanApprovalLimit = Number(item?.humanApprovalLimit);
    if (!EDITABLE_ACTIONS.has(action)) throw domainError('GOVERNANCE_POLICY_NOT_EDITABLE', 'Governance policy is not editable.', { action });
    if (!Number.isFinite(autonomousLimit) || autonomousLimit < 0) throw domainError('GOVERNANCE_AUTONOMOUS_LIMIT_INVALID', 'Autonomous limit must be non-negative.', { action });
    if (!Number.isFinite(humanApprovalLimit) || humanApprovalLimit <= autonomousLimit) {
      throw domainError('GOVERNANCE_HUMAN_LIMIT_INVALID', 'Human approval limit must be greater than autonomous limit.', { action });
    }
    return { action, autonomousLimit, humanApprovalLimit };
  });
}

function nextActionId(pendingActions) {
  const maximum = Object.keys(pendingActions || {}).reduce((max, key) => {
    const match = key.match(/^GA-(\d+)$/);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return `GA-${String(maximum + 1).padStart(3, '0')}`;
}

export class TransactionalGovernanceFacade {
  constructor({ repository, now = () => new Date().toISOString() } = {}) {
    if (!repository || typeof repository.read !== 'function' || typeof repository.transact !== 'function') {
      throw domainError('GOVERNANCE_REPOSITORY_REQUIRED', 'An injected GovernanceRepository-compatible instance is required.');
    }
    this.repository = repository;
    this.now = now;
  }

  read() { return this.repository.read(); }

  createPendingProfile({ cpsId, cps = {}, plugEventId, plugCycleId, ppuEvent = null, expectedRevision } = {}) {
    const key = normalizeCpsId(required(cpsId || cps?.id || cps?.cpsId, 'cpsId'));
    const eventId = required(plugEventId, 'plugEventId');
    const cycleId = required(plugCycleId, 'plugCycleId');
    return this.repository.transact((draft) => {
      const versions = sortVersions(draft.profileVersions[key] || []);
      const sameEvent = versions.find((profile) => profile?.plugEventId === eventId);
      if (sameEvent) {
        if (sameEvent.plugCycleId !== cycleId) throw domainError('GOVERNANCE_PLUG_IDENTITY_CONFLICT', 'plugEventId is already bound to another cycle.');
        return governanceTransactionNoOp({ profile: clone(sameEvent), created: false, idempotent: true, effects: [] });
      }
      const active = versions.find((profile) => profile?.plugCycleStatus === 'ACTIVE');
      if (active) throw domainError('GOVERNANCE_ACTIVE_CYCLE_CONFLICT', 'A different active Plug profile already exists.', { activeProfileId: active.profileId, activePlugCycleId: active.plugCycleId });
      validateCycleReference(draft, { cpsId: key, plugEventId: eventId, plugCycleId: cycleId });
      const latest = versions.at(-1) || null;
      const profileVersion = versions.length ? Math.max(...versions.map(versionOf)) + 1 : 1;
      const createdAt = this.now();
      const profile = {
        ...buildGovernanceProfile(key, cps, latest, { profileVersion, status: GOVERNANCE_STATUS.PENDING_APPROVAL, createdAt }),
        profileId: buildGovernanceProfileId(key, profileVersion),
        previousProfileId: latest?.profileId || null,
        previousProfileVersion: latest?.profileVersion || null,
        plugEventId: eventId,
        plugCycleId: cycleId,
        plugCycleStatus: 'ACTIVE',
        plugStartedAt: createdAt,
        plugClosedAt: null,
        approvedAt: null,
        approvedBy: null,
        rejectedAt: null,
        rejectedBy: null,
      };
      if (!profile.template) throw domainError('GOVERNANCE_TEMPLATE_NOT_FOUND', 'No governance template exists for this CPS.', { cpsId: key });
      draft.profileVersions[key] = [...versions, profile];
      draft.profiles[key] = profile;
      const history = recordHistory(draft, this.now, {
        eventType: latest ? 'GOVERNANCE_PLUG_CYCLE_OPENED' : 'GOVERNANCE_PROFILE_CREATED',
        cpsId: key, profileId: profile.profileId, profileVersion, plugEventId: eventId, plugCycleId: cycleId,
        previousProfileId: profile.previousProfileId, previousProfileVersion: profile.previousProfileVersion,
        status: profile.status, template: profile.template,
      });
      const outbox = ppuEvent ? enqueuePpuOutbox(draft, ppuEvent, { now: createdAt }) : null;
      return { profile: clone(profile), history: clone(history), outbox, created: true, idempotent: false, effects: [] };
    }, { expectedRevision }).result;
  }

  reserveAndCreatePendingProfile({
    cpsId, cps = {}, plugEventId, identity, plugCycleId = null, previousState = null,
    initialPpuEvent = null, expectedRevision,
  } = {}) {
    const key = normalizeCpsId(required(cpsId || cps?.id || cps?.cpsId, 'cpsId'));
    const eventId = required(plugEventId, 'plugEventId');
    const expected = expectedIdentity(identity);
    const cycleId = plugCycleId ? required(plugCycleId, 'plugCycleId') : deterministicCycleId(key, eventId);
    return this.repository.transact((draft) => {
      draft.plugCycles ??= {};
      const sameEvent = Object.values(draft.plugCycles).find((cycle) => cycle?.plugEventId === eventId);
      if (sameEvent) {
        if (sameEvent.cpsId !== key || sameEvent.plugCycleId !== cycleId || sameEvent.identityHash !== expected.hash) {
          throw domainError('GOVERNANCE_PLUG_IDENTITY_CONFLICT', 'plugEventId is already bound to different CPS, cycle or identity.', {
            plugEventId: eventId, plugCycleId: sameEvent.plugCycleId, cpsId: sameEvent.cpsId,
          });
        }
        const profile = (draft.profileVersions[key] || []).find((item) =>
          item?.profileId === sameEvent.governanceProfileId && item?.plugCycleId === cycleId);
        if (!profile || sameEvent.checkpoints?.profilePersisted !== true) {
          throw domainError('GOVERNANCE_CYCLE_PROFILE_INCONSISTENT', 'Existing cycle has no confirmed associated profile.');
        }
        return governanceTransactionNoOp({ cycle: clone(sameEvent), profile: clone(profile), created: false, idempotent: true, effects: [] });
      }
      const blocking = Object.values(draft.plugCycles).find((cycle) => cycle?.cpsId === key && cycle.state !== 'CLOSED');
      if (blocking) {
        throw domainError('GOVERNANCE_ACTIVE_CYCLE_CONFLICT', 'CPS already has a blocking Plug cycle.', {
          cpsId: key, activePlugEventId: blocking.plugEventId, activePlugCycleId: blocking.plugCycleId, state: blocking.state,
        });
      }
      if (draft.plugCycles[cycleId]) throw domainError('GOVERNANCE_CYCLE_ID_CONFLICT', 'plugCycleId is already in use.', { plugCycleId: cycleId });
      const versions = sortVersions(draft.profileVersions[key] || []);
      const activeProfile = versions.find((profile) => profile?.plugCycleStatus === 'ACTIVE' || profile?.plugCycleStatus === 'RESERVED');
      if (activeProfile) throw domainError('GOVERNANCE_ACTIVE_PROFILE_CONFLICT', 'A blocking legacy profile exists without a matching cycle record.', { profileId: activeProfile.profileId });
      const latest = versions.at(-1) || null;
      const profileVersion = versions.length ? Math.max(...versions.map(versionOf)) + 1 : 1;
      const reservedAt = this.now();
      const profile = {
        ...buildGovernanceProfile(key, cps, latest, { profileVersion, status: GOVERNANCE_STATUS.PENDING_APPROVAL, createdAt: reservedAt }),
        profileId: buildGovernanceProfileId(key, profileVersion),
        previousProfileId: latest?.profileId || null,
        previousProfileVersion: latest?.profileVersion || null,
        plugEventId: eventId,
        plugCycleId: cycleId,
        plugCycleStatus: 'RESERVED',
        plugStartedAt: reservedAt,
        plugClosedAt: null,
        approvedAt: null,
        approvedBy: null,
        rejectedAt: null,
        rejectedBy: null,
      };
      if (!profile.template) throw domainError('GOVERNANCE_TEMPLATE_NOT_FOUND', 'No governance template exists for this CPS.', { cpsId: key });
      const event = initialPpuEvent || (key === 'cpslai1' ? buildPlugRequestedPpuEvent({
        cpsId: key, plugEventId: eventId, plugCycleId: cycleId, occurredAt: reservedAt,
        previousState, profile, aasId: identity?.aasId || null,
      }) : null);
      const outbox = event ? enqueuePpuOutbox(draft, event, { now: reservedAt }) : null;
      const cycle = {
        plugCycleId: cycleId,
        plugEventId: eventId,
        cpsId: key,
        identity: expected.value,
        identityHash: expected.hash,
        ...(identity?.aasReferenceId ? {
          aasReference: {
            schemaVersion: 'cycle-aas-reference/1.0',
            cpsId: key,
            plugEventId: eventId,
            plugCycleId: cycleId,
            profileId: profile.profileId,
            referenceId: identity.aasReferenceId,
            aasId: identity.aasId,
            assetId: identity.assetId,
            contentHash: identity.contentHash,
            sourceId: identity.sourceId,
            sourceType: identity.sourceType,
            version: identity.aasVersion ?? null,
            revision: identity.aasRevision ?? null,
          },
        } : {}),
        state: 'RESERVED',
        governanceProfileId: profile.profileId,
        governanceProfileVersion: profile.profileVersion,
        reservedAt,
        activatedAt: null,
        failedAt: null,
        failure: null,
        closedAt: null,
        activationEvidence: null,
        closeEvidence: null,
        checkpoints: {
          profilePersisted: true,
          lifecycleTransitioned: false,
          ppuOutboxStored: Boolean(outbox?.entry),
          closeRequested: false,
        },
      };
      draft.plugCycles[cycleId] = cycle;
      draft.profileVersions[key] = [...versions, profile];
      draft.profiles[key] = profile;
      const history = recordHistory(draft, this.now, {
        eventType: latest ? 'GOVERNANCE_PLUG_CYCLE_RESERVED' : 'GOVERNANCE_PROFILE_CREATED',
        cpsId: key, plugEventId: eventId, plugCycleId: cycleId,
        profileId: profile.profileId, profileVersion, previousProfileId: profile.previousProfileId,
        previousProfileVersion: profile.previousProfileVersion, status: profile.status,
        plugCycleState: cycle.state, template: profile.template,
      });
      return { cycle: clone(cycle), profile: clone(profile), history: clone(history), outbox, created: true, idempotent: false, effects: [] };
    }, { expectedRevision }).result;
  }

  activateCycle({ cpsId, plugEventId, plugCycleId, profileId, lifecycleEvidence, expectedRevision } = {}) {
    if (!lifecycleEvidence || lifecycleEvidence.accepted !== true || !String(lifecycleEvidence.transitionId || '').trim()) {
      throw domainError('GOVERNANCE_LIFECYCLE_EVIDENCE_REQUIRED', 'Accepted lifecycle evidence with transitionId is required.');
    }
    const evidenceHash = stableHash(lifecycleEvidence);
    return this.repository.transact((draft) => {
      const exact = exactCycle(draft, { cpsId, plugEventId, plugCycleId, profileId });
      if (exact.cycle.state === 'ACTIVE') {
        if (stableHash(exact.cycle.activationEvidence) !== evidenceHash) {
          throw domainError('GOVERNANCE_ACTIVATION_EVIDENCE_CONFLICT', 'Cycle was activated with different evidence.');
        }
        return governanceTransactionNoOp({ cycle: clone(exact.cycle), profile: clone(exact.profile), activated: false, idempotent: true, effects: [] });
      }
      if (exact.cycle.state !== 'RESERVED') {
        throw domainError('GOVERNANCE_CYCLE_STATE_CONFLICT', 'Only a RESERVED cycle can be activated.', { state: exact.cycle.state });
      }
      if (exact.cycle.checkpoints?.profilePersisted !== true) throw domainError('GOVERNANCE_PROFILE_NOT_PERSISTED', 'Cycle profile checkpoint is not confirmed.');
      const activatedAt = this.now();
      const cycle = {
        ...exact.cycle, state: 'ACTIVE', activatedAt, activationEvidence: clone(lifecycleEvidence),
        checkpoints: { ...exact.cycle.checkpoints, lifecycleTransitioned: true },
      };
      const profile = { ...exact.profile, plugCycleStatus: 'ACTIVE' };
      draft.plugCycles[exact.cycleId] = cycle;
      replaceVersion(draft, exact.key, profile);
      const history = recordHistory(draft, this.now, {
        eventType: 'GOVERNANCE_PLUG_CYCLE_ACTIVATED', cpsId: exact.key, plugEventId: exact.eventId,
        plugCycleId: exact.cycleId, profileId: exact.profileId, profileVersion: profile.profileVersion,
        status: profile.status, activatedAt, lifecycleTransitionId: lifecycleEvidence.transitionId,
      });
      return { cycle: clone(cycle), profile: clone(profile), history: clone(history), activated: true, idempotent: false, effects: [] };
    }, { expectedRevision }).result;
  }

  activateCycleFromPersistedLifecycleEvidence({ cpsId, plugEventId, plugCycleId, profileId, expectedRevision } = {}) {
    return this.repository.transact((draft) => {
      const exact = exactCycle(draft, { cpsId, plugEventId, plugCycleId, profileId });
      const evidence = requirePersistedLifecycleEvidence(exact, 'PLUG');
      if (exact.cycle.state === 'ACTIVE') {
        if (stableHash(exact.cycle.activationEvidence) !== stableHash(evidence)) {
          throw domainError('GOVERNANCE_ACTIVATION_EVIDENCE_CONFLICT', 'Active cycle is bound to different persisted Plug evidence.');
        }
        return governanceTransactionNoOp({ cycle: clone(exact.cycle), profile: clone(exact.profile), activated: false, idempotent: true, effects: [] });
      }
      if (exact.cycle.state !== 'RESERVED' || exact.cycle.checkpoints?.profilePersisted !== true) {
        throw domainError('GOVERNANCE_CYCLE_STATE_CONFLICT', 'Only a profile-persisted RESERVED cycle can be activated.', { state: exact.cycle.state });
      }
      const activatedAt = this.now();
      const cycle = { ...exact.cycle, state: 'ACTIVE', activatedAt, activationEvidence: clone(evidence), checkpoints: { ...exact.cycle.checkpoints, lifecycleTransitioned: true } };
      const profile = { ...exact.profile, plugCycleStatus: 'ACTIVE' };
      draft.plugCycles[exact.cycleId] = cycle;
      replaceVersion(draft, exact.key, profile);
      const history = recordHistory(draft, this.now, {
        eventType: 'GOVERNANCE_PLUG_CYCLE_ACTIVATED', cpsId: exact.key, plugEventId: exact.eventId,
        plugCycleId: exact.cycleId, profileId: exact.profileId, profileVersion: profile.profileVersion,
        status: profile.status, activatedAt, lifecycleTransitionId: evidence.transitionId,
      });
      return { cycle: clone(cycle), profile: clone(profile), history: clone(history), activated: true, idempotent: false, effects: [] };
    }, { expectedRevision }).result;
  }

  recordCycleFailure({ cpsId, plugEventId, plugCycleId, profileId, stage, error, evidence = null, expectedRevision } = {}) {
    const failureStage = required(stage, 'stage');
    const failure = {
      stage: failureStage,
      code: String(error?.code || 'GOVERNANCE_CYCLE_FAILURE'),
      message: String(error?.message || error || 'Cycle failure').slice(0, 500),
      evidence: evidence === null ? null : clone(evidence),
    };
    return this.repository.transact((draft) => {
      const exact = exactCycle(draft, { cpsId, plugEventId, plugCycleId, profileId });
      if (exact.cycle.state === 'CLOSED') throw domainError('GOVERNANCE_CYCLE_STATE_CONFLICT', 'A CLOSED cycle cannot fail.');
      if (exact.cycle.state === 'FAILED' && stableHash(exact.cycle.failure) === stableHash(failure)) {
        return governanceTransactionNoOp({ cycle: clone(exact.cycle), failed: false, idempotent: true, effects: [] });
      }
      const failedAt = this.now();
      const cycle = { ...exact.cycle, state: 'FAILED', failedAt, failure };
      draft.plugCycles[exact.cycleId] = cycle;
      const history = recordHistory(draft, this.now, {
        eventType: 'GOVERNANCE_PLUG_CYCLE_FAILED', cpsId: exact.key, plugEventId: exact.eventId,
        plugCycleId: exact.cycleId, profileId: exact.profileId, profileVersion: exact.profile.profileVersion,
        stage: failureStage, error: { code: failure.code, message: failure.message }, failedAt,
      });
      return { cycle: clone(cycle), history: clone(history), failed: true, idempotent: false, effects: [] };
    }, { expectedRevision }).result;
  }

  closeCorrelatedCycle({ cpsId, plugEventId, plugCycleId, profileId, unplugEvidence, closedBy = 'verified-unplug', expectedRevision } = {}) {
    if (!unplugEvidence || unplugEvidence.accepted !== true || !String(unplugEvidence.transitionId || '').trim()) {
      throw domainError('GOVERNANCE_UNPLUG_EVIDENCE_REQUIRED', 'Accepted Unplug evidence with transitionId is required.');
    }
    const evidenceHash = stableHash(unplugEvidence);
    return this.repository.transact((draft) => {
      const exact = exactCycle(draft, { cpsId, plugEventId, plugCycleId, profileId });
      if (exact.cycle.state === 'CLOSED') {
        if (stableHash(exact.cycle.closeEvidence) !== evidenceHash) {
          throw domainError('GOVERNANCE_CLOSE_EVIDENCE_CONFLICT', 'Cycle was closed with different evidence.');
        }
        return governanceTransactionNoOp({ cycle: clone(exact.cycle), profile: clone(exact.profile), closed: false, idempotent: true, effects: [] });
      }
      if (exact.cycle.state !== 'ACTIVE' && !(exact.cycle.state === 'FAILED' && exact.cycle.checkpoints?.lifecycleTransitioned === true)) {
        throw domainError('GOVERNANCE_CYCLE_STATE_CONFLICT', 'Only ACTIVE or post-lifecycle FAILED cycles can be closed.', { state: exact.cycle.state });
      }
      const closedAt = this.now();
      const cycle = {
        ...exact.cycle, state: 'CLOSED', closedAt, closeEvidence: clone(unplugEvidence),
        checkpoints: { ...exact.cycle.checkpoints, closeRequested: true },
      };
      const profile = {
        ...exact.profile, plugCycleStatus: 'CLOSED', plugClosedAt: closedAt,
        closeEvidence: clone(unplugEvidence),
      };
      draft.plugCycles[exact.cycleId] = cycle;
      replaceVersion(draft, exact.key, profile);
      const history = recordHistory(draft, this.now, {
        eventType: 'GOVERNANCE_PLUG_CYCLE_CLOSED', cpsId: exact.key, plugEventId: exact.eventId,
        plugCycleId: exact.cycleId, profileId: exact.profileId, profileVersion: profile.profileVersion,
        status: profile.status, closedBy, plugClosedAt: closedAt, unplugTransitionId: unplugEvidence.transitionId,
      });
      return { cycle: clone(cycle), profile: clone(profile), history: clone(history), closed: true, idempotent: false, effects: [] };
    }, { expectedRevision }).result;
  }

  closeCycleFromPersistedLifecycleEvidence({ cpsId, plugEventId, plugCycleId, profileId, closedBy = 'verified-unplug', expectedRevision } = {}) {
    return this.repository.transact((draft) => {
      const exact = exactCycle(draft, { cpsId, plugEventId, plugCycleId, profileId });
      const evidence = requirePersistedLifecycleEvidence(exact, 'UNPLUG');
      if (exact.cycle.state === 'CLOSED') {
        if (stableHash(exact.cycle.closeEvidence) !== stableHash(evidence)) {
          throw domainError('GOVERNANCE_CLOSE_EVIDENCE_CONFLICT', 'Closed cycle is bound to different persisted Unplug evidence.');
        }
        return governanceTransactionNoOp({ cycle: clone(exact.cycle), profile: clone(exact.profile), closed: false, idempotent: true, effects: [] });
      }
      if (exact.cycle.state !== 'ACTIVE' && !(exact.cycle.state === 'FAILED' && exact.cycle.checkpoints?.lifecycleTransitioned === true)) {
        throw domainError('GOVERNANCE_CYCLE_STATE_CONFLICT', 'Only ACTIVE or post-transition FAILED cycles can be closed.', { state: exact.cycle.state });
      }
      const closedAt = this.now();
      const cycle = { ...exact.cycle, state: 'CLOSED', closedAt, closeEvidence: clone(evidence), checkpoints: { ...exact.cycle.checkpoints, closeRequested: true } };
      const profile = { ...exact.profile, plugCycleStatus: 'CLOSED', plugClosedAt: closedAt, closeEvidence: clone(evidence) };
      draft.plugCycles[exact.cycleId] = cycle;
      replaceVersion(draft, exact.key, profile);
      const history = recordHistory(draft, this.now, {
        eventType: 'GOVERNANCE_PLUG_CYCLE_CLOSED', cpsId: exact.key, plugEventId: exact.eventId,
        plugCycleId: exact.cycleId, profileId: exact.profileId, profileVersion: profile.profileVersion,
        status: profile.status, closedBy, plugClosedAt: closedAt, unplugTransitionId: evidence.transitionId,
      });
      return { cycle: clone(cycle), profile: clone(profile), history: clone(history), closed: true, idempotent: false, effects: [] };
    }, { expectedRevision }).result;
  }

  closeProfile({ cpsId, profileId, plugCycleId, closedBy = 'verified-unplug', evidence, expectedRevision } = {}) {
    if (!evidence || typeof evidence !== 'object') throw domainError('GOVERNANCE_CLOSE_EVIDENCE_REQUIRED', 'Verified close evidence is required.');
    return this.repository.transact((draft) => {
      if (draft.plugCycles?.[plugCycleId]) {
        throw domainError('GOVERNANCE_CORRELATED_CLOSE_REQUIRED', 'Cycles managed by plugCycles require closeCorrelatedCycle().');
      }
      const { key, profile: current } = expectedProfile(draft, { cpsId, profileId, plugCycleId });
      const closedAt = this.now();
      const profile = { ...current, plugCycleStatus: 'CLOSED', plugClosedAt: closedAt, closeEvidence: clone(evidence) };
      replaceVersion(draft, key, profile);
      const history = recordHistory(draft, this.now, {
        eventType: 'GOVERNANCE_PLUG_CYCLE_CLOSED', cpsId: key, profileId, profileVersion: profile.profileVersion,
        plugCycleId, status: profile.status, closedBy, plugClosedAt: closedAt,
      });
      return { profile: clone(profile), history: clone(history), closed: true, effects: [] };
    }, { expectedRevision }).result;
  }

  updatePolicies({ cpsId, profileId, plugCycleId, policies, actor, expectedRevision } = {}) {
    const updatedBy = actorId(actor);
    const updates = policyUpdates(policies);
    return this.repository.transact((draft) => {
      const { key, profile: current } = expectedProfile(draft, { cpsId, profileId, plugCycleId });
      if (normalizeGovernanceStatus(current.status) !== GOVERNANCE_STATUS.PENDING_APPROVAL) {
        throw domainError('GOVERNANCE_PROFILE_NOT_EDITABLE', 'Only the pending active profile can be edited.', { status: current.status });
      }
      const existingActions = current.policies?.governableActions || [];
      const byAction = new Map(updates.map((item) => [item.action, item]));
      for (const update of updates) {
        if (!existingActions.some((item) => String(item.action || '').toUpperCase() === update.action)) {
          throw domainError('GOVERNANCE_POLICY_ACTION_NOT_FOUND', 'Policy action is absent from the profile.', { action: update.action });
        }
      }
      const previousPolicies = clone(current.policies);
      const updatedAt = this.now();
      const profile = {
        ...current, updatedAt, updatedBy,
        policies: {
          ...current.policies,
          governableActions: existingActions.map((policy) => {
            const update = byAction.get(String(policy.action || '').toUpperCase());
            if (!update) return policy;
            return {
              ...policy,
              autonomousLimit: update.autonomousLimit,
              humanApprovalLimit: update.humanApprovalLimit,
              decisions: {
                [`variation <= ${update.autonomousLimit}%`]: 'ALLOW',
                [`variation > ${update.autonomousLimit}% and <= ${update.humanApprovalLimit}%`]: 'HUMAN_APPROVAL',
                [`variation > ${update.humanApprovalLimit}%`]: 'DENY',
              },
            };
          }),
        },
      };
      replaceVersion(draft, key, profile);
      const history = recordHistory(draft, this.now, {
        eventType: 'GOVERNANCE_PROFILE_UPDATED', cpsId: key, profileId, profileVersion: profile.profileVersion,
        plugCycleId, status: profile.status, updatedAt, updatedBy, previousPolicies, newPolicies: profile.policies,
      });
      return { profile: clone(profile), history: clone(history), effects: [] };
    }, { expectedRevision }).result;
  }

  approveProfile(input = {}) { return this.#decideProfile(input, 'APPROVED'); }
  rejectProfile(input = {}) { return this.#decideProfile(input, 'DENIED'); }

  #decideProfile({ cpsId, profileId, plugCycleId, actor, expectedRevision } = {}, decision) {
    const decidedBy = actorId(actor);
    return this.repository.transact((draft) => {
      const { key, profile: current } = expectedProfile(draft, { cpsId, profileId, plugCycleId });
      if (normalizeGovernanceStatus(current.status) !== GOVERNANCE_STATUS.PENDING_APPROVAL) {
        throw domainError('GOVERNANCE_PROFILE_NOT_PENDING', 'Only the pending active profile can be decided.', { status: current.status });
      }
      const at = this.now();
      const approved = decision === 'APPROVED';
      const profile = {
        ...current,
        status: approved ? GOVERNANCE_STATUS.APPROVED : GOVERNANCE_STATUS.DENIED,
        approvedAt: approved ? at : null,
        approvedBy: approved ? decidedBy : null,
        rejectedAt: approved ? null : at,
        rejectedBy: approved ? null : decidedBy,
      };
      replaceVersion(draft, key, profile);
      const history = recordHistory(draft, this.now, {
        eventType: approved ? 'GOVERNANCE_PROFILE_APPROVED' : 'GOVERNANCE_PROFILE_REJECTED',
        cpsId: key, profileId, profileVersion: profile.profileVersion, plugCycleId,
        status: profile.status, ...(approved ? { approvedBy: decidedBy } : { rejectedBy: decidedBy }),
      });
      let outbox = null;
      if (key === 'cpslai1') {
        const event = buildGovernanceDecisionPpuEvent({
          cpsId: key, decision: approved ? 'APPROVED' : 'REJECTED', decidedBy, decisionEvent: history, profile,
        });
        outbox = enqueuePpuOutbox(draft, event, { now: at });
      }
      return { profile: clone(profile), history: clone(history), outbox, effects: [] };
    }, { expectedRevision }).result;
  }

  recordHistory(event, { expectedRevision } = {}) {
    if (!event || typeof event !== 'object') throw domainError('GOVERNANCE_HISTORY_EVENT_REQUIRED', 'A history event object is required.');
    return this.repository.transact((draft) => ({ entry: clone(recordHistory(draft, this.now, event)), effects: [] }), { expectedRevision }).result;
  }

  createPendingAction({ actionId = null, cpsId, profileId, plugCycleId, action, requestedValue, variation, unit = '%', source = 'recommendation', recommendation = null, episodeId = null, correlationId = null, expectedRevision } = {}) {
    return this.repository.transact((draft) => {
      const { key, profile } = expectedProfile(draft, { cpsId, profileId, plugCycleId });
      if (normalizeGovernanceStatus(profile.status) !== GOVERNANCE_STATUS.APPROVED) {
        throw domainError('GOVERNANCE_PROFILE_NOT_APPROVED', 'Pending actions require an approved active profile.');
      }
      const id = actionId ? required(actionId, 'actionId') : nextActionId(draft.pendingActions);
      if (draft.pendingActions[id]) throw domainError('GOVERNANCE_ACTION_CONFLICT', 'Governance action already exists.', { actionId: id });
      const createdAt = this.now();
      const pendingAction = {
        actionId: id, cpsId: key, profileId, plugCycleId,
        action: required(action, 'action').toUpperCase(), requestedValue: Number(requestedValue), variation: Number(variation),
        unit, source, recommendation, episodeId, correlationId: correlationId || episodeId,
        governanceDecision: 'HUMAN_APPROVAL', status: GOVERNANCE_ACTION_STATUS.PENDING_HUMAN_APPROVAL,
        executionStatus: 'NOT_EXECUTED', executionResult: null, createdAt, approvedAt: null, rejectedAt: null,
      };
      if (!Number.isFinite(pendingAction.requestedValue) || !Number.isFinite(pendingAction.variation)) {
        throw domainError('GOVERNANCE_ACTION_VALUE_INVALID', 'Action values must be finite numbers.');
      }
      draft.pendingActions[id] = pendingAction;
      const history = recordHistory(draft, this.now, {
        eventType: 'GOVERNANCE_CHECK', actionId: id, cpsId: key, profileId, plugCycleId,
        action: pendingAction.action, requested: pendingAction.variation, unit, governanceResult: 'HUMAN_APPROVAL', pendingActionId: id,
      });
      return { action: clone(pendingAction), history: clone(history), effects: [] };
    }, { expectedRevision }).result;
  }

  decideAction({ actionId, decision, actor, cpsId = null, profileId = null, plugCycleId = null, expectedRevision } = {}) {
    const id = required(actionId, 'actionId');
    const decidedBy = actorId(actor);
    const normalizedDecision = String(decision || '').trim().toUpperCase();
    if (!['APPROVED', 'REJECTED'].includes(normalizedDecision)) throw domainError('GOVERNANCE_ACTION_DECISION_INVALID', 'Decision must be APPROVED or REJECTED.');
    return this.repository.transact((draft) => {
      const current = draft.pendingActions[id];
      if (!current) throw domainError('GOVERNANCE_ACTION_NOT_FOUND', 'Pending governance action was not found.', { actionId: id });
      if ((cpsId && normalizeCpsId(cpsId) !== current.cpsId) ||
          (profileId && profileId !== current.profileId) ||
          (plugCycleId && plugCycleId !== current.plugCycleId)) {
        throw domainError('GOVERNANCE_ACTION_IDENTITY_CONFLICT', 'Action does not belong to the expected CPS, profile and cycle.', {
          actionId: id, cpsId, profileId, plugCycleId,
        });
      }
      if (current.status !== GOVERNANCE_ACTION_STATUS.PENDING_HUMAN_APPROVAL) {
        throw domainError('GOVERNANCE_ACTION_ALREADY_DECIDED', 'Governance action already has a decision.', { actionId: id, status: current.status });
      }
      expectedProfile(draft, { cpsId: current.cpsId, profileId: current.profileId, plugCycleId: current.plugCycleId });
      const approved = normalizedDecision === 'APPROVED';
      const decidedAt = this.now();
      const action = {
        ...current, status: approved ? GOVERNANCE_ACTION_STATUS.APPROVED : GOVERNANCE_ACTION_STATUS.REJECTED,
        decidedBy, decidedAt, approvedAt: approved ? decidedAt : null, rejectedAt: approved ? null : decidedAt,
        executionStatus: approved ? 'PENDING_EXECUTION' : 'NOT_EXECUTED',
        effectIntent: approved ? { type: 'GOVERNED_ACTION_EXECUTION', actionId: id, preparedAt: decidedAt } : null,
      };
      draft.pendingActions[id] = action;
      const history = recordHistory(draft, this.now, {
        eventType: 'GOVERNANCE_HUMAN_DECISION', actionId: id, cpsId: action.cpsId,
        profileId: action.profileId, plugCycleId: action.plugCycleId, action: action.action,
        decision: normalizedDecision, decidedBy, episodeId: action.episodeId,
      });
      return { action: clone(action), history: clone(history), effects: approved ? [clone(action.effectIntent)] : [] };
    }, { expectedRevision }).result;
  }

  enqueueOutbox(event, { expectedRevision } = {}) {
    return this.repository.transact((draft) => ({ ...enqueuePpuOutbox(draft, event, { now: this.now() }), effects: [] }), { expectedRevision }).result;
  }

  markOutboxPublished(eventId, { publicationId = null, expectedRevision } = {}) {
    const id = required(eventId, 'eventId');
    const attemptId = publicationId ? required(publicationId, 'publicationId') : null;
    return this.repository.transact((draft) => {
      const existing = draft.ppuOutbox?.[id];
      if (existing?.status === 'PUBLISHED') {
        if (attemptId && existing.publicationId && existing.publicationId !== attemptId) {
          throw domainError('PPU_OUTBOX_PUBLICATION_CONFLICT', 'Event was published by another publication attempt.', { eventId: id });
        }
        return governanceTransactionNoOp({ entry: clone(existing), idempotent: true, effects: [] });
      }
      const entry = markPpuOutboxPublished(draft, id, { now: this.now() });
      if (attemptId) {
        entry.publicationId = attemptId;
        draft.ppuOutbox[id].publicationId = attemptId;
      }
      return { entry, idempotent: false, effects: [] };
    }, { expectedRevision }).result;
  }

  markOutboxFailed(eventId, error, { attemptId = null, retryDelayMs = 30_000, expectedRevision } = {}) {
    const id = required(eventId, 'eventId');
    const failureAttemptId = attemptId ? required(attemptId, 'attemptId') : null;
    return this.repository.transact((draft) => {
      const existing = draft.ppuOutbox?.[id];
      if (existing?.status === 'PUBLISHED') {
        throw domainError('PPU_OUTBOX_ALREADY_PUBLISHED', 'A published event cannot be marked failed.', { eventId: id });
      }
      if (failureAttemptId && existing?.lastFailureAttemptId === failureAttemptId) {
        return governanceTransactionNoOp({ entry: clone(existing), idempotent: true, effects: [] });
      }
      const entry = markPpuOutboxFailed(draft, id, error, { now: this.now(), retryDelayMs });
      if (failureAttemptId) {
        entry.lastFailureAttemptId = failureAttemptId;
        draft.ppuOutbox[id].lastFailureAttemptId = failureAttemptId;
      }
      return { entry, idempotent: false, effects: [] };
    }, { expectedRevision }).result;
  }
}
