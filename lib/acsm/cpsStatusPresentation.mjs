const normalizeToken = (value) =>
  String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');

export const normalizeOperationalState = (value) => {
  const state = normalizeToken(value);
  if (['active', 'run', 'running', 'rodando'].includes(state)) return 'running';
  if (['stop', 'stopped', 'paused', 'inactive', 'parado'].includes(state)) return 'stopped';
  if (['maintenance', 'manutencao', 'manutenção'].includes(state)) return 'maintenance';
  if (['awaiting_replacement', 'waiting', 'espera'].includes(state)) return 'awaiting_replacement';
  if (['failure', 'fail', 'error', 'falha'].includes(state)) return 'failure';
  if (['ready', 'pronto'].includes(state)) return 'ready';
  if (['unplug', 'unplugged'].includes(state)) return 'unplugged';
  if (['return', 'returning'].includes(state)) return 'returning';
  return 'unknown';
};

const OPERATIONAL_STATES = Object.freeze({
  running: { label: 'Running', tone: 'active' },
  stopped: { label: 'Stopped', tone: 'stopped' },
  maintenance: { label: 'Maintenance', tone: 'maintenance' },
  awaiting_replacement: { label: 'Awaiting replacement', tone: 'waiting' },
  failure: { label: 'Failure', tone: 'failure' },
  ready: { label: 'Ready', tone: 'ready' },
  unplugged: { label: 'Unplugged', tone: 'failure' },
  returning: { label: 'Returning', tone: 'ready' },
  unknown: { label: 'Unknown', tone: 'unknown' },
});

export const getOperationalStatePresentation = (value) => {
  const state = normalizeOperationalState(value);
  return { state, ...OPERATIONAL_STATES[state] };
};

export const normalizePhysicalOperationMode = (value) => {
  const mode = normalizeToken(value).toUpperCase();
  if (mode === 'STEPBYSTEP') return 'STEP_BY_STEP';
  return ['INIT', 'MANUAL', 'STEP_BY_STEP', 'AUTOMATIC'].includes(mode) ? mode : 'UNKNOWN';
};

const MODE_TONES = Object.freeze({
  AUTOMATIC: 'active',
  MANUAL: 'manual',
  STEP_BY_STEP: 'maintenance',
  INIT: 'ready',
  UNKNOWN: 'unknown',
});

export const getOperationModePresentation = (value) => {
  const mode = normalizePhysicalOperationMode(value);
  return { mode, label: mode, tone: MODE_TONES[mode] };
};

const CPS_LAI_01_VALIDATED_MODE_EVIDENCE = new Set([
  'PHYSICALLY_VALIDATED',
  'PHYSICALLY_VALIDATED_MODE',
]);

const applyValidatedPhysicalModePresentation = (operationMode, operationalState) => {
  if (operationMode === 'MANUAL') return 'running';
  if (operationMode === 'STEP_BY_STEP') return 'maintenance';
  if (operationMode === 'AUTOMATIC') {
    const confirmedOperationalState = normalizeOperationalState(operationalState);
    return ['running', 'stopped'].includes(confirmedOperationalState)
      ? confirmedOperationalState
      : operationalState;
  }
  return operationalState;
};

export const getOperationalStateForPresentation = (cps, operationalState, physicalEvidence = {}) => {
  const cpsId = String(cps?.id ?? cps?.cpsId ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/^([a-z]+)0*([0-9]+)$/, '$1$2');
  if (cpsId === 'cpslai2') {
    const operationMode = normalizePhysicalOperationMode(physicalEvidence.operationMode);
    if (physicalEvidence.valid !== true || operationMode === 'UNKNOWN') return 'unknown';
    return applyValidatedPhysicalModePresentation(operationMode, operationalState);
  }
  if (cpsId === 'cpslai3') {
    const derived = deriveCpsLai3PhysicalOperationMode({
      cpsId,
      evidence: physicalEvidence.modeEvidence,
      communication: physicalEvidence.communication,
    });
    if (!derived.valid) return 'unknown';
    if (derived.operationMode === 'MANUAL') return 'running';
    if (derived.operationMode === 'STEP_BY_STEP') return 'maintenance';
    if (derived.operationMode === 'AUTOMATIC') {
      const internalState = normalizeOperationalState(operationalState);
      return ['running', 'stopped'].includes(internalState) ? internalState : 'unknown';
    }
    return 'unknown';
  }
  if (cpsId !== 'cpslai1') return operationalState;

  const operationalData = cps?.operationalData || {};
  const evidence = operationalData.operationModeEvidence || {};
  const communication = cps?.health?.communication || {};
  const communicationFresh =
    communication.dataFresh ??
    evidence.communicationFresh ??
    evidence.dataFresh;
  const explicitlyOffline = communicationFresh === false ||
    communication.connected === false ||
    evidence.valid === false ||
    evidence.stale === true;
  if (explicitlyOffline) return 'unknown';

  const evidenceStatus = String(
    operationalData.evidenceStatus ?? evidence.evidenceStatus ?? ''
  ).trim().toUpperCase();
  if (!CPS_LAI_01_VALIDATED_MODE_EVIDENCE.has(evidenceStatus)) return operationalState;

  const hasCurrentEvidence = communicationFresh === true ||
    communication.connected === true ||
    (evidence.valid === true && evidence.stale !== true);
  if (!hasCurrentEvidence) return operationalState;

  const operationMode = normalizePhysicalOperationMode(operationalData.operationMode);
  return applyValidatedPhysicalModePresentation(operationMode, operationalState);
};

export const operationalStateBadgeClass = (value) =>
  `feat-badge feat-${getOperationalStatePresentation(value).tone}`;

export const operationModeBadgeClass = (value) =>
  `feat-badge feat-${getOperationModePresentation(value).tone}`;

export const operationalStateCardClass = (value, cpsId) => {
  const normalizedCpsId = String(cpsId ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/^([a-z]+)0*([0-9]+)$/, '$1$2');
  const physicalCardClass = normalizedCpsId === 'cpslai1'
    ? ' cps-lai-01-operational-card'
    : normalizedCpsId === 'cpslai2'
      ? ' cps-lai-02-operational-card'
      : normalizedCpsId === 'cpslai3'
        ? ' cps-lai-03-operational-card'
        : '';
  return `cps-item-play status-${getOperationalStatePresentation(value).state}${physicalCardClass}`;
};
import { deriveCpsLai3PhysicalOperationMode } from './cpsLai3OperationMode.mjs';
