'use strict';
class Lifecycle {
  constructor(state) { this.state = state; }
  command(action) {
    const a = String(action || '').toLowerCase();
    if (a === 'play') return this.state.setState({ lifecyclePhase: 'play', operationMode: 'running', playEnabled: true, maintenanceInProgress: false, autoReturnAfterMaintenance: false, lastLifecycleReason: 'manual_play' });
    if (a === 'stop') return this.state.setState({ operationMode: 'stopped', playEnabled: false, lastLifecycleReason: 'manual_stop' });
    if (a === 'maintenance') return this.state.setState({ operationMode: 'maintenance', playEnabled: false, maintenanceInProgress: true, lastLifecycleReason: 'manual_maintenance' });
    if (a === 'return') return this.state.setState({ lifecyclePhase: 'play', operationMode: 'running', playEnabled: true, maintenanceInProgress: false, autoReturnAfterMaintenance: false, lastLifecycleReason: 'maintenance_return' });
    if (a === 'unplug') return this.state.setState({ lifecyclePhase: 'unplug', operationMode: 'stopped', playEnabled: false, maintenanceInProgress: false, lastLifecycleReason: 'manual_unplug' });
    throw new Error('Unsupported action');
  }
}
module.exports = Lifecycle;
