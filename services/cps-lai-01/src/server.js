'use strict';

const http = require('node:http');
const config = require('./config');
const AasRepository = require('./aas');
const RuntimeState = require('./state');
const MqttAdapter = require('./mqtt');
const { OpcuaAdapter, readMapping, mappingStatus } = require('./opcua');

const COMMANDS = new Set(['play', 'stop', 'maintenance', 'return', 'unplug', 'reset']);
const aas = new AasRepository(config.aasFile);
const mapping = readMapping(config.fieldMappingFile);
const initialMappingStatus = mappingStatus(config, mapping);
const state = new RuntimeState(config, initialMappingStatus);

function statusPayload() {
  const current = state.snapshot();
  return {
    cpsId: config.cpsId,
    formalId: config.formalId,
    cpsName: config.cpsName,
    lifecycleState: current.lifecycleState,
    operationalState: current.operationalState,
    availability: current.availability,
    integrationState: current.integrationState,
    opcuaConfigured: current.opcuaConfigured,
    opcuaConnected: current.opcuaConnected,
    timestamp: new Date().toISOString(),
  };
}

function healthPayload() {
  const current = state.snapshot();
  return {
    service: config.serviceName,
    cpsId: config.cpsId,
    status: 'running',
    http: 'healthy',
    mqtt: current.mqttConnected ? 'connected' : 'disconnected',
    opcua: current.opcuaConfigured
      ? current.opcuaConnected ? 'connected' : 'disconnected'
      : 'not_configured',
    opcuaConfigured: current.opcuaConfigured,
    opcuaConnected: current.opcuaConnected,
    fieldConfigurationReady: current.fieldConfigurationReady,
    missingFields: current.missingFields,
    lifecycleState: current.lifecycleState,
    operationalState: current.operationalState,
    availability: current.availability,
    healthState: current.healthState,
    integrationState: current.integrationState,
    lastOpcuaError: current.lastOpcuaError,
    timestamp: new Date().toISOString(),
  };
}

function dataPayload() {
  const current = state.markStale();
  return {
    cpsId: config.cpsId,
    data: current.data,
    timestamp: new Date().toISOString(),
  };
}

let mqttAdapter;
const opcuaAdapter = new OpcuaAdapter(config, state, (field, sample) => {
  const payload = {
    cpsId: config.cpsId,
    field,
    sample,
    timestamp: new Date().toISOString(),
  };
  mqttAdapter?.publish(config.topics.data, payload);
  mqttAdapter?.publish(config.topics.sensorData, payload);
});

async function handleCommand(command = {}) {
  const action = String(command.action || command.command || '').trim().toLowerCase();
  let result;
  if (!COMMANDS.has(action)) {
    result = { success: false, reason: 'UNSUPPORTED_COMMAND', missingFields: [] };
  } else {
    result = await opcuaAdapter.executeCommand(action);
  }
  const ack = {
    cpsId: config.cpsId,
    command: action || null,
    ...result,
    timestamp: new Date().toISOString(),
  };
  mqttAdapter.publish(config.topics.acknowledgement, ack);
  mqttAdapter.publishTechnicalState();
  return ack;
}

mqttAdapter = new MqttAdapter(config, state, handleCommand, {
  status: statusPayload,
  health: healthPayload,
});

function summaryPayload() {
  const current = state.markStale();
  const actualValues = Object.fromEntries(
    Object.entries(current.data)
      .filter(([, sample]) => sample.valid === true && sample.stale !== true)
      .map(([field, sample]) => [field, sample])
  );
  return {
    cpsId: config.cpsId,
    formalId: config.formalId,
    assetName: config.cpsName,
    lifecycleState: current.lifecycleState,
    operationalState: current.operationalState,
    availability: current.availability,
    healthState: current.healthState,
    integrationState: current.integrationState,
    actualFieldValues: actualValues,
    oee: null,
    timestamp: new Date().toISOString(),
  };
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/health') return sendJson(res, 200, healthPayload());
  if (req.method === 'GET' && url.pathname === '/api/cpslai1/health') return sendJson(res, 200, healthPayload());
  if (req.method === 'GET' && url.pathname === '/api/cpslai1/description') {
    try {
      return sendJson(res, 200, { ...aas.description(config), ...statusPayload() });
    } catch (error) {
      return sendJson(res, 503, { error: 'AAS_UNAVAILABLE', detail: error.message });
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/cpslai1/summary') return sendJson(res, 200, summaryPayload());
  if (req.method === 'GET' && url.pathname === '/api/cpslai1/aas') {
    try {
      return sendJson(res, 200, aas.read());
    } catch (error) {
      return sendJson(res, 503, { error: 'AAS_UNAVAILABLE', detail: error.message });
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/cpslai1/data') return sendJson(res, 200, dataPayload());
  return sendJson(res, 404, { error: 'Not found' });
}

const server = http.createServer(handle);
server.listen(config.port, '0.0.0.0', () => {
  console.log(`[HTTP_READY] ${config.serviceName} listening on 0.0.0.0:${config.port}`);
  mqttAdapter.start();
  opcuaAdapter.start().catch((error) => console.error(`[OPCUA_START_ERROR] ${error.message}`));
});

const technicalStateTimer = setInterval(() => {
  state.markStale();
  mqttAdapter.publishTechnicalState();
}, 10000);
technicalStateTimer.unref();

async function shutdown() {
  clearInterval(technicalStateTimer);
  mqttAdapter.close();
  await opcuaAdapter.close();
  server.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
