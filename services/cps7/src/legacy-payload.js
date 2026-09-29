// ============================================================
// CPS7 - Build Payload for ACSM
// Entrada esperada:
//   msg.payload contendo:
//   - OEE/telemetria
//   - timeSeriesFeatures
//   - learning
//   - reasoning
// SaÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â­da:
//   msg.payload = payload semÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ntico para ACSM
// ============================================================

const p = msg.payload || {};
const now = Number(p.ts || Date.now());

function num(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

function round(v, d = 4) {
    if (!Number.isFinite(v)) return null;
    return Number(v.toFixed(d));
}

function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
}

function firstFinite(values, fallback = 0) {
    for (const value of values) {
        const n = Number(value);
        if (Number.isFinite(n)) return n;
    }
    return fallback;
}

function maxRisk(...levels) {
    const rank = { low: 1, medium: 2, high: 3 };
    return levels
        .map((level) => String(level || "").toLowerCase())
        .filter((level) => rank[level])
        .sort((a, b) => rank[b] - rank[a])[0] || "low";
}

function uniq(arr) {
    return [...new Set((arr || []).filter(Boolean))];
}

// --------------------------------------------------
// 1) Identidade e contexto
// --------------------------------------------------
const cpsId = p.cpsId || "CPS-007";
const cpsName = p.cpsName || "Transportband_50464";
const baseTopic = "cps7";

const featureStatus = String(p.process?.featureStatus || "").toLowerCase().trim();
const playEnabled = !!p.process?.playEnabled;
const rawTimeSeriesFeatures = p.timeSeriesFeatures || {};

const inputOee = firstFinite([p.oee?.oee, p.oee?.current, p.oee], 0);
const inputAvailability = firstFinite([p.availability, p.oee?.availability, rawTimeSeriesFeatures?.availability?.current], 0);
const inputPerformanceCanonical = firstFinite([
    p.performanceAccumulated,
    rawTimeSeriesFeatures?.performance?.current,
    p.oee?.performanceAccumulated,
    p.oee?.performance,
    p.performance
], 0);
const inputPerformanceDisplay = firstFinite([p.performance, p.oee?.performance, inputPerformanceCanonical], inputPerformanceCanonical);
const inputQuality = firstFinite([p.quality, p.oee?.quality, rawTimeSeriesFeatures?.quality?.current], 1);

// --------------------------------------------------
// 2) Blocos principais
// --------------------------------------------------

const oeeBlock = {
    current: round(inputOee),

    // campos principais usados pelo front. Performance canonica = performance acumulada,
    // alinhada com timeSeriesFeatures.performance.current.
    availability: round(inputAvailability),
    performance: round(inputPerformanceCanonical),
    quality: round(inputQuality),

    // auxiliares
    performanceDisplay: round(inputPerformanceDisplay),
    performanceAccumulated: round(inputPerformanceCanonical),
    performanceInstant: p.performanceInstant != null ? round(num(p.performanceInstant, 0)) : null
};

const telemetryBlock = {
    temperature: round(num(p.telemetry?.currentTemperature, 0)),
    rpm: round(num(p.telemetry?.currentRPM, 0)),
    torque: round(num(p.telemetry?.currentTorque, 0)),
    cycleTimeMs: round(num(p.telemetry?.cycleTimeMs, 0)),
    pieceCounter: round(num(p.production?.pieceCounterAbs, 0), 0)
};

const productionBlock = {
    producedDelta: round(num(p.production?.producedDelta, 0), 0),
    totalPieces: round(num(p.production?.totalPieces, 0), 0),
    goodPieces: round(num(p.production?.goodPieces, 0), 0),
    rejectPieces: round(num(p.production?.rejectPieces, 0), 0),
    rejectDelta: round(num(p.production?.rejectDelta, 0), 0)
};

const timeBlock = {
    plannedProductionTimeMs: round(num(p.times?.plannedProductionTimeMs, 0), 0),
    downtimeMs: round(num(p.times?.downtimeMs, 0), 0),
    operatingTimeMs: round(num(p.times?.operatingTimeMs, 0), 0),
    deltaMs: round(num(p.times?.deltaMs, 0), 0),
    deltaOperatingTimeMs: round(num(p.times?.deltaOperatingTimeMs, 0), 0)
};

const timeSeriesFeatures = rawTimeSeriesFeatures;
const learning = p.learning || {};
const reasoning = p.reasoning || {};

