'use strict';

const path = require('node:path');

const root = path.resolve(__dirname, '..');
const value = (name, fallback = '') => {
  const current = process.env[name];
  return current === undefined || current === '' ? fallback : current;
};
const integer = (name, fallback) => {
  const parsed = Number.parseInt(value(name, String(fallback)), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};
const mqttBaseTopic = value('MQTT_BASE_TOPIC', 'cpslai1');

module.exports = Object.freeze({
  serviceName: 'cps-lai-01',
  cpsId: value('CPS_ID', 'cpslai1'),
  formalId: value('CPS_FORMAL_ID', 'CPS-LAI-01'),
  cpsName: value('CPS_NAME', 'DistributionConveyorStationLAI'),
  port: integer('PORT', 3010),
  mqttUrl: value('MQTT_URL', 'mqtt://acsm-mosquitto:1883'),
  mqttBaseTopic,
  topics: Object.freeze({
    command: `${mqttBaseTopic}/cmd`,
    acknowledgement: `${mqttBaseTopic}/ack`,
    status: `${mqttBaseTopic}/status`,
    health: `${mqttBaseTopic}/health`,
    data: `${mqttBaseTopic}/data`,
    sensorData: `${mqttBaseTopic}/sensordata`,
    oee: `${mqttBaseTopic}/oee`,
    learning: `acsm/${mqttBaseTopic}/learning`,
    reasoning: `acsm/${mqttBaseTopic}/reasoning`,
    recommendation: `acsm/${mqttBaseTopic}/recommendation`,
  }),
  mqttUsername: value('MQTT_USERNAME'),
  mqttPassword: value('MQTT_PASSWORD'),
  opcuaEndpoint: value('OPCUA_ENDPOINT'),
  opcuaSecurityMode: value('OPCUA_SECURITY_MODE'),
  opcuaSecurityPolicy: value('OPCUA_SECURITY_POLICY'),
  opcuaUsername: value('OPCUA_USERNAME'),
  opcuaPassword: value('OPCUA_PASSWORD'),
  opcuaReconnectIntervalMs: integer('OPCUA_RECONNECT_INTERVAL_MS', 5000),
  fieldMappingFile: value(
    'FIELD_MAPPING_FILE',
    path.join(root, 'config', 'field-mapping.example.json')
  ),
  aasFile: value('AAS_FILE', path.join(root, 'aas', 'aas.json')),
  staleAfterMs: integer('OPCUA_STALE_AFTER_MS', 15000),
});
