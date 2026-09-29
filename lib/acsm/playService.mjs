const DEFAULT_MINIMUM_HISTORY = 6;

const finite = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const clamp01 = (value) => Math.max(0, Math.min(1, value));

const normalizePhase = (cps = {}) =>
  String(
    cps.lifecyclePhase ?? cps.lifecycle?.phase ?? cps.lifecycle?.currentPhase ?? cps.currentPhase ?? ''
  ).trim().toLowerCase();

const normalizeStatus = (cps = {}) =>
  String(
    cps.operationalState ??
      cps.globalState?.state ??
      cps.globalState?.status ??
      cps.operationalData?.operationMode ??
      cps.status ??
      ''
  ).trim().toLowerCase();

const validRatio = (value) => {
  const number = finite(value);
  return number !== null && number >= 0 && number <= 1 ? number : null;
};

const getOee = (cps = {}) => {
  const source = cps.oee && typeof cps.oee === 'object' ? cps.oee : {};
  const availability = validRatio(source.availability);
  const performance = validRatio(source.performance);
  const quality = validRatio(source.quality);
  const direct = validRatio(source.oee ?? source.value ?? source.current);
  const current = direct ?? (
    availability !== null && performance !== null && quality !== null
      ? Number((availability * performance * quality).toFixed(4))
      : null
  );

  if (current === null) return null;
  return { current, availability, performance, quality };
};

const meanNullable = (values) => {
  const valid = values.filter((value) => value !== null);
  return valid.length ? Number((valid.reduce((sum, value) => sum + value, 0) / valid.length).toFixed(4)) : null;
};

const dominantLoss = (oee) => {
  const dimensions = [
    ['AVAILABILITY', oee.availability],
    ['PERFORMANCE', oee.performance],
    ['QUALITY', oee.quality],
  ].filter(([, value]) => value !== null);
  if (!dimensions.length) return null;
  dimensions.sort((a, b) => a[1] - b[1]);
  return dimensions[0][0];
};

const healthState = (health = {}) => {
  const label = String(health.label ?? health.healthLabel ?? health.state ?? '').toLowerCase();
  if (label === 'healthy' || label === 'ok') return 'HEALTHY';
  if (label === 'warning' || label === 'degraded' || label === 'attention') return 'DEGRADED';
  if (label === 'critical' || label === 'failure' || label === 'failed') return 'CRITICAL';
  const score = finite(health.score ?? health.healthScore);
  if (score === null) return 'UNKNOWN';
  if (score >= 80) return 'HEALTHY';
  if (score >= 50) return 'DEGRADED';
  return 'CRITICAL';
};

const worstHealthState = (states) => {
  const rank = { UNKNOWN: 0, HEALTHY: 1, DEGRADED: 2, CRITICAL: 3 };
  return states.reduce((worst, state) => rank[state] > rank[worst] ? state : worst, 'UNKNOWN');
};

const firstPresent = (...values) =>
  values.find((value) => value !== undefined && value !== null && value !== '');

