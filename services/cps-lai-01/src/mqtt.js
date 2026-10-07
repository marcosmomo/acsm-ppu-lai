'use strict';

const mqtt = require('mqtt');

class MqttAdapter {
  constructor(config, state, onCommand, payloads) {
    this.config = config;
    this.state = state;
    this.onCommand = onCommand;
    this.payloads = payloads;
    this.client = null;
  }

  start() {
    this.client = mqtt.connect(this.config.mqttUrl, {
      username: this.config.mqttUsername || undefined,
      password: this.config.mqttPassword || undefined,
      reconnectPeriod: 5000,
    });
    this.client.on('connect', () => {
      this.state.setMqttConnected(true);
      this.client.subscribe(this.config.topics.command, { qos: 1 });
      this.publishTechnicalState();
      console.log(`[MQTT_CONNECT] ${this.config.mqttBaseTopic} connected to ${this.config.mqttUrl}`);
    });
    this.client.on('message', (topic, buffer) => {
      if (topic !== this.config.topics.command) return;
      try {
        this.onCommand(JSON.parse(buffer.toString('utf8')));
      } catch (error) {
        this.publish(this.config.topics.acknowledgement, {
          cpsId: this.config.cpsId,
          success: false,
          reason: 'INVALID_COMMAND_PAYLOAD',
          detail: error.message,
          timestamp: new Date().toISOString(),
        });
      }
    });
    this.client.on('close', () => this.state.setMqttConnected(false));
    this.client.on('offline', () => this.state.setMqttConnected(false));
    this.client.on('error', (error) => {
      this.state.setMqttConnected(false);
      console.error(`[MQTT_ERROR] ${error.message}`);
    });
  }

  publish(topic, payload, options = {}) {
    if (!this.client?.connected) return false;
    this.client.publish(topic, JSON.stringify(payload), { qos: 1, ...options });
    return true;
  }

  publishTechnicalState() {
    this.publish(this.config.topics.status, this.payloads.status(), { retain: true });
  }

  close() {
    this.client?.end(true);
  }
}

module.exports = MqttAdapter;
