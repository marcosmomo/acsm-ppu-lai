'use strict';
const path = require('node:path');
const root = path.resolve(__dirname, '..');
module.exports = {
  cpsId: process.env.CPS_ID || 'CPS-005',
  cpsName: process.env.CPS_NAME || 'SistemaVisao_Qualit',
  baseTopic: process.env.CPS_BASE_TOPIC || 'cps5',
  httpPort: Number(process.env.HTTP_PORT || 3005),
  runtimeMode: process.env.CPS_RUNTIME_MODE || 'shadow',
  mqttBroker: process.env.MQTT_BROKER || 'acsm-mosquitto',
  mqttPort: Number(process.env.MQTT_PORT || 1883),
  mqttUsername: process.env.MQTT_USERNAME || '',
  mqttPassword: process.env.MQTT_PASSWORD || '',
  acsmUrl: process.env.ACSM_URL || '',
  telemetryIntervalMs: Number(process.env.CPS_TELEMETRY_INTERVAL_MS || 1000),
  statePath: process.env.CPS_STATE_PATH || path.join(root, 'data', 'runtime-state.json'),
  logDir: process.env.CPS_LOG_DIR || path.join(root, 'data', 'logs'),
  aasPath: path.join(root, 'aas', 'aas.json'),
  datasheetPath: process.env.CPS_DATASHEET_PATH || path.join(root, 'resources', 'datasheet.pdf')
};
