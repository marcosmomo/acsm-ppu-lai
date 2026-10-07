import { GOVERNANCE_STATUS, normalizeGovernanceStatus } from './policies.js';

export const canApproveLifecycleGovernance = ({ registered, profile } = {}) =>
  Boolean(
    registered &&
      profile?.profileId &&
      normalizeGovernanceStatus(profile?.status) === GOVERNANCE_STATUS.PENDING_APPROVAL
  );

export const governancePermitsPlay = ({ registered, profile } = {}) =>
  Boolean(
    registered &&
      profile?.profileId &&
      normalizeGovernanceStatus(profile?.status) === GOVERNANCE_STATUS.APPROVED
  );
