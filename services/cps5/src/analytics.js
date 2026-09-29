'use strict';
class Analytics {
  constructor(state) { this.state = state; this.history = []; }
  update(telemetry, oee, health, featureStatus) {
    const point = { ts: Date.now(), oee: oee.oee.current, availability: oee.oee.availability, performance: oee.oee.performance, quality: oee.oee.quality, temperature: telemetry.CurrentTemperature, rpm: telemetry.CurrentRPM, torque: telemetry.CurrentTorque, cycleTimeMs: telemetry.CycleTimeMs, luminosity: telemetry.Luminosity, featureStatus, playEnabled: this.state.getState().playEnabled };
    this.history = [...this.history, point].slice(-20);
    const learning = { model: 'local-time-series', type: 'descriptive', state: this.history.length >= 5 ? 'learning' : 'initializing', pattern: featureStatus, confidence: this.history.length >= 5 ? 1 : 0, evidence: [`history_size_${this.history.length}`] };
    const dominant = ['availability', 'performance', 'quality'].sort((a, b) => (1 - oee.oee[b]) - (1 - oee.oee[a]))[0];
    const thresholdAdjustmentNeeded = dominant === 'quality' && oee.oee.quality < 0.92;
    const thresholdVariation = thresholdAdjustmentNeeded ? Number(Math.min(10, Math.max(3, (0.98 - oee.oee.quality) * 100)).toFixed(2)) : null;
    const reasoning = { model: 'local-rule-based', type: 'diagnostic', dominantLossNow: dominant, dominantLoss: dominant, riskLevel: health.healthScore < 60 ? 'high' : 'low', probableCause: `${dominant}_related_operational_loss`, explanation: `The dominant OEE loss is ${dominant}.`, recommendation: thresholdAdjustmentNeeded ? `Adjust inspection threshold by ${thresholdVariation}%.` : 'Inspect the current vision inspection operating conditions.', evidence: [`feature_status_${featureStatus}`], ...(thresholdAdjustmentNeeded ? { governableAction: 'ADJUST_INSPECTION_THRESHOLD', variation: thresholdVariation, requestedValue: thresholdVariation, unit: '%', source: 'reasoning' } : {}) };
    this.state.setLearning(learning); this.state.setReasoning(reasoning);
    return { learning, reasoning, timeSeriesFeatures: { historySize: this.history.length, ready: this.history.length >= 5, window: `last_${this.history.length}_points` }, ...(thresholdAdjustmentNeeded ? { recommendation: reasoning.recommendation, governableAction: reasoning.governableAction, variation: reasoning.variation, requestedValue: reasoning.requestedValue, unit: reasoning.unit, source: reasoning.source } : {}) };
  }
}
module.exports = Analytics;
