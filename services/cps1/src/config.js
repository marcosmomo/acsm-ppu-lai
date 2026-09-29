'use strict';

const path = require('node:path');

function value(name, fallback) {
  return process.env[name] === undefined || process.env[name] === '' ? fallback : process.env[name];
}

function integer(name, fallback) {
  const parsed = Number.parseInt(value(name, String(fallback)), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const serviceRoot = path.resolve(__dirname, '..');

module.exports = Object.freeze({
  cpsId: value('CPS_ID', 'CPS-001'),
  cpsName: value('CPS_NAME', 'RoboSoldagemAlfa'),
  baseTopic: value('CPS_BASE_TOPIC', 'cps1'),
  httpPort: integer('HTTP_PORT', 3001),
  mqttBroker: value('MQTT_BROKER', 'acsm-mosquitto'),
  mqttPort: integer('MQTT_PORT', 1883),
  mqttUsername: value('MQTT_USERNAME', ''),
  mqttPassword: value('MQTT_PASSWORD', ''),
  acsmUrl: value('ACSM_URL', ''),
  runtimeMode: value('CPS_RUNTIME_MODE', 'shadow').toLowerCase() === 'active' ? 'active' : 'shadow',
  logDir: value('CPS_LOG_DIR', path.join(serviceRoot, 'data', 'logs')),
  telemetryIntervalMs: integer('CPS_TELEMETRY_INTERVAL_MS', 1000),
  datasheetPath: value('CPS_DATASHEET_PATH', path.join(serviceRoot, 'resources', 'datasheet.pdf')),
  statePath: value('CPS_STATE_PATH', path.join(serviceRoot, 'data', 'runtime-state.json')),
  aasPath: path.join(serviceRoot, 'aas', 'aas.json')
});
