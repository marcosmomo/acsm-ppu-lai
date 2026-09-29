'use strict';
class Lifecycle {
  constructor(state) { this.state = state; }
  command(action) {
    const a = String(action).toLowerCase();
    if (a === 'play') {
      const current = this.state.getState();
      const currentCapability = current.capabilityState || { feature: 'to_ship_the_part' };
      const currentStatus = String(currentCapability.status || '').toLowerCase();
      const capabilityStatus = ['failure', 'failed', 'fault'].includes(currentStatus)
        ? currentCapability.status
        : 'active';
      return this.state.updateState({
        lifecyclePhase: 'play',
        operationMode: 'running',
        playEnabled: true,
        maintenanceInProgress: false,
        capabilityState: { ...currentCapability, feature: 'to_ship_the_part', status: capabilityStatus },
        lastLifecycleReason: 'manual_play',
      });
    }
    if (a === 'stop') return this.state.updateState({ operationMode: 'stopped', playEnabled: false, lastLifecycleReason: 'manual_stop' });
    if (a === 'maintenance') {
      const current = this.state.getState();
      return this.state.updateState({
        operationMode: 'maintenance',
        playEnabled: false,
        maintenanceInProgress: true,
        capabilityState: {
          ...(current.capabilityState || {}),
          feature: 'to_ship_the_part',
          status: 'maintenance',
        },
        lastLifecycleReason: 'maintenance',
      });
    }
    if (a === 'unplug') return this.state.updateState({ lifecyclePhase: 'unplug', operationMode: 'stopped', playEnabled: false, lastLifecycleReason: 'manual_unplug' });
    if (a === 'return') {
      const current = this.state.getState();
      const currentCapability = current.capabilityState || { feature: 'to_ship_the_part' };
      const currentStatus = String(currentCapability.status || '').toLowerCase();
      const capabilityStatus = ['failure', 'failed', 'fault'].includes(currentStatus)
        ? currentCapability.status
        : 'active';
      return this.state.updateState({
        lifecyclePhase: 'play',
        operationMode: 'running',
        playEnabled: true,
        maintenanceInProgress: false,
        capabilityState: { ...currentCapability, feature: 'to_ship_the_part', status: capabilityStatus },
        lastLifecycleReason: 'maintenance_return',
      });
    }
    throw new Error('Unsupported action');
  }
  description() { return { lifecyclePhase: 'plug | play | unplug', operationMode: 'running | stopped | maintenance', return: 'reintegration process' }; }
}
module.exports = Lifecycle;
