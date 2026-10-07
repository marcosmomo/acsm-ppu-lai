import { buildPlugState } from './plugService.mjs';
import { getActiveGovernanceProfile } from '../../services/governance/governanceStore.js';

const STORE_KEY = Symbol.for('acsm.plug.runtime-store');
const emptySnapshot = { acsmId: 'acsm1', assets: [], operationallyLinked: 0 };
const store = globalThis[STORE_KEY] || { snapshot: emptySnapshot };
globalThis[STORE_KEY] = store;

const normalizeCpsKey = (value) =>
  String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '').replace(/(cps)0+/, '$1');

export const transitionPlugAssetLifecycle = (cpsId, lifecyclePhase, timestamp = new Date().toISOString()) => {
  const normalizedId = normalizeCpsKey(cpsId);
  const asset = (store.snapshot.assets || []).find((candidate) =>
    [candidate?.cps?.cpsId, candidate?.cps?.id, candidate?.interfaces?.baseTopic]
      .some((value) => normalizeCpsKey(value) === normalizedId)
  );
  if (!normalizedId || !asset) return { ok: false, cpsId: normalizedId, reason: 'CPS_NOT_REGISTERED' };

  const phase = String(lifecyclePhase || '').trim().toLowerCase();
  asset.cps = {
    ...(asset.cps || {}),
    lifecyclePhase: phase,
    lifecycle: {
      ...(asset.cps?.lifecycle || {}),
      currentPhase: phase,
      phase,
    },
    ...(phase === 'unplug'
      ? {
          operationalState: 'unplugged',
          status: 'unplugged',
          globalState: {
            ...(asset.cps?.globalState || {}),
            state: 'unplugged',
            status: 'unplugged',
            playEnabled: false,
          },
        }
      : {}),
  };
  store.snapshot.timestamp = timestamp;
  if (phase === 'unplug') {
    store.snapshot.operationallyLinked = (store.snapshot.assets || []).filter((candidate) =>
      String(candidate?.cps?.lifecyclePhase || candidate?.cps?.lifecycle?.currentPhase || '').toLowerCase() === 'play'
    ).length;
  }

  return { ok: true, cpsId: normalizedId, lifecyclePhase: phase, state: getPlugState() };
};

const withCurrentGovernance = (state) => ({
  ...state,
  assets: (state.assets || []).map((asset) => {
    const cpsId = asset?.cps?.cpsId || asset?.cps?.id || asset?.interfaces?.baseTopic;
    const lifecyclePhase = String(asset?.cps?.lifecyclePhase || asset?.cps?.lifecycle?.currentPhase || '').toLowerCase();
    const activeProfile = cpsId && lifecyclePhase === 'plug'
      ? getActiveGovernanceProfile(cpsId)
      : null;
    return {
      ...asset,
      governance: {
        ...(asset?.governance || {}),
        activeProfile,
        profileId: activeProfile?.profileId || null,
        profileVersion: activeProfile?.profileVersion ?? null,
        status: activeProfile?.status || 'NOT_DEFINED',
        approvedAt: activeProfile?.approvedAt || null,
        approvedBy: activeProfile?.approvedBy || null,
        plugCycleStatus: activeProfile?.plugCycleStatus || null,
      },
    };
  }),
});

export const updatePlugSnapshot = (snapshot = {}) => {
  store.snapshot = {
    ...store.snapshot,
    ...snapshot,
    assets: Array.isArray(snapshot.assets) ? snapshot.assets : store.snapshot.assets,
  };
  return withCurrentGovernance(buildPlugState(store.snapshot));
};

export const getPlugState = () => withCurrentGovernance(buildPlugState(store.snapshot));
