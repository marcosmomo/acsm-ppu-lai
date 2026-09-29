'use strict';

const fs = require('node:fs');
const http = require('node:http');
const config = require('./config');
const CpsState = require('./state');
const Lifecycle = require('./lifecycle');
const Telemetry = require('./telemetry');
const Oee = require('./oee');
const Analytics = require('./analytics');
const Aas = require('./aas');
const Mqtt = require('./mqtt');
const { calculate: calculateHealth } = require('./health');

const state = new CpsState(config);
const lifecycle = new Lifecycle(state);
const telemetry = new Telemetry(state, config);
const oee = new Oee(state);
const analytics = new Analytics(state);
const aas = new Aas(config.aasPath);
const mqtt = new Mqtt(config, (command) => {
  const action = String(command?.action || '').toUpperCase();
  if (config.runtimeMode === 'active' && ['PLAY', 'STOP', 'MAINTENANCE', 'RETURN', 'UNPLUG'].includes(action)) applyCommand(action.toLowerCase(), false);
  if (config.runtimeMode === 'active' && (command?.type === 'governed_action' || action === 'ADJUST_WELDING_CURRENT')) applyGovernedAction(command, false);
});

function status() {
  const current = state.getState();
  return { cpsId: config.cpsId, assetName: config.cpsName, cpsName: config.cpsName, state: current.operationMode, lifecyclePhase: current.lifecyclePhase, operationMode: current.operationMode, playEnabled: current.playEnabled, feature: 'execute_welding_cycle', featureStatus: current.capabilityState.status || 'unknown', currentPhase: current.lifecyclePhase, supportedPhases: 'plug, play, stop, maintenance, return, unplug', ts: Date.now() };
}
function description() { const current = state.getState(); return { ...aas.description(), currentState: current.operationMode, ts: Date.now() }; }
function health() { const current = state.getState(); const value = current.health || calculateHealth(current.lastValidTelemetry); return { cpsId: config.cpsId, assetName: config.cpsName, ...value, lastHeartbeat: current.timestamps?.updatedAt || null, operationalState: current.operationMode, availability: current.oee?.availability || 0, healthState: value.healthLabel || 'unknown', ts: Date.now() }; }
function summary() { const current = state.getState(); const telemetryValue = current.lastTelemetry || {}; return { cpsId: config.cpsId, assetName: config.cpsName, state: current.operationMode, playEnabled: current.playEnabled, healthScore: current.health?.healthScore || 0, healthLabel: current.health?.healthLabel || 'unknown', oee: current.oee?.oee || 0, availability: current.oee?.availability || 0, performance: current.oee?.performance || 0, quality: current.oee?.quality || 0, currentTemperature: Number(telemetryValue.TempPontaSolda || 0), currentRPM: 0, currentTorque: Number(telemetryValue.CorrenteArco || 0), pieceCounter: Number(telemetryValue.PieceCounter || 0), cycleTimeMs: Number(telemetryValue.CycleTimeMs || 0), operationMode: current.operationMode, featureName: 'execute_welding_cycle', featureStatus: current.capabilityState.status || 'unknown', currentPhase: current.lifecyclePhase, supportedPhases: 'plug, play, stop, maintenance, return, unplug', ts: Date.now() }; }
function oeePayload() { const value = state.getOEE() || { availability: 0, performance: 0, quality: 0, oee: 0 }; return { cpsId: config.cpsId, assetName: config.cpsName, ...value, availabilityPct: Number((value.availability * 100).toFixed(2)), performancePct: Number((value.performance * 100).toFixed(2)), qualityPct: Number((value.quality * 100).toFixed(2)), oeePct: Number((value.oee * 100).toFixed(2)), ts: Date.now() }; }
function dataPayload() { const value = state.getTelemetry() || {}; return { cpsId: config.cpsId, assetName: config.cpsName, operationalData: value, sensorActuatorData: { s_est_esquerda: 0, s_est_direita: 0, m_est_esq: 0, m_est_dir: 0 }, lastValidTelemetry: state.getState().lastValidTelemetry, ts: Date.now() }; }
function sendJson(res, code, payload) { const body = JSON.stringify(payload); res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(body); }
function applyCommand(action, fromRest) {
  const next = lifecycle.command(action);
  if (fromRest && config.runtimeMode === 'shadow') return { ok: true, shadowMode: true, action, published: false, state: next };
  if (config.runtimeMode === 'active') {
    mqtt.publish(`${config.baseTopic}/ack`, { cpsId: config.cpsId, cpsName: config.cpsName, action, ok: true, playEnabled: next.playEnabled, status: next.operationMode, ts: new Date().toISOString() });
    mqtt.publish(`${config.baseTopic}/status`, status());
  }
  return { ok: true, shadowMode: config.runtimeMode !== 'active', action, state: next };
}
function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/api/cps/description') return sendJson(res, 200, description());
  if (req.method === 'GET' && url.pathname === '/api/cps/status') return sendJson(res, 200, status());
  if (req.method === 'GET' && url.pathname === '/api/cps/health') return sendJson(res, 200, health());
  if (req.method === 'GET' && url.pathname === '/api/cps/summary') return sendJson(res, 200, summary());
  if (req.method === 'GET' && url.pathname === '/api/cps/oee') return sendJson(res, 200, oeePayload());
  if (req.method === 'GET' && url.pathname === '/api/cps/data') return sendJson(res, 200, dataPayload());
  if (req.method === 'GET' && url.pathname === '/api/cps/interfaces') return sendJson(res, 200, { ...aas.interfaces(), runtimeMode: config.runtimeMode, ts: Date.now() });
  if (req.method === 'GET' && url.pathname === '/api/cps/lifecycle') { const current = state.getState(); const definition = aas.lifecycle(); return sendJson(res, 200, { cpsId: config.cpsId, assetName: config.cpsName, currentPhase: definition.currentPhase, supportedPhases: definition.supportedPhases, currentState: current.operationMode, playEnabled: current.playEnabled, lifecyclePhase: current.lifecyclePhase, operationMode: current.operationMode, ts: Date.now() }); }
  if (req.method === 'GET' && ['/api/cps/datasheet/pdf', '/api/cps1/datasheet/pdf'].includes(url.pathname)) {
    try {
      const pdf = fs.readFileSync(config.datasheetPath);
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="cps1-datasheet.pdf"' });
      return res.end(pdf);
    } catch (_) { return sendJson(res, 404, { error: 'Datasheet not available' }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/cps/command') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let command; try { command = JSON.parse(body || '{}'); } catch (_) { return sendJson(res, 400, { error: 'Invalid JSON' }); }
      const action = String(command.action || '').toLowerCase();
      if (!['play', 'stop', 'maintenance', 'return', 'unplug'].includes(action)) return sendJson(res, 400, { error: 'Unsupported action' });
      return sendJson(res, 200, applyCommand(action, true));
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/cps/governed-action') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let command; try { command = JSON.parse(body || '{}'); } catch (_) { return sendJson(res, 400, { error: 'Invalid JSON' }); }
      return sendJson(res, 200, applyGovernedAction(command, true));
    });
    return;
  }
  sendJson(res, 404, { error: 'Not found' });
}

