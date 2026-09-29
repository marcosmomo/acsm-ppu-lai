'use strict';

const path = require('node:path');

const projectRoot = process.env.ACSM_PROJECT_ROOT || path.resolve(__dirname, '..');

function env(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function integer(name, fallback) {
  const value = Number.parseInt(env(name, String(fallback)), 10);
  return Number.isFinite(value) ? value : fallback;
}

module.exports = Object.freeze({
  cpsId: env('CPS_ID', 'CPS-001'),
  cpsName: env('CPS_NAME', 'RoboSoldagemAlfa'),
  baseTopic: env('CPS_BASE_TOPIC', 'cps1'),
  mqttBroker: env('MQTT_BROKER', 'acsm-mosquitto'),
  mqttPort: integer('MQTT_PORT', 1883),
  mqttUsername: env('MQTT_USERNAME', ''),
  mqttPassword: env('MQTT_PASSWORD', ''),
  httpPort: integer('HTTP_PORT', 3001),
  acsmUrl: env('ACSM_URL', 'http://localhost:1881'),
  hcmApiBaseUrl: env('HCM_API_BASE_URL', 'http://localhost:3000/api/hcm'),
  logDir: env('CPS_LOG_DIR', 'C:\\cps1-logs'),
  telemetryIntervalMs: integer('CPS_TELEMETRY_INTERVAL_MS', 1000),
  datasheetPath: env('CPS_DATASHEET_PATH', path.join(projectRoot, 'resources', 'cps1', 'datasheet.pdf')),
  statePath: env('CPS_STATE_PATH', path.join(projectRoot, 'data', 'cps1-runtime-state.json')),
  projectRoot
});
