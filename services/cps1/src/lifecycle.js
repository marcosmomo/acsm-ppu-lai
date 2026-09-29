'use strict';

class Lifecycle {
  constructor(state) { this.state = state; }

  command(action) {
    if (action === 'play') {
      return this.state.updateState({ lifecyclePhase: 'play', operationMode: 'running', playEnabled: true, maintenanceInProgress: false, autoReturnAfterMaintenance: false, lastLifecycleReason: 'manual_play' });
    }
    if (action === 'stop') {
      return this.state.updateState({ operationMode: 'stopped', playEnabled: false, lastLifecycleReason: 'manual_stop' });
    }
    if (action === 'maintenance') {
      return this.enterMaintenance('manual_maintenance');
    }
    if (action === 'return') {
      return this.returnToPlay();
    }
    if (action === 'unplug') {
      return this.state.updateState({ lifecyclePhase: 'unplug', operationMode: 'stopped', playEnabled: false, maintenanceInProgress: false, autoReturnAfterMaintenance: false, lastLifecycleReason: 'manual_unplug' });
    }
    throw new Error('Unsupported action');
  }

  enterMaintenance(reason = 'maintenance') {
    return this.state.updateState({ operationMode: 'maintenance', playEnabled: false, maintenanceInProgress: true, lastLifecycleReason: reason });
  }

  returnToPlay() {
    return this.state.updateState({ lifecyclePhase: 'play', operationMode: 'running', playEnabled: true, maintenanceInProgress: false, autoReturnAfterMaintenance: false, lastLifecycleReason: 'maintenance_return' });
  }
}

module.exports = Lifecycle;
