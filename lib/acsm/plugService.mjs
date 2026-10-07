import { normalizeRegisteredCpsLifecycle } from './cpsLifecycleMqtt.mjs';

const asArray = (value) => Array.isArray(value) ? value : [];

const normalizeCpsId = (value) => {
  const cleaned = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  const match = cleaned.match(/^([a-z]+)0*([0-9]+)$/);
  return match ? `${match[1]}${match[2]}` : cleaned;
};

const getAssetCpsId = (asset) => normalizeCpsId(
  asset?.cps?.cpsId || asset?.cps?.id || asset?.cpsId || asset?.interfaces?.baseTopic
);

function getCapabilityProjection(asset) {
  return {
    capabilities: asArray(asset.capabilities),
  };
}

export function buildPlugState(snapshot = {}) {
  const assets = asArray(snapshot.assets).filter(Boolean);
  const operationallyLinked = Math.max(0, Number(snapshot.operationallyLinked) || 0);

  return {
    acsmId: snapshot.acsmId || 'acsm1',
    phase: 'plug',
    timestamp: snapshot.timestamp || new Date().toISOString(),
    evidenceStatus: assets.length ? 'AVAILABLE' : 'NO_DATA',
    summary: {
      registeredCPS: assets.length,
      operationallyLinked,
    },
    assets: assets.map((asset) => {
      const capabilityProjection = getCapabilityProjection(asset);
      const currentLifecyclePhase = String(
        asset?.cps?.lifecyclePhase || asset?.cps?.lifecycle?.currentPhase || ''
      ).toLowerCase();
      const cps = ['registered', 'ready'].includes(currentLifecyclePhase)
        ? asset.cps
        : normalizeRegisteredCpsLifecycle(asset.cps, {
            operationallyLinked: operationallyLinked > 0 && currentLifecyclePhase === 'play',
            preserveTransitionPhase: true,
          });
      return {
        cps: cps ? { ...asset.cps, lifecyclePhase: cps.lifecyclePhase } : null,
        identification: asset.identification || null,
        aas: asset.aas || null,
        capabilities: capabilityProjection.capabilities,
        interfaces: asset.interfaces || null,
        supportedPhases: asArray(asset.supportedPhases),
        governance: asset.governance || {
          profileId: null,
          profileVersion: null,
          status: 'NOT_AVAILABLE',
        },
        lifecycleEvidence: asset.lifecycleEvidence || {
          maintenanceCount: 0,
          events: [],
        },
      };
    }),
  };
}
