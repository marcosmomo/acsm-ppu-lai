// ======================================================
// Build Root-Cause Reasoning for ACSM / CPS Analytics
// ======================================================
// Espera receber em msg.payload algo prÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â³ximo de:
// {
//   cpsId: "CPS-007",
//   ts: 1774003654680,
//
//   oee: 0.569,                  // opcional
//   availability: 0.724,         // opcional
//   performance: 0.817,          // opcional
//   quality: 0.962,              // opcional
//
//   // OU em bloco:
//   oee: {
//     availability: 0.724,
//     performance: 0.817,
//     quality: 0.962,
//     oee: 0.569
//   },
//
//   status: {
//     operationalState: "maintenance",
//     healthState: "warning",
//     availabilityState: "degraded",
//     lastHeartbeat: 1774003654000
//   },
//
//   operationalData: {
//     CurrentTemperature: 24.3,
//     CurrentRPM: 0,
//     CurrentTorque: 0,
//     PieceCounter: 120,
//     CycleTimeMs: 0,
//     OperationMode: "stop"
//   },
//
//   telemetry: {
//     currentTemperature: 24.3,
//     currentRPM: 0,
//     currentTorque: 0,
//     cycleTimeMs: 0
//   },
//
//   learning: {
//     predictedLoss: "availability",
//     anomalyScore: 0.81,
//     degradationTrend: "rising"
//   },
//
//   history: {
//     downtimeEvents: 4,
//     maintenanceEvents: 3,
//     awaitingReplacementEvents: 2,
//     faultEvents: 1,
//     microStops: 5,
//     rejectedPieces: 0,
//     idealCycleTimeMs: 5000,
//     actualCycleTimeMsAvg: 7100
//   }
// }
//
// SaÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â­da:
//   msg.reasoning = reasoning
//   msg.payload.reasoning = reasoning
// ======================================================

