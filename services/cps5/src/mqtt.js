'use strict';
function brokerUrl(config) {
  const broker = String(config.mqttBroker || '').trim();
  if (/^[a-z]+:\/\//i.test(broker)) return broker;
  return `mqtt://${broker}:${config.mqttPort}`;
}

class Mqtt {
  constructor(config, onCommand) { this.config = config; this.onCommand = onCommand; this.client = null; }
  start() { if (this.config.runtimeMode !== 'active') return; let mqtt; try { mqtt = require('mqtt'); } catch (error) { console.error(`MQTT unavailable: ${error.message}`); return; } const url = brokerUrl(this.config); this.client = mqtt.connect(url, { username: this.config.mqttUsername || undefined, password: this.config.mqttPassword || undefined }); this.client.on('connect', () => { console.log(`[MQTT_CONNECT] ${this.config.baseTopic} connected to ${url}`); this.client.subscribe(`${this.config.baseTopic}/cmd`); }); this.client.on('error', (error) => console.error(`[MQTT_ERROR] ${this.config.baseTopic}: ${error.message}`)); this.client.on('close', () => console.warn(`[MQTT_CLOSE] ${this.config.baseTopic} connection closed`)); this.client.on('offline', () => console.warn(`[MQTT_OFFLINE] ${this.config.baseTopic} client offline`)); this.client.on('reconnect', () => console.warn(`[MQTT_RECONNECT] ${this.config.baseTopic} reconnecting`)); this.client.on('message', (_, payload) => { try { this.onCommand(JSON.parse(payload.toString())); } catch (_) {} }); }
  publish(topic, payload) { if (this.client?.connected) this.client.publish(topic, JSON.stringify(payload), { qos: 1 }); }
  close() { this.client?.end(); }
}
module.exports = Mqtt;
