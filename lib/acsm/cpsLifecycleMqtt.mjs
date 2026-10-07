export const CPSLAI1_LIFECYCLE_TOPIC = 'acsm/cpslai1/lifecycle';

export const CPSLAI1_LIFECYCLE_PHASES = new Set([
  'plug',
  'play',
  'unplug',
]);

export const normalizeCpsLai1LifecyclePhase = (phase) => {
  const normalized = String(phase || '').trim().toLowerCase();
  return CPSLAI1_LIFECYCLE_PHASES.has(normalized) ? normalized : null;
};

export const buildCpsLai1LifecyclePayload = (phase, timestamp = new Date()) => {
  const lifecyclePhase = normalizeCpsLai1LifecyclePhase(phase);
  if (!lifecyclePhase) return null;

  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;

  return {
    schemaVersion: '1.0',
    cpsId: 'cpslai1',
    lifecyclePhase,
    timestamp: date.toISOString(),
    source: 'ACSM',
  };
};

export const shouldPublishCpsLai1Lifecycle = (previousPhase, nextPhase) => {
  const normalizedNext = normalizeCpsLai1LifecyclePhase(nextPhase);
  if (!normalizedNext) return false;
  return normalizeCpsLai1LifecyclePhase(previousPhase) !== normalizedNext;
};

const CPSLAI1_LIFECYCLE_TRANSITIONS = Object.freeze({
  plug: new Set(['plug', 'play']),
  play: new Set(['play', 'unplug']),
  unplug: new Set(['unplug', 'plug']),
});

export const canTransitionCpsLai1Lifecycle = (previousPhase, nextPhase) => {
  const previous = normalizeCpsLai1LifecyclePhase(previousPhase);
  const next = normalizeCpsLai1LifecyclePhase(nextPhase);
  if (!next) return false;
  if (!previous) return true;
  return CPSLAI1_LIFECYCLE_TRANSITIONS[previous]?.has(next) === true;
};

const normalizeCpsId = (value) => {
  const cleaned = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  const match = cleaned.match(/^([a-z]+)0*([0-9]+)$/);
  return match ? `${match[1]}${match[2]}` : cleaned;
};

export const normalizeRegisteredCpsLifecycle = (
  cps,
  {
    operationallyLinked = false,
    unplugActive = false,
    preserveTransitionPhase = false,
  } = {}
) => {
  if (!cps || normalizeCpsId(cps?.id ?? cps?.cpsId) !== 'cpslai1') return cps;

  const currentPhase = normalizeCpsLai1LifecyclePhase(
    cps?.lifecyclePhase ?? cps?.lifecycle?.phase ?? cps?.lifecycle?.currentPhase
  );
  const lifecyclePhase = unplugActive
    ? 'unplug'
    : operationallyLinked
      ? 'play'
      : preserveTransitionPhase && currentPhase === 'unplug'
        ? currentPhase
        : 'plug';

  return {
    ...cps,
    lifecyclePhase,
    lifecycle: {
      ...(cps?.lifecycle || {}),
      currentPhase: lifecyclePhase,
      phase: lifecyclePhase,
    },
  };
};