function num(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function toText(v, def = 'unknown') {
  const s = String(v ?? '').trim();
  return s || def;
}

function round1(v) {
  return Math.round(num(v, 0) * 10) / 10;
}

function round4(v) {
  return Math.round(num(v, 0) * 10000) / 10000;
}

function normalizeMetric(v) {
  const n = num(v, 0);

  // Se vier em escala percentual (0..100), converte para 0..1
  if (n > 1) return clamp(n / 100, 0, 1);

  // Se jÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¡ vier em escala 0..1
  return clamp(n, 0, 1);
}

function pctLoss(metricValue) {
  const v = num(metricValue, 1);

  // caso venha em escala 0..1
  if (v <= 1) {
    return clamp(1 - v, 0, 1);
  }

  // caso venha em escala 0..100
  return clamp((100 - v) / 100, 0, 1);
}

function severityFromLoss(lossValue) {
  const v = normalizeMetric(lossValue);
  if (v >= 0.40) return 'high';
  if (v >= 0.20) return 'medium';
  return 'low';
}

function normalizeKey(k) {
  return String(k || '').toLowerCase();
}

function humanizeLoss(key) {
  const k = normalizeKey(key);
  if (k === 'availability') return 'Availability';
  if (k === 'performance') return 'Performance';
  if (k === 'quality') return 'Quality';
  return 'Unknown';
}

function buildEvidenceList(ctx) {
  const ev = [];

  if (ctx.status.operationalState === 'maintenance') {
    ev.push('current_state_is_maintenance');
  }
  if (ctx.status.operationalState === 'awaiting_replacement') {
    ev.push('current_state_is_awaiting_replacement');
  }
  if (ctx.status.operationalState === 'failure') {
    ev.push('current_state_is_failure');
  }
  if (ctx.operational.CurrentRPM <= 0) {
    ev.push('rpm_is_zero');
  }
  if (ctx.operational.OperationMode === 'stop') {
    ev.push('operation_mode_is_stop');
  }
  if (ctx.history.downtimeEvents > 0) {
    ev.push(`downtime_events_${ctx.history.downtimeEvents}`);
  }
  if (ctx.history.maintenanceEvents > 0) {
    ev.push(`maintenance_events_${ctx.history.maintenanceEvents}`);
  }
  if (ctx.history.awaitingReplacementEvents > 0) {
    ev.push(`awaiting_replacement_events_${ctx.history.awaitingReplacementEvents}`);
  }
  if (ctx.history.faultEvents > 0) {
    ev.push(`fault_events_${ctx.history.faultEvents}`);
  }
  if (ctx.history.microStops > 0) {
    ev.push(`microstops_${ctx.history.microStops}`);
  }
  if (ctx.history.rejectedPieces > 0) {
    ev.push(`rejected_pieces_${ctx.history.rejectedPieces}`);
  }
  if (
    ctx.history.idealCycleTimeMs > 0 &&
    ctx.history.actualCycleTimeMsAvg > ctx.history.idealCycleTimeMs
  ) {
    ev.push('actual_cycle_time_above_ideal');
  }
  if (ctx.learning.anomalyScore >= 0.7) {
    ev.push(`high_anomaly_score_${round1(ctx.learning.anomalyScore)}`);
  }
  if (ctx.learning.degradationTrend === 'rising') {
    ev.push('degradation_trend_rising');
  }

  return ev;
}

function chooseDominantLoss(losses, learning) {
  const ordered = [...losses].sort((a, b) => b.loss - a.loss);
  let dominant = ordered[0];

  const predicted = normalizeKey(learning.predictedLoss);
  if (
    predicted &&
    ['availability', 'performance', 'quality'].includes(predicted)
  ) {
    const predictedItem = losses.find(x => x.key === predicted);
    if (predictedItem) {
      const diff = Math.abs(predictedItem.loss - dominant.loss);
      if (diff <= 0.05) dominant = predictedItem;
    }
  }

  return dominant;
}

function buildAvailabilityReasoning(ctx, dominantLossValue) {
  const causes = [];
  const actions = [];
  const evidence = [];

  if (ctx.status.operationalState === 'maintenance') {
    causes.push('the CPS is currently in maintenance state');
    evidence.push('maintenance_state_detected');
  }
  if (ctx.status.operationalState === 'awaiting_replacement') {
    causes.push('the CPS is currently awaiting replacement');
    evidence.push('awaiting_replacement_state_detected');
  }
  if (ctx.status.operationalState === 'failure') {
    causes.push('the CPS is currently in failure state');
    evidence.push('failure_state_detected');
  }
  if (ctx.history.downtimeEvents > 0) {
    causes.push(`recent downtime events were observed (${ctx.history.downtimeEvents})`);
    evidence.push(`downtime_events=${ctx.history.downtimeEvents}`);
  }
  if (ctx.history.maintenanceEvents > 0) {
    causes.push(`maintenance interventions were recorded (${ctx.history.maintenanceEvents})`);
    evidence.push(`maintenance_events=${ctx.history.maintenanceEvents}`);
  }
  if (ctx.history.awaitingReplacementEvents > 0) {
    causes.push(`replacement-related interruptions were recorded (${ctx.history.awaitingReplacementEvents})`);
    evidence.push(`awaiting_replacement_events=${ctx.history.awaitingReplacementEvents}`);
  }
  if (ctx.operational.CurrentRPM <= 0 && ctx.operational.OperationMode === 'stop') {
    causes.push('the asset is not producing (RPM = 0 and operation mode = stop)');
    evidence.push('rpm_zero_and_stop_mode');
  }

  actions.push('inspect downtime history and identify the most frequent stop causes');
  actions.push('verify maintenance log, replacement triggers, and state transition history');
  actions.push('check whether the CPS is stuck in maintenance or awaiting replacement longer than expected');
  actions.push('correlate zero-RPM periods with stop, failure, or maintenance events');

  const explanation = causes.length
    ? `The dominant OEE loss is availability (${(dominantLossValue * 100).toFixed(1)}%). This indicates that the main productivity reduction is associated with asset unavailability. Probable causal reading: ${causes.join('; ')}.`
    : `The dominant OEE loss is availability (${(dominantLossValue * 100).toFixed(1)}%). This suggests that the main productivity reduction is related to downtime, interruption, or maintenance-driven unavailability.`;

  const recommendation =
    'Prioritize investigation of downtime causes, maintenance occurrences, replacement conditions, and prolonged inactive states before optimizing speed or quality.';

  return {
    explanation,
    recommendation,
    evidence,
    probableCause: 'availability_related_operational_unavailability',
    actions
  };
}

function buildPerformanceReasoning(ctx, dominantLossValue) {
  const causes = [];
  const actions = [];
  const evidence = [];

  if (
    ctx.history.idealCycleTimeMs > 0 &&
    ctx.history.actualCycleTimeMsAvg > ctx.history.idealCycleTimeMs
  ) {
    causes.push(
      `average cycle time is above the ideal reference (${ctx.history.actualCycleTimeMsAvg} ms vs ${ctx.history.idealCycleTimeMs} ms)`
    );
    evidence.push('cycle_time_above_reference');
  }

  if (ctx.operational.CurrentRPM > 0 && ctx.operational.CurrentRPM < 10) {
    causes.push(`the asset is running at low RPM (${ctx.operational.CurrentRPM})`);
    evidence.push(`low_rpm=${ctx.operational.CurrentRPM}`);
  }

  if (ctx.history.microStops > 0) {
    causes.push(`micro-stops were detected (${ctx.history.microStops})`);
    evidence.push(`microstops=${ctx.history.microStops}`);
  }

  if (ctx.learning.degradationTrend === 'rising') {
    causes.push('the learning layer indicates a rising degradation trend');
    evidence.push('degradation_trend_rising');
  }

  actions.push('compare actual cycle time against the expected cycle baseline');
  actions.push('investigate micro-stops, speed losses, and intermittent flow interruptions');
  actions.push('inspect mechanical drag, conveyor rhythm, actuator response, and upstream/downstream bottlenecks');
  actions.push('correlate RPM, torque, and cycle time variation over the last time window');

  const explanation = causes.length
    ? `The dominant OEE loss is performance (${(dominantLossValue * 100).toFixed(1)}%). This indicates production below the expected operating pace. Probable causal reading: ${causes.join('; ')}.`
    : `The dominant OEE loss is performance (${(dominantLossValue * 100).toFixed(1)}%). This suggests speed loss, increased cycle time, micro-stops, or reduced effective throughput.`;

  const recommendation =
    'Prioritize investigation of cycle time increase, low-speed operation, micro-stops, and local bottlenecks before focusing on availability or quality improvement.';

  return {
    explanation,
    recommendation,
    evidence,
    probableCause: 'performance_related_speed_or_cycle_loss',
    actions
  };
}

function buildQualityReasoning(ctx, dominantLossValue) {
  const causes = [];
  const actions = [];
  const evidence = [];

  if (ctx.history.rejectedPieces > 0) {
    causes.push(`rejected or nonconforming pieces were detected (${ctx.history.rejectedPieces})`);
    evidence.push(`rejected_pieces=${ctx.history.rejectedPieces}`);
  }

  if (ctx.learning.anomalyScore >= 0.7) {
    causes.push(`the anomaly score is elevated (${round1(ctx.learning.anomalyScore)})`);
    evidence.push(`anomaly_score=${round1(ctx.learning.anomalyScore)}`);
  }

  if (ctx.operational.CurrentTorque > 0) {
    causes.push(`torque variation should be checked (${ctx.operational.CurrentTorque})`);
    evidence.push(`torque=${ctx.operational.CurrentTorque}`);
  }

  actions.push('inspect rejected pieces and identify defect patterns');
  actions.push('verify process stability, actuator positioning, and sensor consistency');
  actions.push('correlate anomalies with torque, temperature, and state transitions');
  actions.push('review quality events, rework occurrences, and acceptance thresholds');

  const explanation = causes.length
    ? `The dominant OEE loss is quality (${(dominantLossValue * 100).toFixed(1)}%). This indicates that the main reduction in effective output is associated with nonconformity or process instability. Probable causal reading: ${causes.join('; ')}.`
    : `The dominant OEE loss is quality (${(dominantLossValue * 100).toFixed(1)}%). This suggests rejects, rework, or instability affecting conforming output.`;

  const recommendation =
    'Prioritize investigation of defect generation, process instability, sensor consistency, and quality-event recurrence before tuning speed or downtime routines.';

  return {
    explanation,
    recommendation,
    evidence,
    probableCause: 'quality_related_process_instability',
    actions
  };
}

// ------------------------------------------------------
// 1) NormalizaÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â§ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â£o da entrada
// ------------------------------------------------------
const p = msg.payload || {};

const rawAvailability =
  p?.oee?.availability ??
  p?.availability ??
  null;

const rawPerformance =
  p?.oee?.performanceDisplay ??
  p?.performance ??
  p?.oee?.performance ??
  p?.performanceAccumulated ??
  null;

const rawQuality =
  p?.oee?.quality ??
  p?.quality ??
  null;

const rawOEE =
  p?.oee?.oee ??
  p?.oeeGlobal ??
  p?.oee ??
  null;

const ctx = {
  cpsId: p.cpsId || msg.cpsId || 'unknown_cps',
  ts: p.ts || p.timestamp || Date.now(),
  oee: {
    availability: normalizeMetric(rawAvailability),
    performance: normalizeMetric(rawPerformance),
    quality: normalizeMetric(rawQuality),
    oee: normalizeMetric(rawOEE)
  },
  status: {
    operationalState: toText(
      p?.status?.operationalState || p?.status?.state || p?.operationalState || p?.process?.featureStatus,
      'unknown'
    ).toLowerCase(),
    healthState: toText(
      p?.status?.healthState || p?.healthState,
      'unknown'
    ).toLowerCase(),
    availabilityState: toText(
      p?.status?.availabilityState || p?.availabilityState,
      'unknown'
    ).toLowerCase(),
    lastHeartbeat: p?.status?.lastHeartbeat || p?.lastHeartbeat || null
  },
  operational: {
    CurrentTemperature: num(
      p?.operationalData?.CurrentTemperature,
      p?.telemetry?.currentTemperature ?? p?.CurrentTemperature
    ),
    CurrentRPM: num(
      p?.operationalData?.CurrentRPM,
      p?.telemetry?.currentRPM ?? p?.CurrentRPM
    ),
    CurrentTorque: num(
      p?.operationalData?.CurrentTorque,
      p?.telemetry?.currentTorque ?? p?.CurrentTorque
    ),
    PieceCounter: num(
      p?.operationalData?.PieceCounter,
      p?.production?.pieceCounterAbs ?? p?.PieceCounter
    ),
    CycleTimeMs: num(
      p?.operationalData?.CycleTimeMs,
      p?.telemetry?.cycleTimeMs ?? p?.CycleTimeMs
    ),
    OperationMode: toText(
      p?.operationalData?.OperationMode || p?.OperationMode || p?.process?.operationMode,
      'unknown'
    ).toLowerCase()
  },
  learning: {
    predictedLoss: toText(
      p?.learning?.predictedLoss,
      ''
    ).toLowerCase(),
    anomalyScore: num(
      p?.learning?.anomalyScore,
      0
    ),
    degradationTrend: toText(
      p?.learning?.degradationTrend,
      p?.learning?.state || 'unknown'
    ).toLowerCase()
  },
  history: {
    downtimeEvents: num(p?.history?.downtimeEvents, 0),
    maintenanceEvents: num(p?.history?.maintenanceEvents, 0),
    awaitingReplacementEvents: num(p?.history?.awaitingReplacementEvents, 0),
    faultEvents: num(p?.history?.faultEvents, 0),
    microStops: num(p?.history?.microStops, 0),
    rejectedPieces: num(
      p?.history?.rejectedPieces,
      p?.production?.rejectPieces ?? 0
    ),
    idealCycleTimeMs: num(
      p?.history?.idealCycleTimeMs,
      p?.process?.idealCycleTimeMs ?? 0
    ),
    actualCycleTimeMsAvg: num(p?.history?.actualCycleTimeMsAvg, 0)
  }
};

// ------------------------------------------------------
// 2) CÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¡lculo de perdas
// ------------------------------------------------------
const losses = [
  {
    key: 'availability',
    metricValue: round4(ctx.oee.availability),
    loss: round4(pctLoss(ctx.oee.availability))
  },
  {
    key: 'performance',
    metricValue: round4(ctx.oee.performance),
    loss: round4(pctLoss(ctx.oee.performance))
  },
  {
    key: 'quality',
    metricValue: round4(ctx.oee.quality),
    loss: round4(pctLoss(ctx.oee.quality))
  }
];

const dominant = chooseDominantLoss(losses, ctx.learning);

// ------------------------------------------------------
// 3) Reasoning especÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â­fico por perda dominante
// ------------------------------------------------------
let reasoningBlock;

if (dominant.key === 'availability') {
  reasoningBlock = buildAvailabilityReasoning(ctx, dominant.loss);
} else if (dominant.key === 'performance') {
  reasoningBlock = buildPerformanceReasoning(ctx, dominant.loss);
} else {
  reasoningBlock = buildQualityReasoning(ctx, dominant.loss);
}

const genericEvidence = buildEvidenceList(ctx);
const mergedEvidence = [...new Set([...(reasoningBlock.evidence || []), ...genericEvidence])];

// ------------------------------------------------------
// 4) Objeto final pronto para o front
// ------------------------------------------------------
const reasoning = {
  generatedAt: new Date(ctx.ts).toISOString(),
  timestamp: ctx.ts,
  cpsId: ctx.cpsId,

  title: 'Root-Cause Reasoning',
  subtitle: 'Causal reading of the dominant OEE loss and technical investigation recommendation.',

  dominantLoss: dominant.key,
  dominantLossLabel: humanizeLoss(dominant.key),
  dominantLossValue: round4(dominant.loss),
  dominantMetricValue: round4(dominant.metricValue),
  severity: severityFromLoss(dominant.loss),

  losses: {
    availability: losses.find(x => x.key === 'availability')?.loss ?? 0,
    performance: losses.find(x => x.key === 'performance')?.loss ?? 0,
    quality: losses.find(x => x.key === 'quality')?.loss ?? 0
  },

  metrics: {
    availability: round4(ctx.oee.availability),
    performance: round4(ctx.oee.performance),
    quality: round4(ctx.oee.quality),
    oee: round4(ctx.oee.oee)
  },

  probableCause: reasoningBlock.probableCause,
  explanation: reasoningBlock.explanation,

  recommendation: reasoningBlock.recommendation,
  technicalRecommendation: reasoningBlock.recommendation,

  recommendedActions: reasoningBlock.actions || [],
  evidence: mergedEvidence,

  context: {
    operationalState: ctx.status.operationalState,
    healthState: ctx.status.healthState,
    operationMode: ctx.operational.OperationMode,
    rpm: ctx.operational.CurrentRPM,
    torque: ctx.operational.CurrentTorque,
    cycleTimeMs: ctx.operational.CycleTimeMs,
    pieceCounter: ctx.operational.PieceCounter,
    anomalyScore: ctx.learning.anomalyScore,
    degradationTrend: ctx.learning.degradationTrend
  }
};

// ------------------------------------------------------
// 5) SaÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â­da
// ------------------------------------------------------
msg.reasoning = reasoning;

msg.payload = {
  ...(typeof p === 'object' ? p : {}),
  reasoning
};

return msg;


