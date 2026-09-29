// ============================================================
// CPS7 - Local Learning CPS7
// Entrada esperada:
//   msg.payload.timeSeriesFeatures
//   msg.payload (OEE + telemetria atual)
// SaÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â­da:
//   msg.payload.learning
// ============================================================

const p = msg.payload || {};
const tsf = p.timeSeriesFeatures || {};
const qs = tsf.quickSignals || {};

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

function pushEvidence(arr, text) {
    if (text && !arr.includes(text)) arr.push(text);
}

const ready = tsf.ready === true;

// --------------------------------------------------
// Caso ainda nÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â£o haja histÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â³rico suficiente
// --------------------------------------------------
if (!ready) {
    const learning = {
        model: "local_temporal_learning_v2",
        type: "baseline_warmup",
        state: "warming_up",
        pattern: "insufficient_history",
        driftScore: 0,
        anomalyScore: 0,
        confidence: 0.25,
        forecastOEE: [],
        evidence: [
            "Temporal window not ready yet.",
            `History size: ${num(tsf.historySize, 0)}`
        ],
        recommendation: "Continue collecting local history before stronger temporal inference."
    };

    stateBridge.set("cps7_last_learning", learning);
    msg.payload.learning = learning;
    return msg;
}

// --------------------------------------------------
// Leitura dos sinais rÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¡pidos
// --------------------------------------------------
const oeeDeltaPct = num(qs.oeeDeltaPct, 0);
const availabilityDeltaPct = num(qs.availabilityDeltaPct, 0);
const performanceDeltaPct = num(qs.performanceDeltaPct, 0);
const qualityDeltaPct = num(qs.qualityDeltaPct, 0);

const tempDeltaPct = num(qs.tempDeltaPct, 0);
const rpmDeltaPct = num(qs.rpmDeltaPct, 0);
const torqueDeltaPct = num(qs.torqueDeltaPct, 0);
const cycleDeltaPct = num(qs.cycleDeltaPct, 0);

const oeeSlope = num(qs.oeeSlope, 0);
const tempSlope = num(qs.tempSlope, 0);
const rpmSlope = num(qs.rpmSlope, 0);
const torqueSlope = num(qs.torqueSlope, 0);
const cycleSlope = num(qs.cycleSlope, 0);

const featureStatus = String(p.process?.featureStatus || "").toLowerCase().trim();
const playEnabled = !!p.process?.playEnabled;

const currentOEE = num(p.oee, 0);
const currentAvailability = num(p.availability, 0);
const currentPerformance = num(p.performanceAccumulated ?? p.performance, 0);
const currentQuality = num(p.quality, 1);

// hints de correlaÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â§ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â£o
const hints = tsf.correlationsHint || {};
const lowRpmHighCycle = num(hints.lowRpmHighCycle, 0) === 1;
const highTempLowOee = num(hints.highTempLowOee, 0) === 1;
const highTorqueQualityRisk = num(hints.highTorqueQualityRisk, 0) === 1;

// --------------------------------------------------
// Scores
// --------------------------------------------------
let driftScore = 0;
let anomalyScore = 0;
let evidence = [];
let recommendation = "Maintain monitoring.";
let pattern = "normal_operation";
let state = "stable";
let actionProposal = null;

// Drift score: mistura desvios percentuais relevantes
driftScore += Math.abs(oeeDeltaPct) * 0.30;
driftScore += Math.abs(cycleDeltaPct) * 0.20;
driftScore += Math.abs(tempDeltaPct) * 0.15;
driftScore += Math.abs(rpmDeltaPct) * 0.15;
driftScore += Math.abs(torqueDeltaPct) * 0.10;
driftScore += Math.abs(availabilityDeltaPct) * 0.10;