export function buildPlayState(snapshot = {}) {
  const allCps = Array.isArray(snapshot.cps) ? snapshot.cps.filter(Boolean) : [];
  const active = allCps.filter((cps) => normalizePhase(cps) === 'play');
  const measured = active.map((cps) => ({ cps, oee: getOee(cps) })).filter((item) => item.oee);
  const analytics = snapshot.analytics && typeof snapshot.analytics === 'object' ? snapshot.analytics : {};
  const historySize = Math.max(0, finite(snapshot.historySize ?? analytics.historySummary?.samples) ?? 0);
  const minimumHistory = Math.max(1, finite(snapshot.minimumHistory) ?? DEFAULT_MINIMUM_HISTORY);

  const globalOEE = measured.length
    ? {
        current: meanNullable(measured.map(({ oee }) => oee.current)),
        availability: meanNullable(measured.map(({ oee }) => oee.availability)),
        performance: meanNullable(measured.map(({ oee }) => oee.performance)),
        quality: meanNullable(measured.map(({ oee }) => oee.quality)),
        evidenceStatus: measured.length === active.length ? 'AVAILABLE' : 'INSUFFICIENT_DATA',
      }
    : { current: null, availability: null, performance: null, quality: null, evidenceStatus: 'NO_DATA' };

  const healthEvidence = active
    .map((cps) => ({ state: healthState(cps.health), score: finite(cps.health?.score ?? cps.health?.healthScore) }))
    .filter((health) => health.state !== 'UNKNOWN' || health.score !== null);
  const systemHealth = healthEvidence.length
    ? {
        state: worstHealthState(healthEvidence.map((health) => health.state)),
        score: meanNullable(healthEvidence.map((health) => health.score)),
      }
    : { state: 'UNKNOWN', score: null };

  const ranked = measured
    .map(({ cps, oee }) => ({ cps, oee, reason: dominantLoss(oee) }))
    .sort((a, b) => a.oee.current - b.oee.current);
  const critical = ranked[0] || null;
  const criticalCPS = critical
    ? { cpsId: critical.cps.cpsId ?? critical.cps.id ?? null, oee: critical.oee.current, reason: critical.reason }
    : null;

  const statuses = active.map(normalizeStatus);
  let systemState = 'UNKNOWN';
  if (statuses.some((status) => ['failure', 'failed', 'critical', 'degraded', 'warning', 'maintenance'].includes(status))) {
    systemState = 'DEGRADED';
  } else if (statuses.length && statuses.every((status) => ['stopped', 'stop', 'idle', 'ready'].includes(status))) {
    systemState = 'STOPPED';
  } else if (statuses.some((status) => ['running', 'active', 'play', 'playing'].includes(status))) {
    systemState = systemHealth.state === 'CRITICAL' || systemHealth.state === 'DEGRADED' ? 'DEGRADED' : 'RUNNING';
  }

  const learningState = globalOEE.evidenceStatus === 'NO_DATA'
    ? 'NO_DATA'
    : historySize < minimumHistory ? 'INSUFFICIENT_HISTORY' : 'READY';
  const pattern = learningState === 'READY'
    ? firstPresent(analytics.learningPattern, analytics.systemLearningModel?.pattern, analytics.learning?.pattern)
    : null;
  const learning = {
    state: learningState,
    historySize,
    minimumHistory,
    ready: learningState === 'READY',
    pattern: pattern ?? null,
  };

  const analyticsLoss = firstPresent(
    analytics.dominantChronicLoss,
    analytics.reasoning?.dominantLoss,
    analytics.systemReasoning?.dominantLoss
  );
  const loss = analyticsLoss ? String(analyticsLoss).toUpperCase() : critical?.reason ?? null;
  const confidence = finite(firstPresent(analytics.reasoning?.confidence, analytics.systemReasoning?.confidence, analytics.confidence));
  const reasoning = loss && criticalCPS
    ? { dominantLoss: loss, criticalCPS: criticalCPS.cpsId, confidence, state: 'AVAILABLE' }
    : { dominantLoss: null, criticalCPS: null, confidence: null, state: 'INSUFFICIENT_DATA' };

  const predicted = learning.ready
    ? validRatio(firstPresent(analytics.predictedSystemOEE, analytics.systemForecast?.predictedSystemOEE, analytics.predictedGlobalOEE))
    : null;
  const prediction = {
    predictedSystemOEE: predicted,
    horizon: predicted === null ? null : firstPresent(analytics.systemForecast?.horizon, 'next_window'),
    state: predicted === null ? 'INSUFFICIENT_HISTORY' : 'AVAILABLE',
  };

  const recommendationText = firstPresent(
    analytics.reasoning?.recommendation,
    analytics.systemReasoning?.recommendation,
    analytics.recommendation
  );
  const governableAction = firstPresent(
    analytics.reasoning?.governableAction,
    analytics.systemReasoning?.governableAction,
    analytics.actionPlan?.governableAction
  );
  const recommendation = recommendationText && reasoning.state === 'AVAILABLE'
    ? {
        recommendation: recommendationText,
        governableAction: governableAction ?? null,
        cpsId: criticalCPS?.cpsId ?? null,
        confidence,
        state: 'AVAILABLE',
      }
    : { recommendation: null, governableAction: null, cpsId: null, confidence: null, state: 'NO_RECOMMENDATION' };

  let interpretation;
  if (globalOEE.evidenceStatus === 'NO_DATA') {
    interpretation = { state: 'NO_EVIDENCE', summary: 'No system-level explanation is currently available.' };
  } else if (!learning.ready) {
    interpretation = {
      state: 'INSUFFICIENT_HISTORY',
      summary: 'System-level interpretation is not yet available because the operational history is insufficient.',
    };
  } else if (loss && criticalCPS?.cpsId) {
    interpretation = {
      state: 'AVAILABLE',
      summary: `System OEE is primarily affected by ${loss.toLowerCase()} losses associated with ${criticalCPS.cpsId}.`,
    };
  } else {
    interpretation = { state: 'NO_EVIDENCE', summary: 'No system-level explanation is currently available.' };
  }

  return {
    acsmId: snapshot.acsmId || 'acsm1',
    phase: 'play',
    timestamp: new Date().toISOString(),
    globalOEE,
    activeCPS: {
      count: active.length,
      total: Math.max(allCps.length, finite(snapshot.totalCps) ?? 0),
      cps: active.map((cps) => ({
        cpsId: cps.cpsId ?? cps.id ?? null,
        name: cps.displayName ?? cps.nome ?? cps.name ?? cps.cpsName ?? cps.cpsId ?? cps.id ?? null,
        status: normalizeStatus(cps) || 'unknown',
      })),
    },
    systemHealth,
    criticalCPS,
    systemState,
    learning,
    reasoning,
    prediction,
    recommendation,
    interpretation,
  };
}

export { DEFAULT_MINIMUM_HISTORY };
