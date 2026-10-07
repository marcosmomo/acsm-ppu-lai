import fs from 'fs';
import path from 'path';
import {
  GOVERNANCE_ACTION_STATUS,
  GOVERNANCE_DECISION,
  GOVERNANCE_STATUS,
  approveGovernanceProfileSnapshot,
  buildGovernanceProfileResponse,
  buildGovernanceProfileId,
  buildGovernanceProfile,
  evaluateGovernancePolicy,
  getGovernableActionPolicy,
  normalizeGovernanceStatus,
} from '../../lib/governance/policies.js';
import {
  openEpisode,
  registerEvent,
} from '../memory/cognitiveEpisodicMemoryService.js';
import { executeGovernedAction } from './governedActionExecutor.js';

const DEFAULT_STORE = { profiles: {}, profileVersions: {}, pendingActions: {}, history: [] };

const storePath = () =>
  process.env.GOVERNANCE_STORE_PATH || path.join(process.cwd(), 'data', 'governance-store.json');

const clone = (value) => {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
};

const nowIso = () => new Date().toISOString();
const normalizeCpsKey = (cpsId) => String(cpsId || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '').replace(/(cps)0+/, '$1');

const getProfileVersion = (profile) => Math.max(1, Number(profile?.profileVersion) || 1);

const sortProfilesByVersion = (profiles = []) =>
  [...profiles].sort((a, b) => getProfileVersion(a) - getProfileVersion(b));

const getLatestProfile = (profiles = []) => sortProfilesByVersion(profiles).at(-1) || null;

const EDITABLE_GOVERNANCE_ACTIONS = new Set([
  'ADJUST_WELDING_CURRENT',
  'ADJUST_INSPECTION_THRESHOLD',
  'ADJUST_TRANSPORT_SPEED',
  'ADJUST_JOINING_FORCE',
  'ADJUST_SORTING_THRESHOLD',
]);

const normalizeProfileVersions = (profiles = {}, profileVersions = {}) => {
  const normalized = {};

  Object.entries(profileVersions && typeof profileVersions === 'object' ? profileVersions : {})
    .forEach(([key, versions]) => {
      const normalizedKey = normalizeCpsKey(key);
      if (!normalizedKey) return;
      normalized[normalizedKey] = sortProfilesByVersion(
        (Array.isArray(versions) ? versions : []).filter(Boolean)
      );
    });

  Object.entries(profiles && typeof profiles === 'object' ? profiles : {}).forEach(([key, profile]) => {
    const normalizedKey = normalizeCpsKey(key || profile?.cpsId);
    if (!normalizedKey || !profile) return;
    const versions = normalized[normalizedKey] || [];
    const exists = versions.some(
      (item) =>
        item?.profileId === profile.profileId ||
        getProfileVersion(item) === getProfileVersion(profile)
    );
    normalized[normalizedKey] = sortProfilesByVersion(exists ? versions : [...versions, profile]);
  });

  return normalized;
};

const normalizeStore = (store = {}) => {
  const profileVersions = normalizeProfileVersions(store.profiles, store.profileVersions);
  const profiles = {};

  Object.entries(profileVersions).forEach(([key, versions]) => {
    const latest = getLatestProfile(versions);
    if (latest) profiles[key] = latest;
  });

  return {
    profiles,
    profileVersions,
    pendingActions:
      store.pendingActions && typeof store.pendingActions === 'object' ? store.pendingActions : {},
    history: Array.isArray(store.history) ? store.history : [],
  };
};

const readStore = () => {
  try {
    const file = storePath();
    if (!fs.existsSync(file)) return clone(DEFAULT_STORE);
    return normalizeStore(JSON.parse(fs.readFileSync(file, 'utf-8')));
  } catch {
    return clone(DEFAULT_STORE);
  }
};

const writeStore = (store) => {
  const normalized = normalizeStore(store);
  const file = storePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(normalized, null, 2)}\n`, 'utf-8');
  return clone(normalized);
};

const recordHistory = (store, event) => {
  const entry = {
    id: `gov_hist_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: nowIso(),
    ...event,
  };
  store.history = [entry, ...(store.history || [])].slice(0, 500);
  return entry;
};