// Anomaly score: heurÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â­stico baseado em combinaÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â§ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Âµes perigosas
if (cycleDeltaPct > 0.15) anomalyScore += 0.20;
if (tempDeltaPct > 0.10) anomalyScore += 0.15;
if (rpmDeltaPct < -0.10) anomalyScore += 0.15;
if (torqueDeltaPct > 0.10) anomalyScore += 0.10;
if (oeeDeltaPct < -0.10) anomalyScore += 0.20;
if (availabilityDeltaPct < -0.10) anomalyScore += 0.20;

if (lowRpmHighCycle) anomalyScore += 0.10;
if (highTempLowOee) anomalyScore += 0.10;
if (highTorqueQualityRisk) anomalyScore += 0.10;

if (featureStatus === "maintenance") anomalyScore += 0.10;
if (featureStatus === "awaiting_replacement") anomalyScore += 0.25;
if (featureStatus === "failure") anomalyScore += 0.35;

driftScore = clamp(driftScore, 0, 1);
anomalyScore = clamp(anomalyScore, 0, 1);

// --------------------------------------------------
// Reconhecimento de padrÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Âµes
// --------------------------------------------------

// 1) perda de performance por ciclo alto
if (cycleDeltaPct > 0.15 && oeeDeltaPct < -0.08) {
    pattern = "performance_degradation";
    state = "degrading";
    pushEvidence(evidence, "Cycle time above local baseline.");
    pushEvidence(evidence, "OEE below local baseline.");
    recommendation = "Inspect speed losses, microstops, and process stateBridge.";
}

// 2) perda por rotaÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â§ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â£o baixa
if (rpmDeltaPct < -0.10 && cycleDeltaPct > 0.10) {
    pattern = "speed_loss";
    state = "degrading";
    pushEvidence(evidence, "RPM below local baseline.");
    pushEvidence(evidence, "Cycle time above local baseline.");
    recommendation = "Adjust transport speed after speed-loss detection.";
    const transportSpeedVariation = round(clamp(Math.abs(rpmDeltaPct) * 100, 3, 20));
    actionProposal = {
        governableAction: "ADJUST_TRANSPORT_SPEED",
        variation: transportSpeedVariation,
        requestedValue: transportSpeedVariation,
        unit: "%",
        source: "reasoning"
    };
}

// 3) degradaÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â§ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â£o tÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â©rmica
if (tempDeltaPct > 0.10 && oeeDeltaPct < -0.08) {
    pattern = "thermal_degradation";
    state = "degrading";
    pushEvidence(evidence, "Temperature above local baseline.");
    pushEvidence(evidence, "OEE below local baseline.");
    recommendation = "Inspect thermal load, friction sources, and maintenance condition.";
}

// 4) risco de qualidade
if (torqueDeltaPct > 0.10 && qualityDeltaPct < -0.02) {
    pattern = "quality_risk";
    state = "degrading";
    pushEvidence(evidence, "Torque above local baseline.");
    pushEvidence(evidence, "Quality below local baseline.");
    recommendation = "Inspect process stability and quality-related mechanical stress.";
}

// 5) perda de disponibilidade
if (availabilityDeltaPct < -0.10) {
    pattern = "availability_loss";
    state = "degrading";
    pushEvidence(evidence, "Availability below local baseline.");
    recommendation = "Inspect downtime causes, maintenance status, and replacement triggers.";
}

// 6) condiÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â§ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â£o crÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â­tica explÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â­cita
if (
    featureStatus === "awaiting_replacement" ||
    featureStatus === "failure" ||
    currentOEE < 0.45 ||
    anomalyScore > 0.70
) {
    pattern = "critical_operational_degradation";
    state = "critical";
    pushEvidence(evidence, "Critical feature state or strong anomaly evidence detected.");
    recommendation = "Prioritize intervention and inspect CPS7 immediately.";
}

// 7) recuperaÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â§ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â£o
if (
    oeeSlope > 0.01 &&
    cycleSlope < 0 &&
    tempSlope <= 0 &&
    currentOEE > 0.70 &&
    featureStatus === "active"
) {
    pattern = "recovering_operation";
    state = "recovering";
    pushEvidence(evidence, "OEE trend improving.");
    pushEvidence(evidence, "Cycle time trend reducing.");
    recommendation = "Keep monitoring recovery and stabilize the operating baseline.";
}

