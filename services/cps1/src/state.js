'use strict';

const { load, save } = require('./persistence');

class CpsState {
  constructor(config) {
    const persisted = load(config.statePath) || {};
    this.config = config;
    this.value = {
      lifecyclePhase: persisted.lifecyclePhase || 'plug',
      operationMode: 'stopped',
      playEnabled: false,
      maintenanceInProgress: false,
      autoReturnAfterMaintenance: false,
      lastLifecycleReason: 'startup',
      capabilityState: persisted.capabilityState || {},
      lastTelemetry: persisted.lastValidTelemetry || null,
      lastValidTelemetry: persisted.lastValidTelemetry || null,
      health: persisted.health || null,
      oee: persisted.oee || null,
      learning: null,
      reasoning: null,
      governedActions: persisted.governedActions || [],
      timestamps: { startedAt: new Date().toISOString() }
    };
    this.persist();
  }

  getState() { return structuredClone(this.value); }
  updateState(patch) {
    this.value = { ...this.value, ...patch, timestamps: { ...this.value.timestamps, updatedAt: new Date().toISOString() } };
    this.persist();
    return this.getState();
  }
  setState(next) { return this.updateState(next); }
  getTelemetry() { return this.value.lastTelemetry || this.value.lastValidTelemetry; }
  setTelemetry(telemetry, valid = true) {
    return this.updateState({ lastTelemetry: telemetry, ...(valid ? { lastValidTelemetry: telemetry } : {}) });
  }
  getOEE() { return this.value.oee; }
  setOEE(oee) { return this.updateState({ oee }); }
  getHealth() { return this.value.health; }
  setHealth(health) { return this.updateState({ health }); }
  getLearning() { return this.value.learning; }
  setLearning(learning) { return this.updateState({ learning }); }
  getReasoning() { return this.value.reasoning; }
  setReasoning(reasoning) { return this.updateState({ reasoning }); }
  persist() { save(this.config.statePath, this.value); }
}

module.exports = CpsState;
