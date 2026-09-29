'use strict';
class Oee {
  constructor(state) { this.state = state; this.prevTs = Date.now(); const telemetry = state.getTelemetry?.() || {}; this.prevPiece = Number(telemetry.PieceCounter ?? 120); this.planned = 0; this.downtime = 0; this.operating = 0; this.total = 0; this.good = 0; this.reject = 0; this.lastPerformance = 0; }
  calculate(featureStatus, telemetry) {
    const now = Date.now(); const s = this.state.getState(); const delta = Math.max(0, now - this.prevTs); const downtimeStates = new Set(['maintenance', 'awaiting_replacement', 'failure', 'stopped', 'unplugged']);
    if (s.playEnabled) { this.planned += delta; if (downtimeStates.has(featureStatus)) this.downtime += delta; else this.operating += delta; }
    const produced = Math.max(0, Number(telemetry.PieceCounter || 0) - this.prevPiece); const rejectDelta = telemetry.TransportLossDetected ? 1 : 0; this.total += produced + rejectDelta; this.good += produced; this.reject += rejectDelta; this.prevPiece = Number(telemetry.PieceCounter || 0); this.prevTs = now;
    const availability = this.planned > 0 ? this.operating / this.planned : 0; const performanceAccumulated = this.operating > 0 ? Math.min(1, (3000 * this.total) / this.operating) : 0; this.lastPerformance = this.lastPerformance * 0.75 + performanceAccumulated * 0.25; const quality = this.total > 0 ? this.good / this.total : 1; const oee = availability * performanceAccumulated * quality;
    const value = { availability: Number(availability.toFixed(4)), performance: Number(this.lastPerformance.toFixed(4)), performanceAccumulated: Number(performanceAccumulated.toFixed(4)), performanceInstant: null, quality: Number(quality.toFixed(4)), oee: Number(oee.toFixed(4)), process: { idealCycleTimeMs: 3000, featureStatus, playEnabled: s.playEnabled }, production: { pieceCounterAbs: this.prevPiece, producedDelta: produced, totalPieces: this.total, goodPieces: this.good, rejectPieces: this.reject, rejectDelta }, telemetry: { currentTemperature: telemetry.CurrentTemperature, currentRPM: telemetry.CurrentRPM, currentTorque: telemetry.CurrentTorque, cycleTimeMs: telemetry.CycleTimeMs }, ts: now };
    this.state.setOEE(value); return value;
  }
}
module.exports = Oee;
