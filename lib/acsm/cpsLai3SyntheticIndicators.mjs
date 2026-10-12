export const CPS_LAI3_SYNTHETIC_MAX_AGE_MS = 10_000;
export const CPS_SYNTHETIC_MAX_AGE_MS = CPS_LAI3_SYNTHETIC_MAX_AGE_MS;

const isPercentOrNull = (value) =>
  value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100);

export const normalizeCpsSyntheticIndicator = (
  kind,
  payload,
  receivedAt = Date.now(),
  maxAgeMs = CPS_SYNTHETIC_MAX_AGE_MS,
  expectedCpsId = payload?.cpsId
) => {
  if (!['oee', 'health'].includes(kind)) return null;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (!['cpslai2', 'cpslai3'].includes(expectedCpsId)) return null;
  if (payload.cpsId !== expectedCpsId || payload.indicatorClass !== 'SYNTHETIC') return null;
  if (!['SYNTHETIC', 'HELD_LAST_VALUE', 'NOT_COMPUTED'].includes(payload.calculationState)) return null;

  const sampleTime = Date.parse(payload.timestamp || '');
  if (!Number.isFinite(sampleTime) || sampleTime > receivedAt || receivedAt - sampleTime > maxAgeMs) return null;

  const indicator = kind === 'oee' ? payload.oee : payload.health;
  if (!indicator || indicator.unit !== 'percent') return null;
  const values = kind === 'oee'
    ? [indicator.current, indicator.availability, indicator.performance, indicator.quality]
    : [indicator.current, indicator.score];
  if (values.some(value => !isPercentOrNull(value))) return null;

  return { payload, receivedAt, staleAt: receivedAt + maxAgeMs };
};

export const normalizeCpsLai3SyntheticIndicator = (
  kind,
  payload,
  receivedAt = Date.now(),
  maxAgeMs = CPS_LAI3_SYNTHETIC_MAX_AGE_MS
) => normalizeCpsSyntheticIndicator(kind, payload, receivedAt, maxAgeMs, 'cpslai3');

export const formatSyntheticPercent = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(1)}%` : '—';
