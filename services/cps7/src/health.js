'use strict';
function calculate(status, telemetry = null) {
  const s = String(status || '').toLowerCase();
  let score = 50;
  if (s === 'active') score = 100;
  else if (s === 'maintenance') score = 60;
  else if (s === 'awaiting_replacement') score = 20;
  else if (s === 'failure') score = 0;
  else return { healthScore: 50, healthLabel: 'unknown' };

  if (telemetry) {
    const temperature = Number(telemetry.CurrentTemperature || 0);
    const rpm = Number(telemetry.CurrentRPM || 0);
    const torque = Number(telemetry.CurrentTorque || 0);
    const cycleTimeMs = Number(telemetry.CycleTimeMs || 0);

    if (telemetry.AvailabilityLossEvent) score -= 10;
    if (telemetry.TransportLossDetected) score -= 15;
    if (temperature > 38) score -= 8;
    if (temperature > 42) score -= 12;
    if (rpm > 1510 || (rpm > 0 && rpm < 900)) score -= 6;
    if (torque > 14.2) score -= 8;
    if (cycleTimeMs > 3600) score -= 8;
  }

  score = Math.max(0, Math.min(100, score));
  if (score >= 85) return { healthScore: score, healthLabel: 'healthy' };
  if (score >= 65) return { healthScore: score, healthLabel: 'warning' };
  if (score > 0) return { healthScore: score, healthLabel: 'degraded' };
  return { healthScore: 50, healthLabel: 'unknown' };
}
module.exports = { calculate };