const recordHcmGovernanceEvent = (eventType, content = {}) => {
  try {
    if (content.episodeId) {
      try {
        return registerEvent({
          episodeId: content.episodeId,
          source: 'acsm1',
          eventType,
          content: {
            eventType: String(eventType || '').toUpperCase(),
            ...content,
          },
        });
      } catch (error) {
        console.warn('[GOVERNANCE_HCM_DIRECT_WARN]', error?.message || error);
      }
    }

    const opened = openEpisode({
      trigger: 'governance',
      source: 'acsm1',
      targetCps: content.cpsId,
      recommendation: `Governance event: ${eventType}`,
      contextSnapshot: content,
    });
    if (!opened?.episode?.episodeId) return null;
    return registerEvent({
      episodeId: opened.episode.episodeId,
      source: 'acsm1',
      eventType,
      content: {
        eventType: String(eventType || '').toUpperCase(),
        ...content,
      },
    });
  } catch (error) {
    console.warn('[GOVERNANCE_HCM_WARN]', error?.message || error);
    return null;
  }
};

const recordGovernedActionExecution = (store, action, execution, governanceDecision) => {
  const event = recordHistory(store, {
    eventType: 'GOVERNED_ACTION_EXECUTED',
    actionId: action.actionId || action.governanceActionId || null,
    cpsId: action.cpsId,
    action: action.action,
    requested: action.requestedValue ?? action.variation,
    unit: action.unit || '%',
    governanceDecision,
    episodeId: action.episodeId || null,
    executionStatus: execution.executionStatus,
    executedAt: execution.executedAt,
    previousValue: execution.previousValue,
    newValue: execution.newValue,
    appliedVariation: execution.appliedVariation,
    actionResult: execution.actionResult,
  });
  recordHcmGovernanceEvent('governed_action_executed', event);
  return event;
};

const buildLimitDecisions = (autonomousLimit, humanApprovalLimit) => ({
  [`variation <= ${autonomousLimit}%`]: GOVERNANCE_DECISION.ALLOW,
  [`variation > ${autonomousLimit}% and <= ${humanApprovalLimit}%`]:
    GOVERNANCE_DECISION.HUMAN_APPROVAL,
  [`variation > ${humanApprovalLimit}%`]: GOVERNANCE_DECISION.DENY,
});

const normalizeEditableGovernancePolicies = (policies = {}) => {
  const allowedPolicyKeys = new Set(['governableActions']);
  const invalidPolicyKey = Object.keys(policies || {}).find((key) => !allowedPolicyKeys.has(key));
  if (invalidPolicyKey) {
    const error = new Error('Governance policy field is not editable.');
    error.status = 400;
    error.details = { code: 'GOVERNANCE_POLICY_FIELD_NOT_EDITABLE', field: invalidPolicyKey };
    throw error;
  }

  const actions = Array.isArray(policies?.governableActions) ? policies.governableActions : [];
  if (!actions.length) {
    const error = new Error('No editable governance policies were provided.');
    error.status = 400;
    error.details = { code: 'GOVERNANCE_POLICIES_REQUIRED' };
    throw error;
  }

  return actions.map((item) => {
    const action = String(item?.action || '').trim().toUpperCase();
    const autonomousLimit = Number(item?.autonomousLimit);
    const humanApprovalLimit = Number(item?.humanApprovalLimit);

    if (!EDITABLE_GOVERNANCE_ACTIONS.has(action)) {
      const error = new Error('Governance policy is not editable.');
      error.status = 400;
      error.details = { code: 'GOVERNANCE_POLICY_NOT_EDITABLE', action };
      throw error;
    }

    if (!Number.isFinite(autonomousLimit) || autonomousLimit < 0) {
      const error = new Error('Autonomous limit must be a number greater than or equal to 0.');
      error.status = 400;
      error.details = { code: 'INVALID_AUTONOMOUS_LIMIT', action };
      throw error;
    }

    if (!Number.isFinite(humanApprovalLimit) || humanApprovalLimit <= autonomousLimit) {
      const error = new Error('Human approval limit must be greater than autonomous limit.');
      error.status = 400;
      error.details = { code: 'INVALID_HUMAN_APPROVAL_LIMIT', action };
      throw error;
    }

    return { action, autonomousLimit, humanApprovalLimit };
  });
};