// --------------------------------------------------
// 3) EvidÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Âªncias consolidadas
// --------------------------------------------------
const evidence = uniq([
    ...(Array.isArray(learning.evidence) ? learning.evidence : []),
    ...(Array.isArray(reasoning.evidence) ? reasoning.evidence : [])
]);

// --------------------------------------------------
// 4) EstatÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â­sticas resumidas para ACSM
// CompatÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â­vel com o payload novo e com o frontend antigo
// --------------------------------------------------
const statistics = {
    // formato novo
    oeeMean: timeSeriesFeatures?.oee?.mean ?? null,
    oeeMedian: timeSeriesFeatures?.oee?.median ?? null,

    availabilityMean: timeSeriesFeatures?.availability?.mean ?? null,
    availabilityMedian: timeSeriesFeatures?.availability?.median ?? null,

    performanceMean: timeSeriesFeatures?.performance?.mean ?? null,
    performanceMedian: timeSeriesFeatures?.performance?.median ?? null,
    performanceDisplayMean: timeSeriesFeatures?.performance?.mean ?? null,
    performanceDisplayMedian: timeSeriesFeatures?.performance?.median ?? null,

    qualityMean: timeSeriesFeatures?.quality?.mean ?? null,
    qualityMedian: timeSeriesFeatures?.quality?.median ?? null,

    tempMean: timeSeriesFeatures?.temperature?.mean ?? null,
    tempMedian: timeSeriesFeatures?.temperature?.median ?? null,

    rpmMean: timeSeriesFeatures?.rpm?.mean ?? null,
    rpmMedian: timeSeriesFeatures?.rpm?.median ?? null,

    torqueMean: timeSeriesFeatures?.torque?.mean ?? null,
    torqueMedian: timeSeriesFeatures?.torque?.median ?? null,

    cycleMean: timeSeriesFeatures?.cycleTimeMs?.mean ?? null,
    cycleMedian: timeSeriesFeatures?.cycleTimeMs?.median ?? null,

    // compatibilidade com frontend antigo
    oee_mean: timeSeriesFeatures?.oee?.mean ?? null,
    oee_median: timeSeriesFeatures?.oee?.median ?? null,

    availability_mean: timeSeriesFeatures?.availability?.mean ?? null,
    availability_median: timeSeriesFeatures?.availability?.median ?? null,

    performance_mean: timeSeriesFeatures?.performance?.mean ?? null,
    performance_median: timeSeriesFeatures?.performance?.median ?? null,
    performance_display_mean: timeSeriesFeatures?.performance?.mean ?? null,
    performance_display_median: timeSeriesFeatures?.performance?.median ?? null,

    quality_mean: timeSeriesFeatures?.quality?.mean ?? null,
    quality_median: timeSeriesFeatures?.quality?.median ?? null,

    temp_mean: timeSeriesFeatures?.temperature?.mean ?? null,
    temp_median: timeSeriesFeatures?.temperature?.median ?? null,

    rpm_mean: timeSeriesFeatures?.rpm?.mean ?? null,
    rpm_median: timeSeriesFeatures?.rpm?.median ?? null,

    torque_mean: timeSeriesFeatures?.torque?.mean ?? null,
    torque_median: timeSeriesFeatures?.torque?.median ?? null,

    cycle_mean: timeSeriesFeatures?.cycleTimeMs?.mean ?? null,
    cycle_median: timeSeriesFeatures?.cycleTimeMs?.median ?? null
};
// --------------------------------------------------
// 5) Features compactas para ACSM
// --------------------------------------------------
const features = {
    featureStatus,
    playEnabled,
    learningState: learning.state || null,
    learningPattern: learning.pattern || null,
    dominantLossNow: reasoning.dominantLossNow || null,
    dominantLossForecast: reasoning.dominantLossForecast || null,
    probableCause: reasoning.probableCause || null,
    riskLevel: reasoning.riskLevel || null,
    driftScore: learning.driftScore ?? null,
    anomalyScore: learning.anomalyScore ?? null
};

// --------------------------------------------------
// 6) Janela temporal
// --------------------------------------------------
const windowLabel =
    timeSeriesFeatures?.window ||
    `last_${timeSeriesFeatures?.historySize || 0}_points`;

