import { normalizeCpsId } from '../acsm/config.js';
import {
  GOVERNANCE_STATUS,
  isGovernanceProfileApproved,
  normalizeGovernanceStatus,
} from './policies.js';

const assetCpsId = (asset) =>
  normalizeCpsId(
    asset?.cps?.cpsId ||
      asset?.cps?.id ||
      asset?.cpsId ||
      asset?.interfaces?.baseTopic
  );

export function evaluateLifecyclePlayGate({ cpsId, profile, plugState } = {}) {
  const normalizedCpsId = normalizeCpsId(cpsId);
  const asset = (Array.isArray(plugState?.assets) ? plugState.assets : []).find(
    (candidate) => assetCpsId(candidate) === normalizedCpsId
  );
  const governanceStatus = normalizeGovernanceStatus(profile?.status);

  if (!asset) {
    return {
      ok: false,
      status: 409,
      cpsId: normalizedCpsId,
      reason: 'CPS_NOT_REGISTERED',
      governanceStatus,
    };
  }

  if (!asset?.aas?.id) {
    return {
      ok: false,
      status: 409,
      cpsId: normalizedCpsId,
      reason: 'AAS_REQUIRED',
      governanceStatus,
    };
  }

  if (!profile?.profileId) {
    return {
      ok: false,
      status: 409,
      cpsId: normalizedCpsId,
      reason: 'GOVERNANCE_PROFILE_REQUIRED',
      governanceStatus: GOVERNANCE_STATUS.NOT_DEFINED,
    };
  }

  if (!isGovernanceProfileApproved(profile)) {
    return {
      ok: false,
      status: 409,
      cpsId: normalizedCpsId,
      reason: 'GOVERNANCE_APPROVAL_REQUIRED',
      governanceStatus,
      profileId: profile.profileId,
      profileVersion: profile.profileVersion,
    };
  }

  return {
    ok: true,
    status: 200,
    cpsId: normalizedCpsId,
    reason: 'GOVERNANCE_GATE_PASSED',
    governanceStatus: GOVERNANCE_STATUS.APPROVED,
    profileId: profile.profileId,
    profileVersion: profile.profileVersion,
    approvedAt: profile.approvedAt || null,
    approvedBy: profile.approvedBy || null,
  };
}