export const ensureGovernanceProfile = (cpsId) => {
  const key = normalizeCpsKey(cpsId);
  if (!key) {
    const error = new Error('cpsId is required.');
    error.status = 400;
    throw error;
  }

  const store = readStore();
  const versions = store.profileVersions[key] || [];
  const active = versions.filter((item) => item?.plugCycleStatus === 'ACTIVE').at(-1) || null;
  return {
    profile: active,
    activeProfile: active,
    governanceStatus: active?.status || GOVERNANCE_STATUS.NOT_DEFINED,
    profiles: versions,
    history: versions,
    created: false,
  };
};

export const createGovernanceProfileForPlug = (cpsId, cps = {}, { plugEventId = null } = {}) => {
  const key = normalizeCpsKey(cpsId || cps?.id || cps?.cpsId);
  if (!key) {
    const error = new Error('cpsId is required.');
    error.status = 400;
    throw error;
  }

  const store = readStore();
  const versions = sortProfilesByVersion(store.profileVersions[key] || []);
  const eventProfile = plugEventId
    ? versions.find((profile) => profile?.plugEventId === plugEventId) || null
    : null;
  if (eventProfile) {
    return {
      profile: eventProfile,
      activeProfile: eventProfile.plugCycleStatus === 'ACTIVE' ? eventProfile : null,
      governanceStatus: eventProfile.status,
      profiles: versions,
      history: versions,
      created: false,
      newPlugCycle: false,
    };
  }
  const active = versions.filter((profile) => profile?.plugCycleStatus === 'ACTIVE').at(-1) || null;
  const existing = active || null;
  if (existing && !plugEventId) {
    return {
      profile: existing,
      activeProfile: existing,
      governanceStatus: existing.status,
      profiles: versions,
      history: versions,
      created: false,
    };
  }

  const plugClosedAt = existing ? nowIso() : null;
  const closedVersions = existing
    ? versions.map((profile) => profile.profileId === existing.profileId
      ? { ...profile, plugCycleStatus: 'CLOSED', plugClosedAt }
      : profile)
    : versions;
  if (existing) {
    recordHistory(store, {
      eventType: 'GOVERNANCE_PLUG_CYCLE_CLOSED',
      cpsId: key,
      plugCycleId: existing.plugCycleId || null,
      profileId: existing.profileId,
      profileVersion: existing.profileVersion,
      status: existing.status,
      closedBy: 'new-plug-event',
      plugClosedAt,
    });
  }
  const latest = getLatestProfile(closedVersions);
  {
      const profileVersion = closedVersions.length
        ? Math.max(...closedVersions.map((profile) => getProfileVersion(profile) + 1))
        : 1;
      const plugStartedAt = nowIso();
      const profile = {
        ...buildGovernanceProfile(key, cps, latest, {
          profileVersion,
          status: GOVERNANCE_STATUS.PENDING_APPROVAL,
          createdAt: plugStartedAt,
        }),
        previousProfileId: latest?.profileId || null,
        previousProfileVersion: latest?.profileVersion || null,
        plugCycleId: `${key}-plug-v${profileVersion}`,
        ...(plugEventId ? { plugEventId } : {}),
        plugCycleStatus: 'ACTIVE',
        plugStartedAt,
        plugClosedAt: null,
        approvedAt: null,
        approvedBy: null,
        rejectedAt: null,
        rejectedBy: null,
      };

      store.profileVersions[key] = sortProfilesByVersion([...closedVersions, profile]);
      store.profiles[key] = profile;
      const event = recordHistory(store, {
        eventType: latest ? 'GOVERNANCE_PLUG_CYCLE_OPENED' : 'GOVERNANCE_PROFILE_CREATED',
        cpsId: key,
        plugCycleId: profile.plugCycleId,
        profileId: profile.profileId,
        profileVersion: profile.profileVersion,
        previousProfileId: latest?.profileId || null,
        previousProfileVersion: latest?.profileVersion || null,
        status: profile.status,
        template: profile.template,
      });
      recordHcmGovernanceEvent(latest ? 'governance_plug_cycle_opened' : 'governance_profile_created', event);
      writeStore(store);
      return {
        profile,
        activeProfile: profile,
        governanceStatus: profile.status,
        profiles: store.profileVersions[key],
        history: store.profileVersions[key],
        created: true,
        newPlugCycle: Boolean(latest),
      };
  }
};

