'use strict';

const fs = require('node:fs');
const path = require('node:path');

const STATE_KEY = 'cps1State';
const STATE_PATH = process.env.CPS_STATE_PATH || path.resolve(__dirname, '..', 'data', 'cps1-runtime-state.json');
let restored = false;

const LOCAL_ALIASES = Object.freeze({
  playEnabled: 'playEnabled',
  maintenanceInProgress: 'maintenanceInProgress',
  autoReturnAfterMaintenance: 'autoReturnAfterMaintenance',
  lastLifecycleReason: 'lastLifecycleReason',
  awaitCount: 'await_count',
  aasModel: 'aas_cps1_model',
  aasLive: 'aas_cps1_live',
  aasEvents: 'aas_cps1_events',
  baseline: 'cps1_baseline',
  lastPayloadAcsm: 'cps1_last_payload_acsm'
});

function clone(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') return value;
  return Array.isArray(value) ? value.slice() : Object.assign({}, value);
}

function persistedState() {
  if (restored) return null;
  restored = true;
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (_) {
    return null;
  }
}

function persist(state) {
  const durable = {
    lastValidTelemetry: state.lastValidTelemetry || null,
    oee: state.oee || null,
    health: state.health || null,
    capabilityState: state.capabilityState || {},
    lifecyclePhase: state.lifecyclePhase || 'plug',
    updatedAt: Date.now()
  };
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(durable, null, 2));
  } catch (_) {
    // Runtime keeps operating with memory-only state if persistence is unavailable.
  }
}

function read(flow) {
  let state = flow.get(STATE_KEY) || {};
  const restoredState = persistedState();
  if (!Object.keys(state).length && restoredState) {
    state = Object.assign({}, restoredState, {
      operationMode: 'stopped',
      playEnabled: false,
      maintenanceInProgress: false,
      autoReturnAfterMaintenance: false,
      lastLifecycleReason: 'restart_safe_state'
    });
    flow.set(STATE_KEY, state);
  }
  const capabilityState = state.capabilityState || {};
  const legacy = (key) => flow.get(key);

  return Object.assign({
    lifecyclePhase: state.lifecyclePhase || null,
    operationMode: state.operationMode || null,
    playEnabled: state.playEnabled !== undefined ? state.playEnabled : legacy(LOCAL_ALIASES.playEnabled),
    maintenanceInProgress: state.maintenanceInProgress !== undefined ? state.maintenanceInProgress : legacy(LOCAL_ALIASES.maintenanceInProgress),
    autoReturnAfterMaintenance: state.autoReturnAfterMaintenance !== undefined ? state.autoReturnAfterMaintenance : legacy(LOCAL_ALIASES.autoReturnAfterMaintenance),
    lastLifecycleReason: state.lastLifecycleReason !== undefined ? state.lastLifecycleReason : legacy(LOCAL_ALIASES.lastLifecycleReason),
    capabilityState,
    lastTelemetry: state.lastTelemetry || null,
    lastValidTelemetry: state.lastValidTelemetry || null,
    health: state.health || null,
    oee: state.oee || null,
    learning: state.learning || null,
    reasoning: state.reasoning || null,
    timestamps: state.timestamps || {}
  }, state);
}

function write(flow, patch, aliases = {}) {
  const current = read(flow);
  const next = Object.assign({}, current, patch, {
    timestamps: Object.assign({}, current.timestamps, { updatedAt: Date.now() })
  });
  flow.set(STATE_KEY, next);
  persist(next);

  Object.keys(aliases).forEach((stateKey) => {
    flow.set(LOCAL_ALIASES[stateKey] || stateKey, clone(aliases[stateKey]));
  });
  return next;
}

function get(flow, key) {
  const state = read(flow);
  if (key.startsWith('lastState:') || key.startsWith('lastSeen:') || key.startsWith('lastStatus:')) {
    const capabilityKey = key.replace(/^last(State|Seen|Status):/, '$1:');
    if (Object.prototype.hasOwnProperty.call(state.capabilityState || {}, capabilityKey)) {
      return state.capabilityState[capabilityKey];
    }
  }
  const stateKey = Object.keys(LOCAL_ALIASES).find((candidate) => LOCAL_ALIASES[candidate] === key) || key;
  return state[stateKey] !== undefined ? state[stateKey] : flow.get(key);
}

function getState(flow) {
  return read(flow);
}

function setState(flow, state) {
  return write(flow, state);
}

function updateState(flow, patch) {
  return write(flow, patch);
}

function getTelemetry(flow) {
  return read(flow).lastTelemetry || read(flow).lastValidTelemetry || null;
}

function setTelemetry(flow, telemetry, valid = true) {
  return write(flow, {
    lastTelemetry: telemetry,
    ...(valid ? { lastValidTelemetry: telemetry } : {})
  });
}

function getOEE(flow) { return read(flow).oee; }
function setOEE(flow, value) { return write(flow, { oee: value }); }
function getHealth(flow) { return read(flow).health; }
function setHealth(flow, value) { return write(flow, { health: value }); }
function getLearning(flow) { return read(flow).learning; }
function setLearning(flow, value) { return write(flow, { learning: value }); }
function getReasoning(flow) { return read(flow).reasoning; }
function setReasoning(flow, value) { return write(flow, { reasoning: value }); }

function set(flow, stateKey, value) {
  if (stateKey.startsWith('lastState:') || stateKey.startsWith('lastSeen:') || stateKey.startsWith('lastStatus:')) {
    const capabilityState = Object.assign({}, read(flow).capabilityState || {});
    const capabilityKey = stateKey.replace(/^last(State|Seen|Status):/, '$1:');
    capabilityState[capabilityKey] = value;
    flow.set(STATE_KEY, Object.assign({}, read(flow), { capabilityState }));
    flow.set(stateKey, clone(value));
    return read(flow);
  }
  if (stateKey === 'aas_cps1_live' && value && typeof value === 'object') {
    const telemetry = value.operationalData || value.sensorActuatorData || value.telemetry || value;
    return write(flow, { aasLive: value, lastTelemetry: telemetry, lastValidTelemetry: telemetry }, { aasLive: value });
  }
  const aliases = {};
  if (LOCAL_ALIASES[stateKey]) aliases[stateKey] = value;
  return write(flow, { [stateKey]: value }, aliases);
}

function initialize(flow) {
  const current = read(flow);
  return write(flow, {
    lifecyclePhase: current.lifecyclePhase || 'plug',
    operationMode: current.operationMode || 'stopped',
    playEnabled: current.playEnabled === true,
    maintenanceInProgress: current.maintenanceInProgress === true,
    autoReturnAfterMaintenance: current.autoReturnAfterMaintenance === true,
    lastLifecycleReason: current.lastLifecycleReason || 'startup',
    capabilityState: current.capabilityState || {},
    timestamps: current.timestamps || {}
  }, {
    playEnabled: current.playEnabled === true,
    maintenanceInProgress: current.maintenanceInProgress === true,
    autoReturnAfterMaintenance: current.autoReturnAfterMaintenance === true,
    lastLifecycleReason: current.lastLifecycleReason || 'startup'
  });
}

module.exports = Object.freeze({
  STATE_KEY,
  LOCAL_ALIASES,
  read,
  get,
  write,
  set,
  initialize,
  getState,
  setState,
  updateState,
  getTelemetry,
  setTelemetry,
  getOEE,
  setOEE,
  getHealth,
  setHealth,
  getLearning,
  setLearning,
  getReasoning,
  setReasoning
});
