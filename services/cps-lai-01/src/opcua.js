'use strict';

const fs = require('node:fs');
const REQUIRED = 'FIELD_CONFIRMATION_REQUIRED';
const COMMAND_NODE_BY_ACTION = {
  play: 'PlayNodeId',
  stop: 'StopNodeId',
  maintenance: 'MaintenanceNodeId',
  return: 'ReturnNodeId',
  unplug: 'UnplugNodeId',
  reset: 'ResetNodeId',
};
const COMMAND_FIELDS = new Set(['PlayNodeId', 'StopNodeId', 'ResetNodeId']);

function readMapping(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    console.error(`[FIELD_MAPPING_ERROR] ${error.message}`);
    return {};
  }
}

function nodeIdOf(entry) {
  if (typeof entry === 'string') return entry.trim();
  return String(entry?.nodeId || '').trim();
}

function isConfigured(entry) {
  const nodeId = nodeIdOf(entry);
  return Boolean(nodeId && nodeId !== REQUIRED);
}

function mappingStatus(config, mapping) {
  const missingFields = [];
  if (!config.opcuaEndpoint) missingFields.push('OPCUA_ENDPOINT');
  Object.entries(mapping).forEach(([field, entry]) => {
    if (!isConfigured(entry)) missingFields.push(field);
  });
  return { ready: missingFields.length === 0, missingFields };
}

function securityMode(api, value) {
  const key = String(value || 'None').replace(/[^a-z]/gi, '').toLowerCase();
  const match = Object.keys(api.MessageSecurityMode).find(
    (item) => item.replace(/[^a-z]/gi, '').toLowerCase() === key
  );
  return match ? api.MessageSecurityMode[match] : api.MessageSecurityMode.None;
}

function securityPolicy(api, value) {
  const key = String(value || 'None').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const match = Object.keys(api.SecurityPolicy).find(
    (item) => item.replace(/[^a-z0-9]/gi, '').toLowerCase() === key
  );
  return match ? api.SecurityPolicy[match] : api.SecurityPolicy.None;
}

class OpcuaAdapter {
  constructor(config, state, onSample) {
    this.config = config;
    this.state = state;
    this.onSample = onSample;
    this.mapping = readMapping(config.fieldMappingFile);
    this.mappingStatus = mappingStatus(config, this.mapping);
    this.api = null;
    this.client = null;
    this.session = null;
    this.subscription = null;
    this.stopping = false;
  }

  async start() {
    if (!this.config.opcuaEndpoint) {
      console.warn('[OPCUA_NOT_CONFIGURED] OPCUA_ENDPOINT is empty; REST and MQTT remain available.');
      return;
    }
    await this.connectWithRetry();
  }

  async connectWithRetry() {
    if (this.stopping) return;
    try {
      this.api ||= require('node-opcua');
      this.client = this.api.OPCUAClient.create({
        applicationName: this.config.serviceName,
        securityMode: securityMode(this.api, this.config.opcuaSecurityMode),
        securityPolicy: securityPolicy(this.api, this.config.opcuaSecurityPolicy),
        endpointMustExist: false,
        connectionStrategy: {
          initialDelay: this.config.opcuaReconnectIntervalMs,
          maxDelay: Math.max(this.config.opcuaReconnectIntervalMs, 30000),
          maxRetry: -1,
        },
        keepSessionAlive: true,
      });
      this.client.on('connection_lost', () => this.state.setOpcuaConnection(false, 'connection_lost'));
      this.client.on('backoff', (_retry, delay) => {
        this.state.setOpcuaConnection(false, `reconnecting_in_${delay}ms`);
      });
      await this.client.connect(this.config.opcuaEndpoint);
      const identity = this.config.opcuaUsername
        ? { userName: this.config.opcuaUsername, password: this.config.opcuaPassword }
        : undefined;
      this.session = await this.client.createSession(identity);
      this.state.setOpcuaConnection(true);
      await this.monitorConfiguredFields();
      console.log(`[OPCUA_CONNECT] Connected to configured endpoint.`);
    } catch (error) {
      this.state.setOpcuaConnection(false, error);
      console.error(`[OPCUA_ERROR] ${error.message}`);
      if (!this.stopping) {
        setTimeout(() => this.connectWithRetry(), this.config.opcuaReconnectIntervalMs).unref();
      }
    }
  }

