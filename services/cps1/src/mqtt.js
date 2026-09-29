'use strict';

const mqtt = require('mqtt');

function brokerUrl(config) {
  const broker = String(config.mqttBroker || '').trim();
  if (/^[a-z]+:\/\//i.test(broker)) return broker;
  return `mqtt://${broker}:${config.mqttPort}`;
}

class Mqtt {
  constructor(config, onCommand) { this.config = config; this.onCommand = onCommand; this.client = null; }
  start() {
    if (this.config.runtimeMode !== 'active') return { connected: false, mode: 'shadow' };
    const url = brokerUrl(this.config);
    this.client = mqtt.connect(url, { username: this.config.mqttUsername || undefined, password: this.config.mqttPassword || undefined });
    this.client.on('connect', () => {
      console.log(`[MQTT_CONNECT] ${this.config.baseTopic} connected to ${url}`);
      this.client.subscribe(`${this.config.baseTopic}/cmd`);
    });
    this.client.on('error', (error) => console.error(`[MQTT_ERROR] ${this.config.baseTopic}: ${error.message}`));
    this.client.on('close', () => console.warn(`[MQTT_CLOSE] ${this.config.baseTopic} connection closed`));
    this.client.on('offline', () => console.warn(`[MQTT_OFFLINE] ${this.config.baseTopic} client offline`));
    this.client.on('reconnect', () => console.warn(`[MQTT_RECONNECT] ${this.config.baseTopic} reconnecting`));
    this.client.on('message', (_topic, message) => { try { this.onCommand(JSON.parse(message.toString())); } catch (_) { /* ignore malformed commands */ } });
    return { connected: true, mode: 'active' };
  }
  publish(topic, payload) {
    if (!this.client || this.config.runtimeMode !== 'active') return false;
    this.client.publish(topic, JSON.stringify(payload), { qos: 1 });
    return true;
  }
  close() { this.client?.end(); }
}

module.exports = Mqtt;
