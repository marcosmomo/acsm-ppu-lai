'use strict';

class RuntimeState {
  constructor(config, mappingStatus) {
    this.config = config;
    this.value = {
      lifecycleState: 'plugged',
      operationalState: 'offline',
      availability: 'unavailable',
      healthState: 'unknown',
      integrationState: mappingStatus.ready
        ? 'awaiting_opcua_connection'
        : 'awaiting_field_configuration',
      mqttConnected: false,
      opcuaConfigured: Boolean(config.opcuaEndpoint),
      opcuaConnected: false,
      fieldConfigurationReady: mappingStatus.ready,
      missingFields: mappingStatus.missingFields,
      data: {},
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastOpcuaError: null,
    };
  }

  snapshot() {
    return structuredClone(this.value);
  }

  patch(patch) {
    this.value = { ...this.value, ...patch, updatedAt: new Date().toISOString() };
    return this.snapshot();
  }

  setMqttConnected(connected) {
    return this.patch({ mqttConnected: Boolean(connected) });
  }

  setOpcuaConnection(connected, error = null) {
    const isConnected = Boolean(connected);
    return this.patch({
      opcuaConnected: isConnected,
      operationalState: isConnected ? 'connected' : 'offline',
      availability: isConnected ? 'available' : 'unavailable',
      integrationState: isConnected
        ? 'connected'
        : this.value.opcuaConfigured && this.value.fieldConfigurationReady
          ? 'awaiting_opcua_connection'
          : 'awaiting_field_configuration',
      lastOpcuaError: error ? String(error.message || error) : null,
    });
  }

  setFieldValue(field, sample) {
    const data = { ...this.value.data, [field]: sample };
    return this.patch({ data });
  }

  markStale(now = Date.now()) {
    let changed = false;
    const data = Object.fromEntries(
      Object.entries(this.value.data).map(([field, sample]) => {
        const timestamp = Date.parse(sample.sourceTimestamp || sample.serverTimestamp || '');
        const stale = !Number.isFinite(timestamp) || now - timestamp > this.config.staleAfterMs;
        if (stale !== sample.stale) changed = true;
        return [field, { ...sample, stale, valid: sample.valid === true && !stale }];
      })
    );
    if (changed) this.patch({ data });
    return this.snapshot();
  }
}

module.exports = RuntimeState;
