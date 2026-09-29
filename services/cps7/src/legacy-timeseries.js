// ============================================================
// CPS7 - Local Time-Series Features
// Entrada esperada: payload do node "calcular OEE CPS"
// SaÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â­da: acrescenta msg.payload.timeSeriesFeatures
// ============================================================

const p = msg.payload || {};
const now = Number(p.ts || Date.now());

// -----------------------------
// ConfiguraÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â§ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â£o
// -----------------------------
const HISTORY_SIZE = 20;   // janela curta local
const MIN_POINTS = 5;      // mÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â­nimo para estatÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â­sticas ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Âºteis

// -----------------------------
// Helpers
// -----------------------------
function num(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

function round(v, d = 4) {
    if (!Number.isFinite(v)) return null;
    return Number(v.toFixed(d));
}

function mean(arr) {
    if (!arr.length) return null;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function median(arr) {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

function min(arr) {
    return arr.length ? Math.min(...arr) : null;
}

function max(arr) {
    return arr.length ? Math.max(...arr) : null;
}

function stddev(arr) {
    if (arr.length < 2) return 0;
    const m = mean(arr);
    const variance = mean(arr.map(v => Math.pow(v - m, 2)));
    return Math.sqrt(variance);
}

function pctDelta(current, baseline) {
    if (!Number.isFinite(current) || !Number.isFinite(baseline)) return null;
    if (baseline === 0) return null;
    return ((current - baseline) / Math.abs(baseline));
}

function simpleSlope(values) {
    if (values.length < 2) return 0;
    const first = values[0];
    const last = values[values.length - 1];
    const steps = values.length - 1;
    if (steps <= 0) return 0;
    return (last - first) / steps;
}

function lastN(arr, n) {
    return arr.slice(Math.max(0, arr.length - n));
}

function summarizeSeries(current, arr) {
    const arrValid = arr.filter(v => Number.isFinite(v));
    if (!arrValid.length) {
        return {
            current: round(current),
            mean: null,
            median: null,
            min: null,
            max: null,
            stddev: null,
            deltaPctVsMedian: null,
            slope: null
        };
    }

    const med = median(arrValid);
    return {
        current: round(current),
        mean: round(mean(arrValid)),
        median: round(med),
        min: round(min(arrValid)),
        max: round(max(arrValid)),
        stddev: round(stddev(arrValid)),
        deltaPctVsMedian: round(pctDelta(current, med)),
        slope: round(simpleSlope(arrValid))
    };
}

// -----------------------------
// Leitura do ponto atual
// -----------------------------
const point = {
    ts: now,
    oee: num(p.oee, NaN),
    availability: num(p.availability, NaN),
    performance: num(p.performanceAccumulated ?? p.performance, NaN),
    performanceDisplay: num(p.performance, NaN),
    quality: num(p.quality, NaN),
    temperature: num(p.telemetry?.currentTemperature, NaN),
    rpm: num(p.telemetry?.currentRPM, NaN),
    torque: num(p.telemetry?.currentTorque, NaN),
    cycleTimeMs: num(p.telemetry?.cycleTimeMs, NaN),
    featureStatus: String(p.process?.featureStatus || "").toLowerCase().trim(),
    playEnabled: !!p.process?.playEnabled
};

// -----------------------------
// HistÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â³rico
// -----------------------------
let history = stateBridge.get("cps7_ts_history") || [];
history.push(point);
history = lastN(history, HISTORY_SIZE);
stateBridge.set("cps7_ts_history", history);

// Se ainda nÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â£o hÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¡ pontos suficientes
if (history.length < MIN_POINTS) {
    msg.payload.timeSeriesFeatures = {
        historySize: history.length,
        minPointsRequired: MIN_POINTS,
        ready: false,
        note: "Not enough history yet for robust temporal features."
    };
    return msg;
}

// -----------------------------
// SÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â©ries separadas
// -----------------------------
const oeeSeries = history.map(x => x.oee).filter(Number.isFinite);
const availabilitySeries = history.map(x => x.availability).filter(Number.isFinite);
const performanceSeries = history.map(x => x.performance).filter(Number.isFinite);
const qualitySeries = history.map(x => x.quality).filter(Number.isFinite);
const tempSeries = history.map(x => x.temperature).filter(Number.isFinite);
const rpmSeries = history.map(x => x.rpm).filter(Number.isFinite);
const torqueSeries = history.map(x => x.torque).filter(Number.isFinite);
const cycleSeries = history.map(x => x.cycleTimeMs).filter(Number.isFinite);

// -----------------------------
// Features
// -----------------------------
const features = {
    historySize: history.length,
    window: `last_${history.length}_points`,
    ready: true,

    oee: summarizeSeries(point.oee, oeeSeries),
    availability: summarizeSeries(point.availability, availabilitySeries),
    performance: summarizeSeries(point.performance, performanceSeries),
    quality: summarizeSeries(point.quality, qualitySeries),

    temperature: summarizeSeries(point.temperature, tempSeries),
    rpm: summarizeSeries(point.rpm, rpmSeries),
    torque: summarizeSeries(point.torque, torqueSeries),
    cycleTimeMs: summarizeSeries(point.cycleTimeMs, cycleSeries),

    correlationsHint: {
        lowRpmHighCycle:
            round(
                (point.rpm < (median(rpmSeries) ?? point.rpm) * 0.9 &&
                    point.cycleTimeMs > (median(cycleSeries) ?? point.cycleTimeMs) * 1.1) ? 1 : 0,
                0
            ),
        highTempLowOee:
            round(
                (point.temperature > (median(tempSeries) ?? point.temperature) * 1.05 &&
                    point.oee < (median(oeeSeries) ?? point.oee) * 0.95) ? 1 : 0,
                0
            ),
        highTorqueQualityRisk:
            round(
                (point.torque > (median(torqueSeries) ?? point.torque) * 1.1 &&
                    point.quality < (median(qualitySeries) ?? point.quality) * 0.98) ? 1 : 0,
                0
            )
    }
};

// -----------------------------
// Atalhos ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Âºteis para o learning
// -----------------------------
features.quickSignals = {
    oeeDeltaPct: features.oee.deltaPctVsMedian,
    availabilityDeltaPct: features.availability.deltaPctVsMedian,
    performanceDeltaPct: features.performance.deltaPctVsMedian,
    qualityDeltaPct: features.quality.deltaPctVsMedian,
    tempDeltaPct: features.temperature.deltaPctVsMedian,
    rpmDeltaPct: features.rpm.deltaPctVsMedian,
    torqueDeltaPct: features.torque.deltaPctVsMedian,
    cycleDeltaPct: features.cycleTimeMs.deltaPctVsMedian,

    oeeSlope: features.oee.slope,
    tempSlope: features.temperature.slope,
    rpmSlope: features.rpm.slope,
    torqueSlope: features.torque.slope,
    cycleSlope: features.cycleTimeMs.slope
};

// -----------------------------
// PersistÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Âªncia auxiliar
// -----------------------------
stateBridge.set("cps7_last_timeSeriesFeatures", features);

// Acrescenta ao payload atual
msg.payload.timeSeriesFeatures = features;

return msg;


