'use strict';
const fs = require('node:fs');
const path = require('node:path');
const sources = Object.fromEntries([
  ['timeseries', 'legacy-timeseries.js'], ['learning', 'legacy-learning.js'],
  ['reasoning', 'legacy-reasoning.js'], ['payload', 'legacy-payload.js']
].map(([name, file]) => [name, fs.readFileSync(path.join(__dirname, file), 'utf8')]));
function run(source, msg, stateBridge) { return new Function('msg', 'stateBridge', 'node', source)(msg, stateBridge, { warn() {}, status() {} }); }
class Analytics {
  constructor(state) { this.state = state; this.context = new Map(); }
  update(telemetry, oee) {
    const current = { cpsId: 'CPS-007', cpsName: 'Transportband_50464', ts: oee.ts || telemetry.ts || Date.now(), oee: oee.oee, availability: oee.availability, performance: oee.performance, performanceAccumulated: oee.performanceAccumulated, quality: oee.quality, performanceInstant: oee.performanceInstant, process: oee.process, times: oee.times || {}, production: oee.production || {}, telemetry: oee.telemetry || { currentTemperature: telemetry.CurrentTemperature, currentRPM: telemetry.CurrentRPM, currentTorque: telemetry.CurrentTorque, cycleTimeMs: telemetry.CycleTimeMs } };
    const stateBridge = { get: (key) => this.context.get(key), set: (key, value) => this.context.set(key, value) };
    let msg = { payload: current };
    for (const name of ['timeseries', 'learning', 'reasoning', 'payload']) msg = run(sources[name], msg, stateBridge) || msg;
    const payload = msg.payload; this.state.setLearning(payload.learning || null); this.state.setReasoning(payload.reasoning || null); return payload;
  }
}
module.exports = Analytics;
