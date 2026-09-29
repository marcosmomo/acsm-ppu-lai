import { normalizeCpsId } from '../acsm/config.js';

export const GOVERNANCE_STATUS = Object.freeze({
  NOT_DEFINED: 'NOT_DEFINED',
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  REVOKED: 'REVOKED',
});

export const GOVERNANCE_DECISION = Object.freeze({
  ALLOW: 'ALLOW',
  HUMAN_APPROVAL: 'HUMAN_APPROVAL',
  DENY: 'DENY',
});

export const GOVERNANCE_ACTION_STATUS = Object.freeze({
  PENDING_HUMAN_APPROVAL: 'PENDING_HUMAN_APPROVAL',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
});

export const GOVERNANCE_TEMPLATES = Object.freeze({
  cps1: {
    template: 'WELDING',
    capability: 'Welding',
    action: 'ADJUST_WELDING_CURRENT',
    autonomousLimit: 5,
    humanApprovalLimit: 15,
    policy: 'autonomousAdjustmentLimit',
    conceptualPolicies: {
      telemetry: 'REQUIRED',
      health: 'REQUIRED',
      oee: 'REQUIRED',
      recommendation: 'ALLOW',
      maintenanceRequest: 'ALLOW',
    },
  },
  cps5: {
    template: 'VISION',
    capability: 'Vision Inspection',
    action: 'ADJUST_INSPECTION_THRESHOLD',
    autonomousLimit: 5,
    humanApprovalLimit: 10,
    policy: 'autonomousAdjustmentLimit',
    conceptualPolicies: {},
  },
  cps7: {
    template: 'TRANSPORT',
    capability: 'Transportation',
    action: 'ADJUST_TRANSPORT_SPEED',
    autonomousLimit: 10,
    humanApprovalLimit: 20,
    policy: 'autonomousAdjustmentLimit',
    conceptualPolicies: {},
  },
  cpslai1: {
    template: 'DISTRIBUTION_CONVEYOR',
    capability: 'Distribution/Conveyor Station',
    action: 'ADJUST_TRANSPORT_SPEED',
    autonomousLimit: 10,
    humanApprovalLimit: 20,
    policy: 'autonomousAdjustmentLimit',
    conceptualPolicies: {
      telemetry: 'REQUIRED',
      health: 'REQUIRED',
      oee: 'REQUIRED',
      recommendation: 'ALLOW',
      maintenanceRequest: 'ALLOW',
    },
  },
  cpslai2: {
    template: 'JOINING',
    capability: 'Joining Station',
    action: 'ADJUST_JOINING_FORCE',
    autonomousLimit: 5,
    humanApprovalLimit: 15,
    policy: 'autonomousAdjustmentLimit',
    conceptualPolicies: {},
  },
  cpslai3: {
    template: 'SORTING',
    capability: 'Sorting Station',
    action: 'ADJUST_SORTING_THRESHOLD',
    autonomousLimit: 5,
    humanApprovalLimit: 10,
    policy: 'autonomousAdjustmentLimit',
    conceptualPolicies: {},
  },
});

export const normalizeGovernanceStatus = (status) => {
  const normalized = String(status || '').trim().toUpperCase();
  return GOVERNANCE_STATUS[normalized] || GOVERNANCE_STATUS.NOT_DEFINED;
};