// --------------------------------------------------
// 7) Inteligencia local explicita: learning, baseline, anomaly, causality e forecast
// --------------------------------------------------
function naturalStdFloor(key, mean) {
    const absMean = Math.abs(num(mean, 0));
    if (["availability", "performance", "quality", "oee"].includes(key)) return 0.03;
    if (key === "cycleTimeMs") return Math.max(50, absMean * 0.05);
    if (key === "rpm") return Math.max(20, absMean * 0.05);
    if (key === "temperature") return Math.max(0.5, absMean * 0.02);
    if (key === "torque") return Math.max(0.2, absMean * 0.05);
    return Math.max(0.0001, absMean * 0.05);
}

function metricStats(key, currentValue) {
    const stats = timeSeriesFeatures?.[key] || {};
    const mean = num(stats.mean ?? stats.median ?? stats.current ?? currentValue, currentValue);
    const rawStd = firstFinite([stats.std, stats.stddev], NaN);
    const minValue = Number(stats.min);
    const maxValue = Number(stats.max);
    const rangeStd = Number.isFinite(minValue) && Number.isFinite(maxValue) && maxValue > minValue
        ? (maxValue - minValue) / 4
        : NaN;
    const std = firstFinite([rawStd > 0 ? rawStd : NaN, rangeStd > 0 ? rangeStd : NaN], 0);
    return {
        mean: round(mean),
        std: round(std),
        source: std > 0 ? "observed_window" : "single_point_or_flat_window"
    };
}

function signedDeviation(key, currentValue, stats) {
    const value = num(currentValue, stats.mean);
    const observedStd = num(stats.std, 0);
    const denominator = observedStd > 0 ? observedStd : naturalStdFloor(key, stats.mean);
    return (value - num(stats.mean, value)) / denominator;
}

function describePattern(pattern, dominantVariable, stability) {
    if (pattern === "chronic_availability_loss") return "availability has been the dominant local loss over consecutive windows";
    if (pattern === "chronic_performance_loss") return "performance has been the dominant local loss over consecutive windows";
    if (pattern === "degrading_system") return "local OEE trend is degrading against the recent baseline";
    if (pattern === "recovering_system") return "local OEE trend is recovering against the recent baseline";
    if (pattern === "unstable_oscillation") return "local signals are oscillating above the expected stability band";
    if (pattern === "insufficient_history") return "local temporal window is still warming up";
    return dominantVariable + " is the current dominant local signal with " + stability + " stability";
}

const availabilityValue = num(oeeBlock.availability, 0);
const performanceValue = num(oeeBlock.performanceAccumulated ?? oeeBlock.performance, 0);
const qualityValue = num(oeeBlock.quality, 1);
const currentOeeValue = num(oeeBlock.current, 0);

const losses = reasoning.losses || {
    availability: round(Math.max(0, 1 - availabilityValue)),
    performance: round(Math.max(0, 1 - performanceValue)),
    quality: round(Math.max(0, 1 - qualityValue))
};

const sortedLosses = Object.entries(losses).sort((a, b) => num(b[1], 0) - num(a[1], 0));
const dominantLossByValue = sortedLosses[0]?.[0] || null;
const reasoningDominantLoss = [reasoning.dominantLossNow, reasoning.dominantLoss].find((loss) => Object.prototype.hasOwnProperty.call(losses, loss));
const dominantLoss = reasoningDominantLoss || dominantLossByValue;

const learningPattern = learning.pattern || learning.learned || features.learningPattern || "unknown_pattern";
const learningConfidence = round(num(learning.confidence ?? reasoning.confidence, 0.5));
const windowSize = num(timeSeriesFeatures?.historySize, 0) || 5;

let stability = "persistent";
if (learningPattern === "unstable_oscillation") stability = "unstable";
else if (learningPattern === "recovering_system") stability = "improving";
else if (learningPattern === "degrading_system") stability = "degrading";
else if (learning.state === "warming_up") stability = "unstable";

const learningModel = {
    model: learning.model || "local_temporal_learning",
    pattern: learningPattern,
    windowSize,
    dominantVariable: dominantLoss,
    stability,
    confidence: learningConfidence,
    description: describePattern(learningPattern, dominantLoss || "oee", stability)
};

const baseline = {
    temperature: metricStats("temperature", telemetryBlock.temperature),
    cycleTimeMs: metricStats("cycleTimeMs", telemetryBlock.cycleTimeMs),
    rpm: metricStats("rpm", telemetryBlock.rpm),
    torque: metricStats("torque", telemetryBlock.torque),
    availability: metricStats("availability", availabilityValue),
    performance: metricStats("performance", performanceValue),
    quality: metricStats("quality", qualityValue),
    oee: metricStats("oee", currentOeeValue)
};