function applyGovernedAction(command = {}, fromRest = false) {
  const action = String(command.action || '').toUpperCase();
  if (action !== 'ADJUST_WELDING_CURRENT') return { ok: false, error: 'Unsupported governed action' };
  const variation = Math.abs(Number(command.variation ?? command.requestedValue));
  const requestedValue = Number(command.requestedValue ?? command.variation);
  if (!Number.isFinite(variation) || !Number.isFinite(requestedValue)) return { ok: false, accepted: false, applied: false, error: 'Invalid variation' };
  const current = state.getState();
  const application = telemetry.applyWeldingCurrentAdjustment(requestedValue);
  if (!application.applied) return { ok: false, ...application };
  const executedAt = new Date().toISOString();
  const record = { ...command, action, variation, requestedValue, unit: command.unit || '%', executedAt, transport: fromRest ? 'REST' : 'MQTT', result: 'welding_current_adjustment_applied', ...application };
  const next = state.updateState({
    capabilityState: {
      ...(current.capabilityState || {}),
      status: current.capabilityState?.status || 'active',
      parameters: {
        ...(current.capabilityState?.parameters || {}),
        weldingCurrent: application.newValue,
        weldingCurrentAdjustmentPct: requestedValue,
      },
      lastGovernedAction: record,
    },
    governedActions: [record, ...(current.governedActions || [])].slice(0, 50),
  });
  if (config.runtimeMode === 'active') {
    mqtt.publish(`${config.baseTopic}/ack`, { cpsId: config.cpsId, cpsName: config.cpsName, type: 'governed_action', action, ok: true, accepted: true, applied: true, variation, requestedValue, previousValue: application.previousValue, newValue: application.newValue, unit: record.unit, ts: executedAt });
    mqtt.publish(`${config.baseTopic}/status`, status());
  }
  return { ok: true, accepted: true, applied: true, cpsId: config.cpsId, action, executionStatus: 'EXECUTED', executedAt, previousValue: application.previousValue, newValue: application.newValue, appliedVariation: application.appliedVariation, limits: application.limits, state: next, record };
}

const server = http.createServer(handle);
server.listen(config.httpPort, () => {
  console.log(`CPS-1 service listening on http://localhost:${config.httpPort} (${config.runtimeMode})`);
  mqtt.start();
  setInterval(() => {
    const sample = telemetry.sample();
    if (!sample) return;
    const healthValue = calculateHealth(sample);
    state.setHealth(healthValue);
    const oeeValue = oee.calculate(sample);
    const intelligence = analytics.update(sample, oeeValue, healthValue);
    if (config.runtimeMode === 'active') {
      mqtt.publish(`${config.baseTopic}/data`, sample);
      mqtt.publish(`${config.baseTopic}/health`, { cpsId: config.cpsId, cpsName: config.cpsName, ...healthValue, ts: Date.now() });
      mqtt.publish(`${config.baseTopic}/oee`, oeeValue);
      mqtt.publish(`${config.baseTopic}/status`, status());
      mqtt.publish(`acsm/${config.baseTopic}/oee`, oeeValue);
      mqtt.publish(`acsm/${config.baseTopic}/learning`, { cpsId: config.cpsId, learning: intelligence.learning, reasoning: intelligence.reasoning, timeSeriesFeatures: intelligence.features, ts: Date.now() });
    }
  }, config.telemetryIntervalMs);
});

process.on('SIGTERM', () => { mqtt.close(); server.close(() => process.exit(0)); });
process.on('SIGINT', () => { mqtt.close(); server.close(() => process.exit(0)); });