export const getGovernanceTemplateForCps = (cpsId, cps = {}) => {
  const normalizedCpsId = normalizeCpsId(cpsId || cps?.id || cps?.cpsId);
  const direct = GOVERNANCE_TEMPLATES[normalizedCpsId];
  if (direct) return direct;

  const text = [
    cps?.capability,
    cps?.assetType,
    cps?.descricao,
    ...(Array.isArray(cps?.funcionalidades)
      ? cps.funcionalidades.flatMap((item) => [item?.key, item?.nome, item?.descricao])
      : []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (text.includes('weld') || text.includes('sold')) return GOVERNANCE_TEMPLATES.cps1;
  if (text.includes('vision') || text.includes('visao') || text.includes('inspection')) {
    return GOVERNANCE_TEMPLATES.cps5;
  }
  if (text.includes('transport') || text.includes('conveyor') || text.includes('ship')) {
    return GOVERNANCE_TEMPLATES.cps7;
  }

  return null;
};

export const buildGovernanceProfileId = (cpsId, profileVersion = 1) => {
  const normalizedCpsId = normalizeCpsId(cpsId);
  const version = Math.max(1, Number(profileVersion) || 1);
  return `GOV-${normalizedCpsId.toUpperCase()}-${String(version).padStart(3, '0')}`;
};

export const buildGovernanceProfile = (cpsId, cps = {}, existing = null, options = {}) => {
  const normalizedCpsId = normalizeCpsId(cpsId || cps?.id || cps?.cpsId);
  const template = getGovernanceTemplateForCps(normalizedCpsId, cps);
  const profileVersion = Math.max(
    1,
    Number(options.profileVersion ?? existing?.profileVersion ?? 1) || 1
  );
  const isNewApprovalCycle = options.status === GOVERNANCE_STATUS.PENDING_APPROVAL;

  if (!normalizedCpsId || !template) {
    return {
      cpsId: normalizedCpsId,
      profileId: null,
      profileVersion,
      template: null,
      capability: null,
      status: GOVERNANCE_STATUS.NOT_DEFINED,
      createdAt: options.createdAt || (isNewApprovalCycle ? new Date().toISOString() : existing?.createdAt) || new Date().toISOString(),
      approvedAt: null,
      approvedBy: null,
      policies: {},
    };
  }

  return {
    cpsId: normalizedCpsId,
    profileId: buildGovernanceProfileId(normalizedCpsId, profileVersion),
    profileVersion,
    template: template.template,
    capability: template.capability,
    previousProfileId: options.previousProfileId || null,
    previousProfileVersion: options.previousProfileVersion || null,
    status: options.status || existing?.status || GOVERNANCE_STATUS.PENDING_APPROVAL,
    createdAt: options.createdAt || (isNewApprovalCycle ? new Date().toISOString() : existing?.createdAt) || new Date().toISOString(),
    approvedAt: isNewApprovalCycle ? null : existing?.approvedAt || null,
    approvedBy: isNewApprovalCycle ? null : existing?.approvedBy || null,
    policies: existing?.policies || {
      governableActions: [
        {
          action: template.action,
          policy: template.policy,
          unit: '%',
          autonomousLimit: template.autonomousLimit,
          humanApprovalLimit: template.humanApprovalLimit,
          decisions: {
            [`variation <= ${template.autonomousLimit}%`]: GOVERNANCE_DECISION.ALLOW,
            [`variation > ${template.autonomousLimit}% and <= ${template.humanApprovalLimit}%`]:
              GOVERNANCE_DECISION.HUMAN_APPROVAL,
            [`variation > ${template.humanApprovalLimit}%`]: GOVERNANCE_DECISION.DENY,
          },
        },
      ],
      ...template.conceptualPolicies,
    },
  };
};

export const getGovernableActionPolicy = (profile, action) => {
  const requestedAction = String(action || '').trim().toUpperCase();
  return (profile?.policies?.governableActions || []).find(
    (item) => String(item?.action || '').trim().toUpperCase() === requestedAction
  );
};

export const evaluateGovernancePolicy = ({ profile, action, variation }) => {
  const policy = getGovernableActionPolicy(profile, action);
  const requested = Math.abs(Number(variation));

  if (!policy || !Number.isFinite(requested)) {
    return {
      decision: GOVERNANCE_DECISION.DENY,
      policy: policy?.policy || 'undefinedGovernableAction',
      limit: null,
      requested: Number.isFinite(requested) ? requested : null,
      reason: !policy ? 'ACTION_NOT_GOVERNABLE' : 'INVALID_VARIATION',
    };
  }

  if (requested <= policy.autonomousLimit) {
    return {
      decision: GOVERNANCE_DECISION.ALLOW,
      policy: policy.policy,
      limit: policy.autonomousLimit,
      requested,
    };
  }

  if (requested <= policy.humanApprovalLimit) {
    return {
      decision: GOVERNANCE_DECISION.HUMAN_APPROVAL,
      policy: policy.policy,
      limit: policy.autonomousLimit,
      requested,
    };
  }

  return {
    decision: GOVERNANCE_DECISION.DENY,
    policy: policy.policy,
    limit: policy.humanApprovalLimit,
    requested,
  };
};

export const extractGovernableRecommendation = (payload = {}) => {
  const source = payload?.reasoning || payload?.recommendation || payload?.actionPlan || payload;
  const action = String(
    payload?.governableAction ||
      payload?.action ||
      payload?.actionType ||
      source?.governableAction ||
      source?.action ||
      source?.actionType ||
      ''
  )
    .trim()
    .toUpperCase();
  const variation = Number(
    payload?.variation ??
      payload?.variationPct ??
      payload?.requestedValue ??
      source?.variation ??
      source?.variationPct ??
      source?.requestedValue
  );

  if (!action || !Number.isFinite(variation)) return null;

  return {
    action,
    variation,
    requestedValue: Number(payload?.requestedValue ?? source?.requestedValue ?? variation),
    unit: payload?.unit || source?.unit || '%',
    source: payload?.source || 'recommendation',
    recommendation:
      typeof payload?.recommendation === 'string'
        ? payload.recommendation
        : typeof source?.recommendation === 'string'
          ? source.recommendation
          : null,
  };
};