const deviations = {
    temperature: signedDeviation("temperature", telemetryBlock.temperature, baseline.temperature),
    cycleTimeMs: signedDeviation("cycleTimeMs", telemetryBlock.cycleTimeMs, baseline.cycleTimeMs),
    rpm: signedDeviation("rpm", telemetryBlock.rpm, baseline.rpm),
    torque: signedDeviation("torque", telemetryBlock.torque, baseline.torque),
    availability: signedDeviation("availability", availabilityValue, baseline.availability),
    performance: signedDeviation("performance", performanceValue, baseline.performance),
    quality: signedDeviation("quality", qualityValue, baseline.quality)
};

const affectedVariables = Object.entries(deviations)
    .filter(([, value]) => Math.abs(value) >= 2)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .map(([key]) => key);

const maxDeviation = Object.values(deviations).reduce((max, value) => Math.max(max, Math.abs(num(value, 0))), 0);
const anomalyScore = round(Math.max(num(learning.anomalyScore, 0), Math.min(1, maxDeviation / 4)));
let anomalyStatus = "normal";
if (learningPattern === "unstable_oscillation" || anomalyScore >= 0.75 || affectedVariables.length >= 3) anomalyStatus = "unstable";
else if (affectedVariables.some((key) => num(deviations[key], 0) > 0)) anomalyStatus = "above_normal";
else if (affectedVariables.some((key) => num(deviations[key], 0) < 0)) anomalyStatus = "below_normal";

const anomaly = {
    score: anomalyScore,
    status: anomalyStatus,
    affectedVariables
};

const derivedEvidence = [];
if (availabilityValue < 0.7) derivedEvidence.push("availability below 70% in the current local window");
if (availabilityValue < num(baseline.availability.mean, availabilityValue) - Math.max(0.05, num(baseline.availability.std, 0))) derivedEvidence.push("availability below local baseline");
if (performanceValue < 0.75) derivedEvidence.push("performance below 75% in the current local window");
if (qualityValue < 0.95) derivedEvidence.push("quality below 95% in the current local window");
if (num(telemetryBlock.cycleTimeMs, 0) > num(baseline.cycleTimeMs.mean, 0) + Math.max(num(baseline.cycleTimeMs.std, 0) * 2, 1)) derivedEvidence.push("cycle time above local baseline");
if (num(deviations.temperature, 0) >= 2) derivedEvidence.push("temperature above local baseline");
if (Math.abs(num(deviations.torque, 0)) >= 2) derivedEvidence.push("torque outside local baseline band");
if (Math.abs(num(deviations.rpm, 0)) >= 2) derivedEvidence.push("rpm outside local baseline band");
if (num(timeBlock.downtimeMs, 0) > 0) derivedEvidence.push("downtime accumulated in the local OEE window");
if (["awaiting_replacement", "maintenance", "failure"].includes(featureStatus)) derivedEvidence.push("local feature status is " + featureStatus);
if (num(productionBlock.rejectDelta, 0) > 0) derivedEvidence.push("reject pieces detected in the last interval");

const localEvidence = uniq([...evidence, ...derivedEvidence]);

let probableCause = reasoning.probableCause || "normal operation";
let causeType = dominantLoss ? dominantLoss + "_loss" : "normal";
let relatedSignals = [];
let causalConfidence = round(num(reasoning.confidence ?? learning.confidence, 0.5));

if (availabilityValue < 0.7 && (num(timeBlock.downtimeMs, 0) > 0 || ["awaiting_replacement", "maintenance", "failure"].includes(featureStatus))) {
    probableCause = "recurrent stoppage";
    causeType = "availability_loss";
    relatedSignals = ["downtime", "feature_status", "availability_drop"];
} else if (performanceValue < 0.75 && num(telemetryBlock.cycleTimeMs, 0) > num(baseline.cycleTimeMs.mean, 0) + Math.max(num(baseline.cycleTimeMs.std, 0), 1)) {
    probableCause = "execution slowdown";
    causeType = "performance_loss";
    relatedSignals = ["cycle_time_increase", "performance_drop"];
} else if (qualityValue < 0.95 && num(productionBlock.rejectDelta, 0) > 0) {
    probableCause = "process instability";
    causeType = "quality_loss";
    relatedSignals = ["reject_delta", "quality_drop"];
} else if (affectedVariables.some((key) => ["temperature", "torque", "rpm"].includes(key))) {
    probableCause = "abnormal operating condition";
    causeType = "operating_condition_anomaly";
    relatedSignals = affectedVariables.filter((key) => ["temperature", "torque", "rpm"].includes(key));
}

