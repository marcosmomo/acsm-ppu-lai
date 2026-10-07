import { transitionPlugAssetLifecycle, getPlugState } from './plugStore.mjs';
import { closeGovernancePlugCycle } from '../../services/governance/governanceStore.js';

export const executeAcsmUnplug = (cpsId, timestamp = new Date().toISOString()) => {
  const transition = transitionPlugAssetLifecycle(cpsId, 'unplug', timestamp);
  if (!transition.ok) return transition;

  const governance = closeGovernancePlugCycle(transition.cpsId, 'lifecycle-unplug');
  return {
    ok: true,
    cpsId: transition.cpsId,
    lifecyclePhase: 'unplug',
    operationalState: 'unplugged',
    governanceStatus: governance.governanceStatus,
    plugCycleStatus: governance.profile?.plugCycleStatus || 'CLOSED',
    state: getPlugState(),
  };
};