export const closeGovernancePlugCycle = (cpsId, closedBy = 'lifecycle-unplug') => {
  const key = normalizeCpsKey(cpsId);
  if (!key) {
    const error = new Error('cpsId is required.');
    error.status = 400;
    throw error;
  }

  const store = readStore();
  const current = store.profiles[key] || null;
  if (!current || current.plugCycleStatus === 'CLOSED') {
    return {
      profile: current,
      governanceStatus: current?.status || GOVERNANCE_STATUS.NOT_DEFINED,
      closed: false,
    };
  }

  const plugClosedAt = nowIso();
  const profile = {
    ...current,
    plugCycleStatus: 'CLOSED',
    plugClosedAt,
  };
  store.profiles[key] = profile;
  store.profileVersions[key] = sortProfilesByVersion(
    (store.profileVersions[key] || [current]).map((item) =>
      item?.profileId === profile.profileId ||
      getProfileVersion(item) === getProfileVersion(profile)
        ? profile
        : item
    )
  );
  const event = recordHistory(store, {
    eventType: 'GOVERNANCE_PLUG_CYCLE_CLOSED',
    cpsId: key,
    plugCycleId: profile.plugCycleId || null,
    profileId: profile.profileId,
    profileVersion: profile.profileVersion,
    status: profile.status,
    closedBy,
    plugClosedAt,
  });
  writeStore(store);
  return { profile, governanceStatus: profile.status, closed: true };
};

export const getGovernanceProfile = (cpsId) => {
  const key = normalizeCpsKey(cpsId);
  const store = readStore();
  const history = store.profileVersions[key] || [];
  const activeProfile = history.filter((item) => item?.plugCycleStatus === 'ACTIVE').at(-1) || null;
  return {
    ...buildGovernanceProfileResponse(activeProfile, history),
    activeProfile,
    profile: activeProfile,
    governanceStatus: activeProfile?.status || GOVERNANCE_STATUS.NOT_DEFINED,
  };
};

export const getActiveGovernanceProfile = (cpsId) => {
  const key = normalizeCpsKey(cpsId);
  const store = readStore();
  return (store.profileVersions[key] || [])
    .filter((profile) => profile?.plugCycleStatus === 'ACTIVE')
    .at(-1) || null;
};