const causalDominantVariable = causeType.endsWith("_loss")
    ? causeType.replace("_loss", "")
    : (relatedSignals.find((signal) => ["temperature", "torque", "rpm", "cycle_time_increase"].includes(signal)) || dominantLoss || "oee");

learningModel.dominantVariable = causalDominantVariable;
learningModel.description = describePattern(learningPattern, causalDominantVariable, stability);

if (anomaly.score >= 0.7) causalConfidence = round(Math.max(causalConfidence, 0.78));
else if (localEvidence.length >= 3) causalConfidence = round(Math.max(causalConfidence, 0.68));

const causality = {
    probableCause,
    causeType,
    relatedSignals,
    causalConfidence
};

let trend = "stable";
const learningState = String(learning.state || "").toLowerCase();
const oeeDeltaVsBaseline = currentOeeValue - num(baseline.oee.mean, currentOeeValue);
if (learningPattern === "recovering_system" || stability === "improving") trend = "positive";
else if (learningPattern === "unstable_oscillation" || anomaly.status === "unstable") trend = "unstable";
else if (learningPattern === "degrading_system" || stability === "degrading" || learningState === "critical" || oeeDeltaVsBaseline < -0.05) trend = "negative";
else if (learningState === "attention" && anomaly.score >= 0.45) trend = "negative";

let nextState = "stable_operation";
if (trend === "positive") nextState = "stabilizing";
else if (trend === "unstable") nextState = "unstable";
else if (trend === "negative" && (anomaly.score >= 0.7 || currentOeeValue < 0.5 || learningState === "critical")) nextState = "failure_risk";
else if (trend === "negative" || causality.causeType === "availability_loss" || anomaly.score >= 0.55) nextState = "maintenance_required";

const oeeSlope = firstFinite([timeSeriesFeatures?.oee?.slope, timeSeriesFeatures?.oee?.deltaPctVsMedian], 0);
const forecastOee = Array.isArray(learning.forecastOEE) && learning.forecastOEE.length
    ? num(learning.forecastOEE[0], currentOeeValue)
    : currentOeeValue + (trend === "negative" ? Math.min(-0.03, oeeSlope) : trend === "positive" ? Math.max(0.02, oeeSlope) : oeeSlope * 0.5);
const signalRisk = nextState === "failure_risk" || anomaly.score >= 0.75 || currentOeeValue < 0.45 || learningState === "critical"
    ? "high"
    : nextState === "maintenance_required" || nextState === "unstable" || anomaly.score >= 0.45 || currentOeeValue < 0.7 || learningState === "attention"
        ? "medium"
        : "low";
const forecastRisk = maxRisk(reasoning.riskLevel, signalRisk);

const forecast = {
    nextState,
    timeHorizon: "short_term",
    risk: forecastRisk,
    confidence: round(Math.max(num(learning.confidence, 0.5), num(reasoning.confidence, 0.5))),
    expectedOEE: round(Math.max(0, Math.min(1, forecastOee)))
};

const primaryIssue = dominantLoss
    ? dominantLoss + " loss due to " + causality.probableCause
    : "no dominant local loss detected";
const operationalState = trend === "negative" ? "degrading" : trend === "positive" ? "recovering" : trend === "unstable" ? "unstable" : "stable";
const executiveInterpretation = operationalState === "stable"
    ? "local operation remains stable with no dominant loss escalation"
    : "local " + operationalState + " behavior driven by " + (dominantLoss || "oee") + " signal";

const enrichedReasoning = {
    operationalState,
    dominantLoss,
    primaryIssue,
    probableCause: causality.probableCause,
    trend,
    confidence: round(num(reasoning.confidence ?? learning.confidence, 0.5)),
    executiveInterpretation,
    recommendation: reasoning.recommendation || learning.recommendation || "Maintain monitoring of local CPS signals.",
    causality,
    supportingEvidence: localEvidence,
    learningModel
};
const governableAction = learning.governableAction || reasoning.governableAction || null;
const governableVariation = learning.variation ?? reasoning.variation ?? null;
const governableRequestedValue = learning.requestedValue ?? reasoning.requestedValue ?? governableVariation;
const governableUnit = learning.unit || reasoning.unit || "%";
const finalRecommendation = governableAction
    ? (learning.recommendation || enrichedReasoning.recommendation)
    : enrichedReasoning.recommendation;
