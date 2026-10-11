const PHYSICAL_CPS_ID = 'cpslai1';
const INDEPENDENT_PHYSICAL_MODE_CPS_IDS = new Set(['cpslai1', 'cpslai2', 'cpslai3']);

const normalizeCpsId = (cpsOrId) => {
  const rawId = typeof cpsOrId === 'object' ? cpsOrId?.id ?? cpsOrId?.cpsId : cpsOrId;
  const cleaned = String(rawId || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return cleaned.replace(/^([a-z]+)0*([0-9]+)$/, '$1$2');
};

export const PHYSICAL_OPERATION_MODES = new Set([
  'INIT',
  'MANUAL',
  'STEP_BY_STEP',
  'AUTOMATIC',
  'UNKNOWN',
]);

export const normalizePhysicalOperationMode = (value) => {
  const normalized = String(value ?? '').trim().toUpperCase();
  return PHYSICAL_OPERATION_MODES.has(normalized) ? normalized : 'UNKNOWN';
};

export const isPhysicalCps = (cpsOrId) => {
  return normalizeCpsId(cpsOrId) === PHYSICAL_CPS_ID;
};

export const hasIndependentPhysicalOperationMode = (cpsOrId) =>
  INDEPENDENT_PHYSICAL_MODE_CPS_IDS.has(normalizeCpsId(cpsOrId));

export const operationalDataForAcsmState = (cps, operationalState) => {
  const current = { ...(cps?.operationalData || {}) };
  if (normalizeCpsId(cps) === 'cpslai3') return { ...current, operationMode: 'UNKNOWN' };
  if (hasIndependentPhysicalOperationMode(cps)) return current;
  return { ...current, operationMode: operationalState };
};

export const applyPhysicalStatus = (cps, payload = {}) => ({
  ...(cps?.operationalData || {}),
  operationMode:
    payload?.operationMode !== undefined || payload?.OperationMode !== undefined
      ? normalizePhysicalOperationMode(payload?.operationMode ?? payload?.OperationMode)
      : cps?.operationalData?.operationMode ?? null,
  operationModeEvidence:
    payload?.operationModeEvidence ?? cps?.operationalData?.operationModeEvidence ?? null,
  supervisorState: payload?.supervisorState ?? cps?.operationalData?.supervisorState ?? null,
  evidenceStatus: payload?.evidenceStatus ?? cps?.operationalData?.evidenceStatus ?? null,
});

export const mergeNonStatusOperationalData = (cps, patch = {}) => {
  const cpsId = normalizeCpsId(cps);
  if (!hasIndependentPhysicalOperationMode(cpsId)) {
    return { ...(cps?.operationalData || {}), ...patch };
  }

  const { operationMode: _ignoredOperationMode, ...safePatch } = patch || {};
  const merged = { ...(cps?.operationalData || {}), ...safePatch };
  return cpsId === 'cpslai3' ? { ...merged, operationMode: 'UNKNOWN' } : merged;
};

export const applyRememberedRuntimeMode = (cps, rememberedMode) => {
  if (!cps || !rememberedMode) return cps;
  if (normalizeCpsId(cps) === 'cpslai3') {
    return {
      ...cps,
      operationalData: { ...(cps?.operationalData || {}), operationMode: 'UNKNOWN' },
    };
  }
  if (hasIndependentPhysicalOperationMode(cps)) return cps;
  return {
    ...cps,
    operationalData: {
      ...(cps?.operationalData || {}),
      operationMode: rememberedMode,
    },
  };
};
