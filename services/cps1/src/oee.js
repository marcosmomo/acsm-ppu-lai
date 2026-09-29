'use strict';

const IDEAL_CYCLE_TIME_MS = 1800;

class Oee {
  constructor(state) {
    this.state = state;
    this.previousAt = Date.now();
    this.previousPieces = 0;
    this.plannedTime = 0;
    this.operatingTime = 0;
    this.downtime = 0;
    this.totalPieces = 0;
    this.goodPieces = 0;
    this.rejectPieces = 0;
  }

  calculate(telemetry) {
    const current = this.state.getState();
    const now = Date.now();
    const deltaMs = Math.max(0, now - this.previousAt);
    const previousOperational = current.playEnabled === true;
    if (previousOperational) {
      this.plannedTime += deltaMs;
      if (telemetry?.OperationMode !== 'stop') this.operatingTime += deltaMs;
      else this.downtime += deltaMs;
    }
    const produced = Math.max(0, Number(telemetry?.PieceCounter || 0) - this.previousPieces);
    this.totalPieces += produced;
    this.rejectPieces += telemetry?.WeldDefectDetected ? produced : 0;
    this.goodPieces += telemetry?.WeldDefectDetected ? 0 : produced;
    this.previousAt = now;
    this.previousPieces = Number(telemetry?.PieceCounter || 0);
    const availability = this.plannedTime > 0 ? this.operatingTime / this.plannedTime : 0;
    const performance = this.operatingTime > 0 ? Math.min(1, (IDEAL_CYCLE_TIME_MS * this.totalPieces) / this.operatingTime) : 0;
    const quality = this.totalPieces > 0 ? this.goodPieces / this.totalPieces : 1;
    const oee = availability * performance * quality;
    const result = { availability, performance, quality, oee, availabilityPct: Number((availability * 100).toFixed(2)), performancePct: Number((performance * 100).toFixed(2)), qualityPct: Number((quality * 100).toFixed(2)), oeePct: Number((oee * 100).toFixed(2)), ts: now };
    this.state.setOEE(result);
    return result;
  }
}

module.exports = Oee;