// --------------------------------------------------
// 8) Payload final para ACSM
// --------------------------------------------------
const acsmPayload = {
    ts: now,
    timestamp: new Date(now).toISOString(),

    cpsId,
    cpsName,
    baseTopic,

    window: windowLabel,

    oeeBlock,
    oeeData: oeeBlock,
    telemetry: telemetryBlock,
    production: productionBlock,
    time: timeBlock,
    statistics,

    features,

    timeSeriesFeatures,

    learningModel,
    causality,
    baseline,
    anomaly,
    forecast,

    learningPattern,
    learningConsensus: learning.consensus || learning.learningConsensus || learningPattern,
    recommendation: finalRecommendation,
    ...(governableAction ? {
        governableAction,
        variation: governableVariation,
        requestedValue: governableRequestedValue,
        unit: governableUnit,
        source: learning.source || reasoning.source || "reasoning"
    } : {}),
    availability: oeeBlock.availability,
    performance: oeeBlock.performance,
    quality: oeeBlock.quality,
    oee: oeeBlock.current,
    confidence: enrichedReasoning.confidence,
    riskLevel: forecast.risk,
    trend,

    learning: {
        model: learning.model || null,
        type: learning.type || null,
        state: learning.state || null,
        pattern: learning.pattern || learning.learned || null,
        learned: learning.learned || learning.pattern || null,
        confidence: learning.confidence ?? null,
        driftScore: learning.driftScore ?? null,
        anomalyScore: learning.anomalyScore ?? null,
        forecastOEE: Array.isArray(learning.forecastOEE) ? learning.forecastOEE : [],
        recommendation: learning.recommendation || null,
        ...(governableAction ? {
            governableAction,
            variation: governableVariation,
            requestedValue: governableRequestedValue,
            unit: governableUnit,
            source: learning.source || reasoning.source || "reasoning"
        } : {}),
        evidence: localEvidence,
        basis: learning.basis || {}
    },

    
    reasoning: {
        ...enrichedReasoning,

        model: reasoning.model || null,
        type: reasoning.type || null,
        dominantLossNow: reasoning.dominantLossNow || null,
        dominantLossForecast: reasoning.dominantLossForecast || null,

        dominantLoss,

        probableCause: causality.probableCause || reasoning.probableCause || null,
        riskLevel: reasoning.riskLevel || forecast.risk,
        confidence: enrichedReasoning.confidence,
        explanation: reasoning.explanation || enrichedReasoning.executiveInterpretation,
        recommendation: finalRecommendation,
        ...(governableAction ? {
            governableAction,
            variation: governableVariation,
            requestedValue: governableRequestedValue,
            unit: governableUnit,
            source: learning.source || reasoning.source || "reasoning"
        } : {}),
        evidence: localEvidence,

        losses
    },

    evidence: localEvidence,

    source: {
        producer: "CPS7",
        semanticPackageVersion: "v2",
        generatedBy: "Build CPS7 Payload for ACSM"
    }
};

// --------------------------------------------------
// 9) PersistÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Âªncia opcional
// --------------------------------------------------
stateBridge.set("cps7_last_acsm_payload", acsmPayload);

let acsmPayloadHistory = stateBridge.get("cps7_acsm_payload_history") || [];
acsmPayloadHistory.push({
    ts: acsmPayload.ts,
    cpsId: acsmPayload.cpsId,
    oee: typeof acsmPayload.oee === "object" ? acsmPayload.oee.current : acsmPayload.oee,
    learningState: acsmPayload.learning.state,
    learningPattern: acsmPayload.learning.pattern,
    dominantLossNow: acsmPayload.reasoning.dominantLossNow,
    riskLevel: acsmPayload.reasoning.riskLevel
});
if (acsmPayloadHistory.length > 50) {
    acsmPayloadHistory = acsmPayloadHistory.slice(-50);
}
stateBridge.set("cps7_acsm_payload_history", acsmPayloadHistory);

// --------------------------------------------------
// 10) SaÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â­da
// --------------------------------------------------
msg.payload = acsmPayload;
return msg;


