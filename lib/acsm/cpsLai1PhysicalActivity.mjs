export const CPSLAI1_ACTIVITY_FIELDS = Object.freeze({
  PieceAtEntry: 'G1BG3',
  PieceAtMiddle: 'G1BG2',
  PieceAtExit: 'G1BG1',
});

export const createPhysicalActivityObservation = () => ({
  generation: 0,
  subscriptionConfirmed: false,
  observationStartedAt: null,
  lastActivityAt: null,
  lastSourceField: null,
  lastSourceTag: null,
  sensors: {},
  invalidReason: 'SUBSCRIPTION_CONTINUITY_NOT_CONFIRMED',
});

export function invalidatePhysicalActivity(observation, reason, nowMs = Date.now()) {
  return {
    ...createPhysicalActivityObservation(),
    generation: Number(observation?.generation || 0) + 1,
    invalidatedAt: nowMs,
    invalidReason: reason || 'OBSERVATION_INVALIDATED',
  };
}

export function observePhysicalSensor(observation, sample, nowMs = Date.now()) {
  const current = observation || createPhysicalActivityObservation();
  const tag = CPSLAI1_ACTIVITY_FIELDS[sample?.field];
  if (!tag || sample?.tag !== tag || typeof sample?.value !== 'boolean' || sample?.valid === false) {
    return invalidatePhysicalActivity(current, 'INVALID_REQUIRED_SENSOR_SAMPLE', nowMs);
  }

  const prior = current.sensors?.[sample.field];
  const sensors = {
    ...(current.sensors || {}),
    [sample.field]: { value: sample.value, tag, lastSeenAt: nowMs },
  };
  const baselineComplete = Object.keys(CPSLAI1_ACTIVITY_FIELDS).every((field) => sensors[field]);
  const transitioned = Boolean(prior) && prior.value !== sample.value;

  return {
    ...current,
    sensors,
    observationStartedAt:
      current.subscriptionConfirmed && baselineComplete
        ? current.observationStartedAt ?? nowMs
        : null,
    lastActivityAt: transitioned ? nowMs : current.lastActivityAt,
    lastSourceField: transitioned ? sample.field : current.lastSourceField,
    lastSourceTag: transitioned ? tag : current.lastSourceTag,
    invalidReason: current.subscriptionConfirmed
      ? (baselineComplete ? null : 'BASELINE_INCOMPLETE')
      : 'SUBSCRIPTION_CONTINUITY_NOT_CONFIRMED',
  };
}

export function classifyPhysicalActivity(observation, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const thresholdMs = options.inactivityThresholdMs ?? 5000;
  const current = observation || createPhysicalActivityObservation();
  const sourceTag = current.lastSourceTag || null;

  if (!current.subscriptionConfirmed) {
    return { state: 'UNKNOWN', observationStartedAt: null, lastActivityAt: current.lastActivityAt,
      ageMs: current.lastActivityAt === null ? null : Math.max(0, nowMs - current.lastActivityAt), sourceTag,
      reason: current.invalidReason || 'SUBSCRIPTION_CONTINUITY_NOT_CONFIRMED' };
  }
  if (current.observationStartedAt === null) {
    return { state: 'UNKNOWN', observationStartedAt: null, lastActivityAt: current.lastActivityAt,
      ageMs: null, sourceTag, reason: 'BASELINE_INCOMPLETE' };
  }
  const reference = current.lastActivityAt ?? current.observationStartedAt;
  const ageMs = Math.max(0, nowMs - reference);
  return {
    state: current.lastActivityAt !== null && ageMs <= thresholdMs ? 'RECENT' :
      ageMs > thresholdMs ? 'INACTIVE_WINDOW_EXCEEDED' : 'OBSERVING_NO_TRANSITION',
    observationStartedAt: current.observationStartedAt,
    lastActivityAt: current.lastActivityAt,
    ageMs,
    sourceTag,
    reason: current.lastActivityAt !== null && ageMs <= thresholdMs
      ? 'RECENT_VALIDATED_SENSOR_TRANSITION'
      : ageMs > thresholdMs
        ? 'NO_TRANSITION_DURING_CONTINUOUSLY_VALID_OBSERVATION'
        : 'VALID_BASELINE_AWAITING_TRANSITION_OR_THRESHOLD',
  };
}

export function deriveCpsLai1OperationalState({ dataFresh, lifecyclePhase, operationMode, activity }) {
  if (!dataFresh) return { state: 'UNKNOWN', reason: 'COMMUNICATION_NOT_FRESH' };
  if (operationMode === 'STEP_BY_STEP') return { state: 'MAINTENANCE', reason: 'VALIDATED_STEP_BY_STEP_MODE' };
  if (lifecyclePhase !== 'play' || operationMode !== 'AUTOMATIC') {
    return { state: 'UNKNOWN', reason: 'MODE_OR_LIFECYCLE_NOT_PRODUCTIVE' };
  }
  if (activity?.state === 'RECENT') return { state: 'RUNNING', reason: activity.reason };
  if (activity?.state === 'INACTIVE_WINDOW_EXCEEDED') return { state: 'STOPPED', reason: activity.reason };
  return { state: 'UNKNOWN', reason: activity?.reason || 'INSUFFICIENT_ACTIVITY_EVIDENCE' };
}
