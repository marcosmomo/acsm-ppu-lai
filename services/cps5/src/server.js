'use strict';
const fs = require('node:fs');
const http = require('node:http');
const config = require('./config');
const State = require('./state');
const Lifecycle = require('./lifecycle');
const Telemetry = require('./telemetry');
const Oee = require('./oee');
const Analytics = require('./analytics');
const Aas = require('./aas');
const Mqtt = require('./mqtt');
const { calculate: calculateHealth } = require('./health');

const state = new State(config);
const lifecycle = new Lifecycle(state);
const telemetry = new Telemetry(state);
const oee = new Oee(state, telemetry);
const analytics = new Analytics(state);
const aas = new Aas(config.aasPath, config);
const mqtt = new Mqtt(config, (command) => {
  const action = String(command?.action || '').toUpperCase();
  if (['PLAY', 'STOP', 'MAINTENANCE', 'RETURN', 'UNPLUG'].includes(action)) applyCommand(action.toLowerCase(), false);
  if (command?.type === 'governed_action' || action === 'ADJUST_INSPECTION_THRESHOLD') applyGovernedAction(command, false);
});

function featureStatus(sample) {
  if (!sample) return state.getState().capabilityState.status || 'unknown';
  const threshold = Number(state.getState().capabilityState?.parameters?.inspectionThreshold || 350);
  if (sample.Luminosity < threshold) return 'awaiting_replacement';
  if (sample.CurrentRPM < 1100 || sample.CycleTimeMs > 2000) return 'maintenance';
  return 'active';
}
function status() { const s = state.getState(); const h = s.health || calculateHealth(s.capabilityState.status); return { cpsId: config.cpsId, cpsName: config.cpsName, state: s.operationMode, lifecyclePhase: s.lifecyclePhase, operationMode: s.operationMode, playEnabled: s.playEnabled, feature: 'inspect_part_quality', featureStatus: s.capabilityState.status || 'unknown', healthScore: h.healthScore, healthLabel: h.healthLabel, featureCount: 1, summary: { [s.capabilityState.status || 'unknown']: 1 }, ts: Date.now() }; }
function description() { return { ...aas.description(), currentState: state.getState().operationMode, ts: Date.now() }; }
function health() { const s = state.getState(); const h = s.health || calculateHealth(s.capabilityState.status); return { cpsId: config.cpsId, cpsName: config.cpsName, ...h, operationalState: s.operationMode, lifecyclePhase: s.lifecyclePhase, lastHeartbeat: s.timestamps.updatedAt || s.timestamps.startedAt, ts: Date.now() }; }
function summary() { const s = state.getState(); const t = s.lastTelemetry || s.lastValidTelemetry || {}; const h = s.health || calculateHealth(s.capabilityState.status); const o = s.oee?.oee || {}; return { cpsId: config.cpsId, assetName: config.cpsName, state: s.operationMode, lifecyclePhase: s.lifecyclePhase, operationMode: s.operationMode, playEnabled: s.playEnabled, healthScore: h.healthScore, healthLabel: h.healthLabel, oee: o.current || 0, availability: o.availability || 0, performance: o.performance || 0, quality: o.quality || 0, currentTemperature: Number(t.CurrentTemperature || 0), currentRPM: Number(t.CurrentRPM || 0), currentTorque: Number(t.CurrentTorque || 0), luminosity: Number(t.Luminosity || 0), pieceCounter: Number(t.PieceCounter || 0), cycleTimeMs: Number(t.CycleTimeMs || 0), featureName: 'inspect_part_quality', featureStatus: s.capabilityState.status || 'unknown', ts: Date.now() }; }
function data() { const s = state.getState(); return { cpsId: config.cpsId, assetName: config.cpsName, operationalData: s.lastTelemetry || s.lastValidTelemetry || null, lastValidTelemetry: s.lastValidTelemetry, ts: Date.now() }; }
function oeePayload() { const value = state.getOEE() || { oee: { current: 0, availability: 0, performance: 0, quality: 0 } }; return { cpsId: config.cpsId, assetName: config.cpsName, ...value, ts: Date.now() }; }
function sendJson(res, code, value) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
function applyCommand(action, fromRest) { const next = lifecycle.command(action); const s = state.getState(); if (fromRest && config.runtimeMode === 'shadow') return { ok: true, shadowMode: true, action, published: false, state: next }; if (config.runtimeMode === 'active') { mqtt.publish(`${config.baseTopic}/ack`, { cpsId: config.cpsId, cpsName: config.cpsName, action, ok: true, playEnabled: s.playEnabled, status: s.operationMode, ts: new Date().toISOString() }); mqtt.publish(`${config.baseTopic}/status`, status()); } return { ok: true, shadowMode: config.runtimeMode !== 'active', state: next };
}
function applyGovernedAction(command = {}, fromRest = false) {
  const action = String(command.action || '').toUpperCase();
  if (action !== 'ADJUST_INSPECTION_THRESHOLD') return { ok: false, error: 'Unsupported governed action' };
  const variation = Math.abs(Number(command.variation ?? command.requestedValue));
  const requestedValue = Number(command.requestedValue ?? command.variation);
  if (!Number.isFinite(variation) || !Number.isFinite(requestedValue)) return { ok: false, accepted: false, applied: false, error: 'Invalid variation' };
  const current = state.getState();
  const application = telemetry.applyInspectionThresholdAdjustment(requestedValue);
  if (!application.applied) return { ok: false, ...application };
  const executedAt = new Date().toISOString();
  const record = { ...command, action, variation, requestedValue, unit: command.unit || '%', executedAt, transport: fromRest ? 'REST' : 'MQTT', result: 'inspection_threshold_adjustment_applied', ...application };
  const next = state.updateState({
    capabilityState: {
      ...(current.capabilityState || {}),
      parameters: {
        ...(current.capabilityState?.parameters || {}),
        inspectionThreshold: application.newValue,
        inspectionThresholdAdjustmentPct: requestedValue,
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
function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/api/cps/description') return sendJson(res, 200, description());
  if (req.method === 'GET' && url.pathname === '/api/cps/status') return sendJson(res, 200, status());
  if (req.method === 'GET' && url.pathname === '/api/cps/health') return sendJson(res, 200, health());
  if (req.method === 'GET' && url.pathname === '/api/cps/summary') return sendJson(res, 200, summary());
  if (req.method === 'GET' && url.pathname === '/api/cps/oee') return sendJson(res, 200, oeePayload());
  if (req.method === 'GET' && url.pathname === '/api/cps/data') return sendJson(res, 200, data());
  if (req.method === 'GET' && url.pathname === '/api/cps/interfaces') return sendJson(res, 200, { ...aas.interfaces(), runtimeMode: config.runtimeMode, ts: Date.now() });
  if (req.method === 'GET' && url.pathname === '/api/cps/lifecycle') { const s = state.getState(); return sendJson(res, 200, { cpsId: config.cpsId, assetName: config.cpsName, ...aas.lifecycle(), lifecyclePhase: s.lifecyclePhase, operationMode: s.operationMode, playEnabled: s.playEnabled, ts: Date.now() }); }
  if (req.method === 'GET' && ['/api/cps/datasheet/pdf', '/api/cps5/datasheet/pdf'].includes(url.pathname)) { try { const pdf = fs.readFileSync(config.datasheetPath); res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="cps5-datasheet.pdf"' }); return res.end(pdf); } catch (_) { return sendJson(res, 404, { error: 'Datasheet not available' }); } }
  if (req.method === 'POST' && url.pathname === '/api/cps/command') { let body = ''; req.on('data', (chunk) => { body += chunk; }); req.on('end', () => { let command; try { command = JSON.parse(body || '{}'); } catch (_) { return sendJson(res, 400, { error: 'Invalid JSON' }); } if (!['play', 'stop', 'maintenance', 'return', 'unplug'].includes(String(command.action).toLowerCase())) return sendJson(res, 400, { error: 'Unsupported action' }); return sendJson(res, 200, applyCommand(String(command.action).toLowerCase(), true)); }); return; }
  if (req.method === 'POST' && url.pathname === '/api/cps/governed-action') { let body = ''; req.on('data', (chunk) => { body += chunk; }); req.on('end', () => { let command; try { command = JSON.parse(body || '{}'); } catch (_) { return sendJson(res, 400, { error: 'Invalid JSON' }); } return sendJson(res, 200, applyGovernedAction(command, true)); }); return; }
  sendJson(res, 404, { error: 'Not found' });
}

const server = http.createServer(handle);
server.listen(config.httpPort, () => { console.log(`CPS-5 service listening on http://localhost:${config.httpPort} (${config.runtimeMode})`); mqtt.start(); });
const timer = setInterval(() => { const sample = telemetry.sample(); if (!sample) return; const feature = featureStatus(sample); const currentState = state.getState(); state.updateState({ capabilityState: { ...(currentState.capabilityState || {}), status: feature, details: { luminosity: sample.Luminosity, rpm: sample.CurrentRPM, torque: sample.CurrentTorque, temperature: sample.CurrentTemperature, cycleTimeMs: sample.CycleTimeMs, pieceCounter: sample.PieceCounter, inspectionThreshold: sample.InspectionThreshold } } }); const h = calculateHealth(feature); state.setHealth(h); const o = oee.calculate(feature); const intelligence = analytics.update(sample, o, h, feature); if (config.runtimeMode === 'active') { mqtt.publish(`${config.baseTopic}/data`, sample); mqtt.publish(`${config.baseTopic}/sensordata`, { luminosity: sample.Luminosity, rpm: sample.CurrentRPM, torque: sample.CurrentTorque, temperature: sample.CurrentTemperature, cycleTimeMs: sample.CycleTimeMs, pieceCounter: sample.PieceCounter }); mqtt.publish(`${config.baseTopic}/health`, { cpsId: config.cpsId, cpsName: config.cpsName, ...h, ts: Date.now() }); mqtt.publish(`${config.baseTopic}/oee`, o); mqtt.publish(`${config.baseTopic}/status`, status()); mqtt.publish(`acsm/${config.baseTopic}/oee`, o); mqtt.publish(`acsm/${config.baseTopic}/learning`, { cpsId: config.cpsId, cpsName: config.cpsName, learning: intelligence.learning, reasoning: intelligence.reasoning, timeSeriesFeatures: intelligence.timeSeriesFeatures, ts: Date.now() }); } }, config.telemetryIntervalMs);
function close() { clearInterval(timer); mqtt.close(); server.close(() => process.exit(0)); }
process.on('SIGTERM', close); process.on('SIGINT', close);
