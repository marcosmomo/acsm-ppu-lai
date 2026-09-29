'use strict';
class Oee {
  constructor(state, telemetry) { this.state = state; this.telemetry = telemetry; this.prevTs = Date.now(); this.accPlayMs = 0; this.accActiveMs = 0; }
  calculate(featureStatus) {
    const now = Date.now(); const s = this.state.getState(); const delta = Math.max(0, now - this.prevTs);
    if (s.lifecyclePhase === 'play' && s.playEnabled) this.accPlayMs += delta;
    if (featureStatus === 'active') this.accActiveMs += delta;
    const counters = this.telemetry.counters(); const current = this.telemetry.getLast ? this.telemetry.getLast() : this.state.getTelemetry() || {};
    const availability = this.accPlayMs > 0 ? this.accActiveMs / this.accPlayMs : 0;
    const cycle = Number(current.CycleTimeMs || 0) || 1; const performance = s.playEnabled ? Math.min(1, 1000 / Math.max(1000, cycle)) : 0;
    const quality = counters.totalCount > 0 ? counters.goodCount / counters.totalCount : 1; const oee = availability * performance * quality;
    this.prevTs = now;
    const value = { cpsId: 'cps5', cpsName: 'SistemaVisao_Qualit', ts: new Date(now).toISOString(), oee: { current: +oee.toFixed(4), global: +oee.toFixed(4), availability: +availability.toFixed(4), performance: +performance.toFixed(4), quality: +quality.toFixed(4) }, totals: { plannedProductionTime: +(this.accPlayMs / 1000).toFixed(2), runTime: +(this.accActiveMs / 1000).toFixed(2), stopTime: +((this.accPlayMs - this.accActiveMs) / 1000).toFixed(2), ...counters }, features: { avgCycleTimeMs: cycle, avgRpm: Number(current.CurrentRPM || 0), avgTorque: Number(current.CurrentTorque || 0), avgTemperature: Number(current.CurrentTemperature || 0), avgLuminosity: Number(current.Luminosity || 0) } };
    this.state.setOEE(value); return value;
  }
}
module.exports = Oee;
