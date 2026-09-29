'use strict';

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}
const ARC_CURRENT_MIN = 37;
const ARC_CURRENT_MAX = 68;

class Telemetry {
  constructor(state, config) {
    this.state = state;
    this.config = config;
    this.pieceCounter = 0;
    this.tempPontaSolda = 182;
    this.correnteArco = 46;
    this.pressaoGas = 12.2;
    this.lastIncrementAt = Date.now();
    this.microStopUntil = 0;
    this.processDisturbanceUntil = 0;
    this.pendingWeldDefect = false;
    this.heatDrift = 0;
    this.currentDrift = 0;
    this.gasDrift = 0;
  }

  canSample() {
    const current = this.state.getState();
    return current.lifecyclePhase === 'play' && current.operationMode === 'running' && current.playEnabled === true;
  }

  applyWeldingCurrentAdjustment(requestedValue) {
    const appliedVariation = Number(requestedValue);
    if (!Number.isFinite(appliedVariation)) return { accepted: false, applied: false, error: 'Invalid requestedValue' };
    const previousValue = round(this.correnteArco, 2);
    const newValue = round(clamp(previousValue * (1 + appliedVariation / 100), ARC_CURRENT_MIN, ARC_CURRENT_MAX), 2);
    this.correnteArco = newValue;
    return {
      accepted: true,
      applied: true,
      parameter: 'CorrenteArco',
      previousValue,
      newValue,
      appliedVariation,
      limits: { min: ARC_CURRENT_MIN, max: ARC_CURRENT_MAX },
    };
  }

  sample() {
    if (!this.canSample()) return null;
    const now = Date.now();
    if (now >= this.microStopUntil && Math.random() < 0.014) {
      this.microStopUntil = now + 900 + Math.floor(Math.random() * 1200);
    }
    if (now >= this.processDisturbanceUntil && Math.random() < 0.03) {
      this.processDisturbanceUntil = now + 4000 + Math.floor(Math.random() * 3500);
    }

    const microStopActive = now < this.microStopUntil;
    const processDisturbanceActive = now < this.processDisturbanceUntil;
    this.heatDrift = clamp((this.heatDrift * 0.72) + ((Math.random() * 2.0) - 0.95), -5, 7);
    this.currentDrift = clamp((this.currentDrift * 0.72) + ((Math.random() * 1.4) - 0.65), -4, 5);
    this.gasDrift = clamp((this.gasDrift * 0.75) + ((Math.random() * 0.22) - 0.1), -0.8, 1.0);

    this.tempPontaSolda = clamp(this.tempPontaSolda + ((Math.random() * 3.6) - 1.7) + (this.heatDrift * 0.12) + ((192 - this.tempPontaSolda) * 0.035) + (processDisturbanceActive ? 1.5 : 0), 164, 238);
    this.correnteArco = clamp(this.correnteArco + ((Math.random() * 3) - 1.4) + (this.currentDrift * 0.08) + ((52 - this.correnteArco) * 0.045) + (processDisturbanceActive ? 1.1 : 0), ARC_CURRENT_MIN, ARC_CURRENT_MAX);
    this.pressaoGas = clamp(this.pressaoGas + ((Math.random() * 0.55) - 0.26) + (this.gasDrift * 0.06) + ((12.4 - this.pressaoGas) * 0.04) - (processDisturbanceActive ? 0.65 : 0), 9.2, 15.9);

    const processStress =
      Math.max(0, this.tempPontaSolda - 226) +
      Math.max(0, 174 - this.tempPontaSolda) +
      Math.max(0, this.correnteArco - 63) * 1.5 +
      Math.max(0, 42 - this.correnteArco) * 1.5 +
      Math.max(0, 10.5 - this.pressaoGas) * 6 +
      Math.max(0, this.pressaoGas - 14.8) * 4;
    const cycleTimeMs = microStopActive
      ? 2600 + Math.floor(Math.random() * 900)
      : 1700 + Math.floor(Math.random() * 650) + Math.round(processStress * 18);
    const adjustedCycleTimeMs = cycleTimeMs + (processDisturbanceActive ? 350 : 0);

    let producedThisSample = false;
    if (!microStopActive && now - this.lastIncrementAt >= Math.max(1400, adjustedCycleTimeMs)) {
      this.pieceCounter += 1;
      this.lastIncrementAt = now;
      producedThisSample = true;
    }
    const processStable =
      this.tempPontaSolda >= 166 &&
      this.tempPontaSolda <= 236 &&
      this.correnteArco >= 38 &&
      this.correnteArco <= 67 &&
      this.pressaoGas >= 9.4 &&
      this.pressaoGas <= 15.8 &&
      adjustedCycleTimeMs <= 2950;
    if (!microStopActive && !processStable) this.pendingWeldDefect = true;
    const weldDefectDetected = producedThisSample && this.pendingWeldDefect;
    if (producedThisSample) this.pendingWeldDefect = false;
    const weldingStable = !microStopActive && processStable && !weldDefectDetected;
    const payload = {
      TempPontaSolda: round(this.tempPontaSolda, 1),
      CorrenteArco: round(this.correnteArco, 1),
      PressaoGas: round(this.pressaoGas, 2),
      PieceCounter: this.pieceCounter,
      CycleTimeMs: adjustedCycleTimeMs,
      OperationMode: microStopActive ? 'stop' : 'play',
      WeldingStable: weldingStable,
      WeldDefectDetected: weldDefectDetected,
      AvailabilityLossEvent: microStopActive,
      ProcessDisturbance: processDisturbanceActive,
      ts: now
    };
    this.state.setTelemetry(payload, true);
    return payload;
  }
}

module.exports = Telemetry;