// 8) estÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¡vel
if (
    evidence.length === 0 &&
    Math.abs(oeeDeltaPct) < 0.05 &&
    Math.abs(cycleDeltaPct) < 0.08 &&
    Math.abs(tempDeltaPct) < 0.08 &&
    Math.abs(rpmDeltaPct) < 0.08 &&
    Math.abs(torqueDeltaPct) < 0.08 &&
    currentOEE >= 0.70
) {
    pattern = "stable_baseline";
    state = "stable";
    pushEvidence(evidence, "Temporal indicators remain close to local baseline.");
    recommendation = "Maintain current operating condition.";
}

// --------------------------------------------------
// Forecast OEE curto (heurÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â­stico)
// --------------------------------------------------
// previsÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â£o simples usando tendÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Âªncia + drift
const forecastOEE = [];
let base = currentOEE;

// tendÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Âªncia lÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â­quida
const netTrend =
    (oeeSlope * 0.6) -
    (Math.max(0, cycleSlope) * 0.00001) -
    (Math.max(0, tempSlope) * 0.002) +
    (Math.min(0, rpmSlope) * 0.05);

// penalizaÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â§ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â£o por drift/anomalia
const penalty = (driftScore * 0.03) + (anomalyScore * 0.04);

for (let i = 1; i <= 3; i++) {
    base = clamp(base + netTrend - penalty, 0, 1);
    forecastOEE.push(round(base));
}

// --------------------------------------------------
// ConfianÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â§a
// --------------------------------------------------
let confidence = 0.55;

if (state === "stable") confidence = 0.72;
if (state === "degrading") confidence = 0.80;
if (state === "critical") confidence = 0.88;
if (state === "recovering") confidence = 0.76;

if (featureStatus === "awaiting_replacement" || featureStatus === "failure") {
    confidence += 0.05;
}

confidence = clamp(confidence, 0, 0.95);
if (pattern !== "speed_loss") {
    actionProposal = null;
}

// --------------------------------------------------
// SaÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â­da learning
// --------------------------------------------------
const learning = {
    model: "local_temporal_learning_v2",
    type: "temporal_pattern_learning",
    state,
    pattern,
    learned: pattern,
    confidence: round(confidence),
    driftScore: round(driftScore),
    anomalyScore: round(anomalyScore),
    forecastOEE,
    evidence,
    recommendation,
    ...(actionProposal || {}),
    basis: {
        oeeDeltaPct: round(oeeDeltaPct),
        availabilityDeltaPct: round(availabilityDeltaPct),
        performanceDeltaPct: round(performanceDeltaPct),
        qualityDeltaPct: round(qualityDeltaPct),
        tempDeltaPct: round(tempDeltaPct),
        rpmDeltaPct: round(rpmDeltaPct),
        torqueDeltaPct: round(torqueDeltaPct),
        cycleDeltaPct: round(cycleDeltaPct),
        oeeSlope: round(oeeSlope),
        tempSlope: round(tempSlope),
        rpmSlope: round(rpmSlope),
        torqueSlope: round(torqueSlope),
        cycleSlope: round(cycleSlope)
    }
};

stateBridge.set("cps7_last_learning", learning);

// histÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â³rico curto opcional
let learningInsights = stateBridge.get("learningInsights") || [];
learningInsights.push({
    ts: Date.now(),
    pattern: learning.pattern,
    state: learning.state,
    confidence: learning.confidence,
    driftScore: learning.driftScore,
    anomalyScore: learning.anomalyScore
});
if (learningInsights.length > 50) {
    learningInsights = learningInsights.slice(-50);
}
stateBridge.set("learningInsights", learningInsights);

msg.payload.learning = learning;
return msg;


