'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Analytics = require('../src/analytics');

const flowNodes = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../node-red/cps7-flow.json'), 'utf8'));
const sourceById = Object.fromEntries(flowNodes.filter((node) => node.type === 'function').map((node) => [node.id, node.func]));
const ids = ['8b6d63beed400849', '94dcbc4464730ff3', '057e4e834eee5147', 'abc0b749314a3a20'];

function run(source, msg, values) {
  return new Function('msg', 'flow', 'node', source)(msg, values, { warn() {}, status() {} });
}
function legacy(input, values) {
  const flow = { get: (key) => values.get(key), set: (key, value) => values.set(key, value) };
  let msg = { payload: input };
  for (const id of ids) msg = run(sourceById[id], msg, flow) || msg;
  return msg.payload;
}
function withoutTime(value) {
  if (Array.isArray(value)) return value.map(withoutTime);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'ts' && key !== 'timestamp').map(([key, item]) => [key, withoutTime(item)]));
}
function input(i, metrics) {
  return {
    cpsId: 'CPS-007', cpsName: 'Transportband_50464', ts: 1700000000000 + i,
    oee: metrics.oee, availability: metrics.availability, performance: metrics.performance,
    performanceAccumulated: metrics.performance, quality: metrics.quality,
    process: { featureStatus: metrics.featureStatus || 'active', playEnabled: true },
    times: { plannedProductionTimeMs: i * 1000, downtimeMs: metrics.downtimeMs || 0, operatingTimeMs: i * 900, deltaMs: 1000, deltaOperatingTimeMs: 900 },
    production: { pieceCounterAbs: 120 + i, producedDelta: 1, totalPieces: i + 1, goodPieces: i + 1, rejectPieces: metrics.rejectPieces || 0, rejectDelta: metrics.rejectDelta || 0 },
    telemetry: { currentTemperature: metrics.temperature || 31.5, currentRPM: metrics.rpm || 1480, currentTorque: metrics.torque || 2.1, cycleTimeMs: metrics.cycleTimeMs || 0 }
  };
}
function runScenario(name, metrics) {
  const legacyFlow = new Map();
  const service = new Analytics({ setLearning() {}, setReasoning() {} });
  for (let i = 0; i < metrics.length; i += 1) {
    const current = input(i, metrics[i]);
    const expected = legacy(current, legacyFlow);
    const actual = service.update(current.telemetry, current);
    assert.deepEqual(withoutTime(actual), withoutTime(expected), `${name} diverged at point ${i + 1}`);
  }
}

runScenario('stable', Array.from({ length: 5 }, () => ({ oee: 0.8, availability: 0.95, performance: 0.9, quality: 0.98 })));
runScenario('gradual degradation', Array.from({ length: 5 }, (_, i) => ({ oee: 0.8 - i * 0.08, availability: 0.95 - i * 0.03, performance: 0.9 - i * 0.04, quality: 0.98, cycleTimeMs: 3200 + i * 500, temperature: 31.5 + i * 2 })));
runScenario('oscillation', [0.8, 0.6, 0.82, 0.58, 0.8].map((oee) => ({ oee, availability: 0.8, performance: 0.8, quality: 0.95 })));
runScenario('availability loss', Array.from({ length: 5 }, () => ({ oee: 0.4, availability: 0.5, performance: 0.9, quality: 0.98, featureStatus: 'maintenance', downtimeMs: 500 })));
runScenario('performance loss', Array.from({ length: 5 }, () => ({ oee: 0.45, availability: 0.95, performance: 0.55, quality: 0.98, rpm: 900, cycleTimeMs: 5000 })));
runScenario('quality loss', Array.from({ length: 5 }, () => ({ oee: 0.5, availability: 0.95, performance: 0.9, quality: 0.7, torque: 14, rejectPieces: 1, rejectDelta: 1 })));
runScenario('insufficient history', [{ oee: 0.5, availability: 0.8, performance: 0.7, quality: 0.9 }]);
console.log('CPS-7 Learning/Reasoning parity: PASS (7 deterministic scenarios)');
