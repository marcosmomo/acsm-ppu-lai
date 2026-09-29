'use strict';

function calculate(telemetry) {
  if (!telemetry) return { healthScore: 0, healthLabel: 'unknown' };
  let score = 100;

  const temperature = Number(telemetry.TempPontaSolda || 0);
  const current = Number(telemetry.CorrenteArco || 0);
  const gasPressure = Number(telemetry.PressaoGas || 0);
  const cycleTimeMs = Number(telemetry.CycleTimeMs || 0);

  if (temperature > 226 || temperature < 172) score -= 8;
  if (temperature > 235 || temperature < 166) score -= 12;
  if (current > 63 || current < 42) score -= 7;
  if (current > 67 || current < 38) score -= 10;
  if (gasPressure < 10.2 || gasPressure > 15.0) score -= 7;
  if (gasPressure < 9.5 || gasPressure > 15.8) score -= 10;
  if (cycleTimeMs > 2600) score -= 6;
  if (telemetry.AvailabilityLossEvent) score -= 10;
  if (telemetry.WeldDefectDetected) score -= 12;

  score = Math.max(0, Math.min(100, score));
  const healthLabel = score >= 85 ? 'healthy' : score >= 65 ? 'warning' : 'degraded';
  return { healthScore: score, healthLabel };
}

module.exports = { calculate };
