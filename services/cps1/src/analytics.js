'use strict';

class Analytics {
  constructor(state) { this.state = state; this.history = []; }
  update(telemetry, oee, health) {
    if (!telemetry) return { features: null, learning: this.state.getLearning(), reasoning: this.state.getReasoning() };
    this.history = [...this.history, { telemetry, oee, ts: Date.now() }].slice(-8);
    const learning = { model: 'statistical pattern learning', state: health.healthLabel === 'healthy' ? 'monitoring' : 'attention', confidence: this.history.length > 1 ? 0.64 : 0, dominantRisk: telemetry.WeldDefectDetected ? 'welding_quality_risk' : null };
    const currentTarget = 52;
    const currentDeviationPct = Number((((Number(telemetry.CorrenteArco || 0) - currentTarget) / currentTarget) * 100).toFixed(2));
    const currentAdjustmentNeeded = telemetry.WeldDefectDetected && Math.abs(currentDeviationPct) >= 2;
    const reasoning = { domain: 'welding_robot', dominantLoss: oee.availability < oee.performance ? 'availability' : 'performance', severity: health.healthLabel === 'healthy' ? 'low' : 'medium', probableCause: telemetry.WeldDefectDetected ? 'welding_process_instability' : null, recommendation: currentAdjustmentNeeded ? `${currentDeviationPct > 0 ? 'Reduce' : 'Increase'} welding current by ${Math.abs(currentDeviationPct)}%.` : telemetry.WeldDefectDetected ? 'Inspect welding process conditions.' : 'Keep monitoring.', ...(currentAdjustmentNeeded ? { governableAction: 'ADJUST_WELDING_CURRENT', variation: Math.abs(currentDeviationPct), requestedValue: Number((-currentDeviationPct).toFixed(2)), unit: '%', source: 'reasoning' } : {}) };
    const features = { cycleTimeMs: telemetry.CycleTimeMs, temperature: telemetry.TempPontaSolda, arcCurrent: telemetry.CorrenteArco, gasPressure: telemetry.PressaoGas, samples: this.history.length };
    this.state.setLearning(learning);
    this.state.setReasoning(reasoning);
    return { features, learning, reasoning, ...(currentAdjustmentNeeded ? { recommendation: reasoning.recommendation, governableAction: reasoning.governableAction, variation: reasoning.variation, requestedValue: reasoning.requestedValue, unit: reasoning.unit, source: reasoning.source } : {}) };
  }
}

module.exports = Analytics;