export const updateGovernanceProfile = (
  cpsId,
  policies = {},
  updatedBy = 'human-operator'
) => {
  const key = normalizeCpsKey(cpsId);
  if (!key) {
    const error = new Error('cpsId is required.');
    error.status = 400;
    throw error;
  }

  const editablePolicies = normalizeEditableGovernancePolicies(policies);
  const store = readStore();
  const current = store.profiles[key] || null;

  if (!current) {
    const error = new Error('Governance Profile not found.');
    error.status = 404;
    error.details = { code: 'GOVERNANCE_PROFILE_NOT_FOUND' };
    throw error;
  }

  if (normalizeGovernanceStatus(current.status) !== GOVERNANCE_STATUS.PENDING_APPROVAL) {
    const error = new Error('Governance Profile is not editable.');
    error.status = 409;
    error.details = {
      code: 'GOVERNANCE_PROFILE_NOT_EDITABLE',
      status: current.status,
    };
    throw error;
  }

  const existingActions = Array.isArray(current?.policies?.governableActions)
    ? current.policies.governableActions
    : [];
  const updatesByAction = new Map(editablePolicies.map((item) => [item.action, item]));

  editablePolicies.forEach((item) => {
    const exists = existingActions.some(
      (policy) => String(policy?.action || '').trim().toUpperCase() === item.action
    );
    if (!exists) {
      const error = new Error('Governance policy action is not present in this profile.');
      error.status = 400;
      error.details = { code: 'GOVERNANCE_POLICY_ACTION_NOT_FOUND', action: item.action };
      throw error;
    }
  });

  const previousPolicies = clone(current.policies);
  const updatedAt = nowIso();
  const profile = {
    ...current,
    updatedAt,
    updatedBy,
    policies: {
      ...(current.policies || {}),
      governableActions: existingActions.map((policy) => {
        const action = String(policy?.action || '').trim().toUpperCase();
        const update = updatesByAction.get(action);
        if (!update) return policy;
        return {
          ...policy,
          autonomousLimit: update.autonomousLimit,
          humanApprovalLimit: update.humanApprovalLimit,
          decisions: buildLimitDecisions(update.autonomousLimit, update.humanApprovalLimit),
        };
      }),
    },
  };

  store.profiles[key] = profile;
  store.profileVersions[key] = sortProfilesByVersion(
    (store.profileVersions[key] || [current]).map((item) =>
      item?.profileId === profile.profileId ||
      getProfileVersion(item) === getProfileVersion(profile)
        ? profile
        : item
    )
  );

  recordHistory(store, {
    eventType: 'GOVERNANCE_PROFILE_UPDATED',
    cpsId: key,
    profileId: profile.profileId,
    profileVersion: profile.profileVersion,
    status: profile.status,
    updatedAt,
    updatedBy,
    previousPolicies,
    newPolicies: profile.policies,
  });

  writeStore(store);
  return { profile, governanceStatus: profile.status };
};

export const approveGovernanceProfile = (cpsId, approvedBy = 'human-operator') => {
  const key = normalizeCpsKey(cpsId);
  const store = readStore();
  const current = store.profiles[key] || null;
  if (!current) {
    const error = new Error('Governance Profile not found. Complete Plug first.');
    error.status = 409;
    error.details = { code: 'GOVERNANCE_PROFILE_REQUIRED', cpsId: key };
    throw error;
  }
  if (normalizeGovernanceStatus(current.status) !== GOVERNANCE_STATUS.PENDING_APPROVAL) {
    const error = new Error('Only the pending profile for the active Plug cycle can be approved.');
    error.status = 409;
    error.details = {
      code: 'GOVERNANCE_PROFILE_NOT_PENDING',
      cpsId: key,
      status: current.status,
      profileId: current.profileId,
    };
    throw error;
  }
  const profile = {
    ...approveGovernanceProfileSnapshot(current, approvedBy, nowIso()),
    profileId: current.profileId || buildGovernanceProfileId(key, current.profileVersion),
  };
  store.profiles[key] = profile;
  store.profileVersions[key] = sortProfilesByVersion(
    (store.profileVersions[key] || [current]).map((item) =>
      item?.profileId === profile.profileId ||
      getProfileVersion(item) === getProfileVersion(profile)
        ? profile
        : item
    )
  );
  const event = recordHistory(store, {
    eventType: 'GOVERNANCE_PROFILE_APPROVED',
    cpsId: key,
    profileId: profile.profileId,
    profileVersion: profile.profileVersion,
    status: profile.status,
    approvedBy,
  });
  recordHcmGovernanceEvent('governance_profile_approved', event);
  writeStore(store);
  return { profile, governanceStatus: profile.status };
};

