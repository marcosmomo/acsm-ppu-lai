const normalizeCpsKey = (cpsId) =>
  String(cpsId || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '').replace(/(cps)0+/, '$1');

const CPS_ENDPOINTS = Object.freeze({
  cps1: process.env.CPS1_BASE_URL || 'http://localhost:3001',
  cps5: process.env.CPS5_BASE_URL || 'http://localhost:3005',
  cps7: process.env.CPS7_BASE_URL || 'http://localhost:3007',
});

const ACTION_TO_CPS = Object.freeze({
  ADJUST_WELDING_CURRENT: 'cps1',
  ADJUST_INSPECTION_THRESHOLD: 'cps5',
  ADJUST_TRANSPORT_SPEED: 'cps7',
});

const nowIso = () => new Date().toISOString();

export const executeGovernedAction = async (actionRequest = {}) => {
  const action = String(actionRequest.action || '').trim().toUpperCase();
  const cpsId = normalizeCpsKey(actionRequest.cpsId || ACTION_TO_CPS[action]);
  const baseUrl = CPS_ENDPOINTS[cpsId];

  if (!action || !cpsId || !baseUrl) {
    const error = new Error('Governed action cannot be resolved to a managed CPS endpoint.');
    error.status = 400;
    error.details = { cpsId, action };
    throw error;
  }

  const command = {
    type: 'governed_action',
    cpsId,
    action,
    variation: Number(actionRequest.variation ?? actionRequest.requestedValue),
    requestedValue: Number(actionRequest.requestedValue ?? actionRequest.variation),
    unit: actionRequest.unit || '%',
    source: actionRequest.source || 'governance',
    episodeId: actionRequest.episodeId || null,
    governanceActionId: actionRequest.governanceActionId || actionRequest.actionId || null,
    governanceDecision: actionRequest.governanceDecision || null,
    recommendation: actionRequest.recommendation || null,
    ts: nowIso(),
  };

  const response = await fetch(`${baseUrl}/api/cps/governed-action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  const data = await response.json().catch(() => null);

  if (!response.ok || data?.ok === false || data?.accepted !== true || data?.applied !== true) {
    const error = new Error(data?.error || `Governed action failed for ${cpsId}.`);
    error.status = response.status || 500;
    error.details = { cpsId, action, command, response: data };
    throw error;
  }

  return {
    executionStatus: 'EXECUTED',
    executedAt: nowIso(),
    accepted: data.accepted,
    applied: data.applied,
    previousValue: data.previousValue,
    newValue: data.newValue,
    appliedVariation: data.appliedVariation,
    transport: 'REST',
    endpoint: `${baseUrl}/api/cps/governed-action`,
    command,
    actionResult: data,
  };
};

export const governedActionExecutorService = {
  executeGovernedAction,
};