  async monitorConfiguredFields() {
    const readable = Object.entries(this.mapping).filter(
      ([field, entry]) => !COMMAND_FIELDS.has(field) && isConfigured(entry)
    );
    if (!readable.length) return;
    this.subscription = this.api.ClientSubscription.create(this.session, {
      requestedPublishingInterval: 1000,
      requestedLifetimeCount: 100,
      requestedMaxKeepAliveCount: 10,
      maxNotificationsPerPublish: 100,
      publishingEnabled: true,
      priority: 1,
    });
    this.subscription.on('terminated', () => this.state.setOpcuaConnection(false, 'subscription_terminated'));

    readable.forEach(([field, entry]) => {
      const monitored = this.api.ClientMonitoredItem.create(
        this.subscription,
        { nodeId: nodeIdOf(entry), attributeId: this.api.AttributeIds.Value },
        { samplingInterval: 500, discardOldest: true, queueSize: 10 },
        this.api.TimestampsToReturn.Both
      );
      monitored.on('changed', (dataValue) => {
        const statusCode = dataValue.statusCode?.toString() || 'Unknown';
        const valid = dataValue.statusCode?.isGood?.() === true;
        const sample = {
          value: valid ? dataValue.value?.value : null,
          dataType: dataValue.value?.dataType?.toString() || null,
          quality: statusCode,
          valid,
          stale: false,
          sourceTimestamp: dataValue.sourceTimestamp?.toISOString() || null,
          serverTimestamp: dataValue.serverTimestamp?.toISOString() || null,
          receivedAt: new Date().toISOString(),
        };
        this.state.setFieldValue(field, sample);
        this.onSample(field, sample);
      });
      monitored.on('err', (message) => console.error(`[OPCUA_MONITOR_ERROR] ${field}: ${message}`));
    });
  }

  missingForCommand(action) {
    const nodeField = COMMAND_NODE_BY_ACTION[action];
    const missing = [];
    if (!this.config.opcuaEndpoint) missing.push('OPCUA_ENDPOINT');
    if (!nodeField || !isConfigured(this.mapping[nodeField])) missing.push(nodeField || 'CommandNodeId');
    return missing;
  }

  async executeCommand(action) {
    const missingFields = this.missingForCommand(action);
    if (missingFields.length) {
      return { success: false, reason: 'FIELD_CONFIGURATION_REQUIRED', missingFields };
    }
    if (!this.session || !this.state.snapshot().opcuaConnected) {
      return { success: false, reason: 'OPCUA_NOT_CONNECTED', missingFields: [] };
    }
    const field = COMMAND_NODE_BY_ACTION[action];
    try {
      const status = await this.session.writeSingleNode(
        nodeIdOf(this.mapping[field]),
        new this.api.Variant({ dataType: this.api.DataType.Boolean, value: true })
      );
      if (!status.isGood()) {
        return { success: false, reason: 'OPCUA_WRITE_REJECTED', quality: status.toString() };
      }
      return { success: true, reason: 'COMMAND_WRITTEN', quality: status.toString() };
    } catch (error) {
      return { success: false, reason: 'OPCUA_WRITE_FAILED', detail: error.message };
    }
  }

  async close() {
    this.stopping = true;
    await this.subscription?.terminate().catch(() => {});
    await this.session?.close().catch(() => {});
    await this.client?.disconnect().catch(() => {});
  }
}

module.exports = { OpcuaAdapter, readMapping, mappingStatus };
