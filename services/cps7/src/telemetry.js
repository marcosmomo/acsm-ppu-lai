'use strict';
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function round(value, digits = 2) { return Number(Number(value).toFixed(digits)); }
const TRANSPORT_SPEED_PCT_MIN = 80;
const TRANSPORT_SPEED_PCT_MAX = 120;
class Telemetry {
  constructor(state) {
    this.state = state;
    this.lastIncrementTs = Date.now();
    this.microStopUntil = 0;
    this.nextCycleTargetMs = 3000;
  }
  getTransportSpeedPct() {
    const value = Number(this.state.getState().capabilityState?.parameters?.transportSpeedPct);
    return Number.isFinite(value) ? value : 100;
  }
  applyTransportSpeedAdjustment(requestedValue) {
    const appliedVariation = Number(requestedValue);
    if (!Number.isFinite(appliedVariation)) return { accepted: false, applied: false, error: 'Invalid requestedValue' };
    const previousValue = round(this.getTransportSpeedPct(), 2);
    const newValue = round(clamp(previousValue * (1 + appliedVariation / 100), TRANSPORT_SPEED_PCT_MIN, TRANSPORT_SPEED_PCT_MAX), 2);
    return {
      accepted: true,
      applied: true,
      parameter: 'transportSpeedPct',
      previousValue,
      newValue,
      appliedVariation,
      limits: { min: TRANSPORT_SPEED_PCT_MIN, max: TRANSPORT_SPEED_PCT_MAX },
    };
  }
  sample() {
    const s = this.state.getState();
    if (!(s.lifecyclePhase === 'play' && s.operationMode === 'running' && s.playEnabled)) return null;
    const input = s.sensorInput || { m_est_esq: 1, m_est_dir: 0, s_est_esquerda: 1, s_est_direita: 0, s_tor_encima: 0, s_tor_embaixo: 0, m_tor_encima: 0, m_tor_embaixo: 0 };
    const conveyorRunning = Number(input.m_est_esq || 0) === 1 || Number(input.m_est_dir || 0) === 1;
    const towerRunning = Number(input.m_tor_encima || 0) === 1 || Number(input.m_tor_embaixo || 0) === 1;
    const active = conveyorRunning || towerRunning;
    const pieceDetected = Number(input.s_est_esquerda || 0) === 1 || Number(input.s_est_direita || 0) === 1;
    const previous = s.lastValidTelemetry || { PieceCounter: 120, CurrentTemperature: 25 };
    let pieceCounter = Number(previous.PieceCounter ?? 120);
    const now = Date.now();
    if (active && now >= this.microStopUntil && Math.random() < 0.006) {
      this.microStopUntil = now + 700 + Math.floor(Math.random() * 500);
    }

    const microStopActive = active && now < this.microStopUntil;
    const effectiveActive = active && !microStopActive;
    const speedMultiplier = this.getTransportSpeedPct() / 100;
    const cycleElapsedMs = now - this.lastIncrementTs;
    let transferLoss = false;
    if (effectiveActive && cycleElapsedMs >= this.nextCycleTargetMs) {
      const baseTransferStress = conveyorRunning ? 0.025 : 0.12;
      const transientStress = cycleElapsedMs > 4200 ? 0.08 : 0;
      transferLoss = pieceDetected && Math.random() < baseTransferStress + transientStress;
      if (!transferLoss) pieceCounter += 1;
      this.lastIncrementTs = now;
      const occasionalSlowCycle = Math.random() < 0.12;
      const baseCycleTargetMs = occasionalSlowCycle
        ? 3150 + Math.floor(Math.random() * 450)
        : 2350 + Math.floor(Math.random() * 620);
      this.nextCycleTargetMs = Math.round(clamp(baseCycleTargetMs / speedMultiplier, 2350, 3600));
    }

    const currentRPM = effectiveActive ? Math.round(clamp((conveyorRunning ? 1400 + Math.floor(Math.random() * 130) : 880 + Math.floor(Math.random() * 90)) * speedMultiplier, 880, 1530)) : 0;
    const torque = currentRPM > 0 ? (conveyorRunning ? 10.5 : 7.5) * (pieceDetected ? 1.3 : 1) + Math.random() * 1.2 + (cycleElapsedMs > 3600 ? 0.8 : 0) : 0;
    const target = effectiveActive ? (conveyorRunning && towerRunning ? 40 : 35) : 28;
    const temperature = Number((Number(previous.CurrentTemperature ?? 25) + ((target - Number(previous.CurrentTemperature ?? 25)) * 0.15) + Math.random() * 0.1).toFixed(1));
    return {
      CurrentTemperature: temperature,
      CurrentRPM: currentRPM,
      CurrentTorque: Number(torque.toFixed(1)),
      PieceCounter: pieceCounter,
      CycleTimeMs: effectiveActive ? cycleElapsedMs : 0,
      OperationMode: effectiveActive ? 'play' : 'stop',
      TransportLossDetected: transferLoss,
      AvailabilityLossEvent: microStopActive,
      CycleTargetMs: this.nextCycleTargetMs,
      TransportSpeedPct: this.getTransportSpeedPct(),
      ts: now
    };
  }
}
module.exports = Telemetry;
