const asArray = (value) => Array.isArray(value) ? value : [];

export function buildPlugState(snapshot = {}) {
  const assets = asArray(snapshot.assets).filter(Boolean);

  return {
    acsmId: snapshot.acsmId || 'acsm1',
    phase: 'plug',
    timestamp: snapshot.timestamp || new Date().toISOString(),
    evidenceStatus: assets.length ? 'AVAILABLE' : 'NO_DATA',
    summary: {
      registeredCPS: assets.length,
      operationallyLinked: Math.max(0, Number(snapshot.operationallyLinked) || 0),
    },
    assets: assets.map((asset) => ({
      cps: asset.cps || null,
      identification: asset.identification || null,
      aas: asset.aas || null,
      capabilities: asArray(asset.capabilities),
      interfaces: asset.interfaces || null,
      supportedPhases: asArray(asset.supportedPhases),
      governance: asset.governance || {
        profileId: null,
        profileVersion: null,
        status: 'NOT_AVAILABLE',
      },
      lifecycleEvidence: asset.lifecycleEvidence || {
        maintenanceCount: 0,
        lastEvolutionTimestamp: null,
        events: [],
      },
    })),
  };
}
