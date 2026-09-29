'use strict';
const { load, save } = require('./persistence');
class CpsState {
  constructor(config) {
    const persisted = load(config.statePath) || {};
    this.file = config.statePath;
    this.value = {
      lifecyclePhase: persisted.lifecyclePhase || 'plug', operationMode: 'stopped', playEnabled: false,
      maintenanceInProgress: false, autoReturnAfterMaintenance: false, lastLifecycleReason: 'startup',
      capabilityState: persisted.capabilityState || { feature: 'to_ship_the_part', status: 'active' },
      sensorInput: persisted.sensorInput || null, lastTelemetry: persisted.lastValidTelemetry || null,
      lastValidTelemetry: persisted.lastValidTelemetry || null, health: persisted.health || null,
      oee: persisted.oee || null, learning: persisted.learning || null, reasoning: persisted.reasoning || null,
      governedActions: persisted.governedActions || [],
      timestamps: { startedAt: new Date().toISOString() }
    };
    this.persist();
  }
  getState() { return structuredClone(this.value); }
  updateState(patch) { this.value = { ...this.value, ...patch, timestamps: { ...this.value.timestamps, updatedAt: new Date().toISOString() } }; this.persist(); return this.getState(); }
  setState(patch) { return this.updateState(patch); }
  getTelemetry() { return this.value.lastTelemetry || this.value.lastValidTelemetry; }
  setTelemetry(value) { return this.updateState({ lastTelemetry: value, lastValidTelemetry: value }); }
  getOEE() { return this.value.oee; }
  setOEE(value) { return this.updateState({ oee: value }); }
  getHealth() { return this.value.health; }
  setHealth(value) { return this.updateState({ health: value }); }
  getLearning() { return this.value.learning; }
  setLearning(value) { return this.updateState({ learning: value }); }
  getReasoning() { return this.value.reasoning; }
  setReasoning(value) { return this.updateState({ reasoning: value }); }
  persist() { save(this.file, { lifecyclePhase: this.value.lifecyclePhase, capabilityState: this.value.capabilityState, sensorInput: this.value.sensorInput, lastValidTelemetry: this.value.lastValidTelemetry, health: this.value.health, oee: this.value.oee, learning: this.value.learning, reasoning: this.value.reasoning, governedActions: this.value.governedActions }); }
}
module.exports = CpsState;