export const rejectGovernanceProfile = (cpsId, rejectedBy = 'human-operator') => {
  const key = normalizeCpsKey(cpsId);
  const store = readStore();
  const current = store.profiles[key] || null;
  if (!current) {
    const error = new Error('Governance Profile not found. Complete Plug first.');
    error.status = 409;
    error.details = { code: 'GOVERNANCE_PROFILE_REQUIRED', cpsId: key };
    throw error;
  }
  const profile = {
    ...current,
    status: GOVERNANCE_STATUS.DENIED,
    rejectedAt: nowIso(),
    rejectedBy,
  };
  store.profiles[key] = profile;
  store.profileVersions[key] = sortProfilesByVersion(
    (store.profileVersions[key] || [current]).map((item) =>
      item?.profileId === profile.profileId ||
      getProfileVersion(item) === getProfileVersion(profile)
        ? profile
        : item
    )
  );
  const event = recordHistory(store, {
    eventType: 'GOVERNANCE_PROFILE_REJECTED',
    cpsId: key,
    profileId: profile.profileId,
    profileVersion: profile.profileVersion,
    status: profile.status,
    rejectedBy,
  });
  recordHcmGovernanceEvent('governance_profile_rejected', event);
  writeStore(store);
  return { profile, governanceStatus: profile.status };
};

export const checkGovernance = async (request = {}) => {
  const cpsId = normalizeCpsKey(request.cpsId);
  const store = readStore();
  const profile = store.profiles[cpsId] || buildGovernanceProfile(cpsId);
  const status = normalizeGovernanceStatus(profile.status);
  let result;

  if (status !== GOVERNANCE_STATUS.APPROVED) {
    result = {
      decision: GOVERNANCE_DECISION.DENY,
      policy: 'governanceStatus',
      limit: null,
      requested: Number.isFinite(Number(request.variation)) ? Number(request.variation) : null,
      reason: 'GOVERNANCE_NOT_APPROVED',
    };
  } else {
    result = evaluateGovernancePolicy({
      profile,
      action: request.action,
      variation: request.variation,
    });
  }

  const actionPolicy = getGovernableActionPolicy(profile, request.action);
  let pendingAction = null;
  if (result.decision === GOVERNANCE_DECISION.HUMAN_APPROVAL) {
    const actionId = `GA-${String((Object.keys(store.pendingActions || {}).length + 1)).padStart(3, '0')}`;
    pendingAction = {
      actionId,
      cpsId,
      action: String(request.action || '').trim().toUpperCase(),
      requestedValue: Number.isFinite(Number(request.requestedValue))
        ? Number(request.requestedValue)
        : result.requested,
      variation: result.requested,
      unit: request.unit || '%',
      source: request.source || 'recommendation',
      recommendation: request.recommendation || null,
      episodeId: request.episodeId || null,
      correlationId: request.correlationId || request.episodeId || null,
      governanceDecision: result.decision,
      policy: result.policy,
      autonomousLimit: actionPolicy?.autonomousLimit ?? result.limit,
      status: GOVERNANCE_ACTION_STATUS.PENDING_HUMAN_APPROVAL,
      executionStatus: 'NOT_EXECUTED',
      executionResult: null,
      createdAt: nowIso(),
      approvedAt: null,
      rejectedAt: null,
    };
    store.pendingActions[actionId] = pendingAction;
  }

  const event = recordHistory(store, {
    eventType: 'GOVERNANCE_CHECK',
    cpsId,
    action: String(request.action || '').trim().toUpperCase(),
    requested: result.requested,
    unit: request.unit || '%',
    policy: result.policy,
    governanceResult: result.decision,
    pendingActionId: pendingAction?.actionId || null,
    episodeId: request.episodeId || null,
    recommendation: request.recommendation || null,
  });
  recordHcmGovernanceEvent('governance_check', event);

  let execution = null;
  if (result.decision === GOVERNANCE_DECISION.ALLOW) {
    const actionRequest = {
      cpsId,
      action: String(request.action || '').trim().toUpperCase(),
      requestedValue: Number.isFinite(Number(request.requestedValue))
        ? Number(request.requestedValue)
        : result.requested,
      variation: result.requested,
      unit: request.unit || '%',
      source: request.source || 'recommendation',
      recommendation: request.recommendation || null,
      episodeId: request.episodeId || null,
      governanceDecision: result.decision,
    };
    try {
      execution = await executeGovernedAction(actionRequest);
      recordGovernedActionExecution(store, actionRequest, execution, result.decision);
    } catch (error) {
      execution = {
        executionStatus: 'FAILED',
        executedAt: nowIso(),
        error: error?.message || String(error),
        details: error?.details || null,
      };
      recordHistory(store, {
        eventType: 'GOVERNED_ACTION_EXECUTION_FAILED',
        cpsId,
        action: actionRequest.action,
        requested: actionRequest.requestedValue,
        unit: actionRequest.unit,
        governanceDecision: result.decision,
        episodeId: request.episodeId || null,
        executionStatus: execution.executionStatus,
        error: execution.error,
      });
      recordHcmGovernanceEvent('governed_action_executed', {
        ...actionRequest,
        eventType: 'GOVERNED_ACTION_EXECUTION_FAILED',
        executionStatus: execution.executionStatus,
        error: execution.error,
        episodeId: request.episodeId || null,
      });
    }
  }

  writeStore(store);

  return {
    ...result,
    profile,
    governanceStatus: profile.status,
    pendingAction,
    execution,
  };
};

