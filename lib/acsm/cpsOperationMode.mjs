const PHYSICAL_CPS_ID = 'cpslai1';

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
  const rawId = typeof cpsOrId === 'object' ? cpsOrId?.id ?? cpsOrId?.cpsId : cpsOrId;
  const cleaned = String(rawId || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const normalized = cleaned.replace(/^([a-z]+)0*([0-9]+)$/, '$1$2');
  return normalized === PHYSICAL_CPS_ID;
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
  if (!isPhysicalCps(cps)) {
    return { ...(cps?.operationalData || {}), ...patch };
  }

  const { operationMode: _ignoredOperationMode, ...safePatch } = patch || {};
  return { ...(cps?.operationalData || {}), ...safePatch };
};

export const applyRememberedRuntimeMode = (cps, rememberedMode) => {
  if (!cps || !rememberedMode || isPhysicalCps(cps)) return cps;
  return {
    ...cps,
    operationalData: {
      ...(cps?.operationalData || {}),
      operationMode: rememberedMode,
    },
  };
};
