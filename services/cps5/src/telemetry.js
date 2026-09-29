'use strict';
function rand(min, max) { return Math.random() * (max - min) + min; }
function round(value, digits) { return Number(Number(value).toFixed(digits)); }
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
const INSPECTION_THRESHOLD_DEFAULT = 350;
const INSPECTION_THRESHOLD_MIN = 250;
const INSPECTION_THRESHOLD_MAX = 980;
class Telemetry {
  constructor(state) { this.state = state; this.op = { CurrentTemperature: 25, CurrentRPM: 0, CurrentTorque: 0, PieceCounter: 0, CycleTimeMs: 0, OperationMode: 'play', Luminosity: 850 }; this.total = 0; this.good = 0; this.reject = 0; }
  canSample() { const s = this.state.getState(); return s.lifecyclePhase === 'play' && s.operationMode === 'running' && s.playEnabled === true; }
  getInspectionThreshold() {
    const value = Number(this.state.getState().capabilityState?.parameters?.inspectionThreshold);
    return Number.isFinite(value) ? value : INSPECTION_THRESHOLD_DEFAULT;
  }
  applyInspectionThresholdAdjustment(requestedValue) {
    const appliedVariation = Number(requestedValue);
    if (!Number.isFinite(appliedVariation)) return { accepted: false, applied: false, error: 'Invalid requestedValue' };
    const previousValue = round(this.getInspectionThreshold(), 2);
    const newValue = round(clamp(previousValue * (1 + appliedVariation / 100), INSPECTION_THRESHOLD_MIN, INSPECTION_THRESHOLD_MAX), 2);
    return {
      accepted: true,
      applied: true,
      parameter: 'inspectionThreshold',
      previousValue,
      newValue,
      appliedVariation,
      limits: { min: INSPECTION_THRESHOLD_MIN, max: INSPECTION_THRESHOLD_MAX },
    };
  }
  sample() {
    if (!this.canSample()) return null;
    const luminosityOk = Math.random() > 0.08;
    this.op.CurrentRPM = round(luminosityOk ? rand(1450, 1550) : rand(900, 1200), 2);
    this.op.CurrentTorque = round(luminosityOk ? rand(12, 16) : rand(8, 11), 2);
    this.op.CurrentTemperature = round(Math.min(55, this.op.CurrentTemperature + rand(0.05, 0.25)), 2);
    this.op.CycleTimeMs = Math.round(luminosityOk ? rand(1200, 1550) : rand(1750, 2400));
    this.op.Luminosity = round(luminosityOk ? rand(780, 980) : rand(250, 500), 2);
    this.op.InspectionThreshold = this.getInspectionThreshold();
    const qualityOk = this.op.Luminosity >= this.op.InspectionThreshold && Math.random() > 0.10;
    this.op.PieceCounter += 1; this.total += 1; if (qualityOk && luminosityOk) this.good += 1; else this.reject += 1;
    const value = { ...this.op, ts: Date.now() }; this.state.setTelemetry(value); return value;
  }
  counters() { return { totalCount: this.total, goodCount: this.good, rejectCount: this.reject }; }
}
module.exports = Telemetry;