export const listPendingGovernanceActions = () =>
  Object.values(readStore().pendingActions || {}).sort(
    (a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0)
  );

export const decideGovernanceAction = async (actionId, decision, decidedBy = 'human-operator') => {
  const store = readStore();
  const action = store.pendingActions[actionId];
  if (!action) {
    const error = new Error('Pending governance action not found.');
    error.status = 404;
    throw error;
  }

  const approved = decision === GOVERNANCE_ACTION_STATUS.APPROVED;
  const next = {
    ...action,
    status: approved ? GOVERNANCE_ACTION_STATUS.APPROVED : GOVERNANCE_ACTION_STATUS.REJECTED,
    decidedBy,
    decidedAt: nowIso(),
    approvedAt: approved ? nowIso() : action.approvedAt,
    rejectedAt: approved ? action.rejectedAt : nowIso(),
    executionStatus: approved ? 'PENDING_EXECUTION' : 'NOT_EXECUTED',
  };
  store.pendingActions[actionId] = next;

  const event = recordHistory(store, {
    eventType: 'GOVERNANCE_HUMAN_DECISION',
    actionId,
    cpsId: next.cpsId,
    action: next.action,
    decision: approved ? 'APPROVED' : 'REJECTED',
    decidedBy,
    episodeId: next.episodeId || null,
  });
  recordHcmGovernanceEvent('governance_human_decision', event);

  if (approved) {
    try {
      const execution = await executeGovernedAction({
        ...next,
        governanceActionId: actionId,
        governanceDecision: GOVERNANCE_DECISION.HUMAN_APPROVAL,
      });
      store.pendingActions[actionId] = {
        ...next,
        executionStatus: 'EXECUTED',
        executedAt: execution.executedAt,
        executionResult: execution,
      };
      recordGovernedActionExecution(store, store.pendingActions[actionId], execution, GOVERNANCE_DECISION.HUMAN_APPROVAL);
    } catch (error) {
      store.pendingActions[actionId] = {
        ...next,
        executionStatus: 'FAILED',
        executionError: error?.message || String(error),
        executionFailedAt: nowIso(),
      };
      recordHistory(store, {
        eventType: 'GOVERNED_ACTION_EXECUTION_FAILED',
        actionId,
        cpsId: next.cpsId,
        action: next.action,
        governanceDecision: GOVERNANCE_DECISION.HUMAN_APPROVAL,
        episodeId: next.episodeId || null,
        executionStatus: 'FAILED',
        error: error?.message || String(error),
      });
      recordHcmGovernanceEvent('governed_action_executed', {
        ...store.pendingActions[actionId],
        eventType: 'GOVERNED_ACTION_EXECUTION_FAILED',
        executionStatus: 'FAILED',
        error: error?.message || String(error),
      });
    }
  }

  writeStore(store);
  return { action: store.pendingActions[actionId], pendingActions: listPendingGovernanceActions() };
};

export const governanceStoreService = {
  ensureGovernanceProfile,
  createGovernanceProfileForPlug,
  closeGovernancePlugCycle,
  getGovernanceProfile,
  updateGovernanceProfile,
  approveGovernanceProfile,
  rejectGovernanceProfile,
  checkGovernance,
  listPendingGovernanceActions,
  decideGovernanceAction,
};
