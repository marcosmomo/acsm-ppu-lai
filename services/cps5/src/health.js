'use strict';
function calculate(status) {
  const value = String(status || 'unknown').toLowerCase();
  if (value === 'active') return { healthScore: 100, healthLabel: 'healthy' };
  if (value === 'maintenance') return { healthScore: 60, healthLabel: 'warning' };
  if (value === 'awaiting_replacement') return { healthScore: 20, healthLabel: 'critical' };
  if (value === 'failure') return { healthScore: 0, healthLabel: 'failure' };
  return { healthScore: 50, healthLabel: 'unknown' };
}
module.exports = { calculate };
