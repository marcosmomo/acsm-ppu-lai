'use strict';

const fs = require('node:fs');

const file = process.argv[2];
const settingsFile = process.argv[3];
if (!file || !settingsFile) throw new Error('Usage: node scripts/normalize-cps1-runtime-state.js <flows.json> <settings.js>');
const flows = JSON.parse(fs.readFileSync(file, 'utf8'));
const find = (id) => {
  const node = flows.find((item) => item.id === id);
  if (!node) throw new Error(`Node not found: ${id}`);
  return node;
};

const stateNode = find('a7d43a27e67682d8');
const statusGate = "const rawState = String(status.state || '').toLowerCase();";
if (!stateNode.func.includes(statusGate)) throw new Error('Unexpected status function shape');

const stateFunctionIds = ['81bc70ebdc51da5a', '5bc7c9bd27623747'];
for (const id of stateFunctionIds) {
  const node = find(id);
  const old = 'const playEnabled = cps1Read("playEnabled") === true;';
  if (!node.func.includes(old)) throw new Error(`Expected play gate not found in ${id}`);
  const replacement = "const cps1RuntimeState = cps1StateAdapter ? cps1StateAdapter.getState(flow) : {};\nconst playEnabled = cps1RuntimeState.lifecyclePhase === 'play' && cps1RuntimeState.operationMode === 'running' && cps1RuntimeState.playEnabled === true;";
  node.func = node.func.replace(old, replacement);
}

const control = find('fba777c0df507aed');
const playMarker = '    cps1Write("lastLifecycleReason", "manual_play");';
const stopMarker = '    cps1Write("lastLifecycleReason", "manual_stop");';
const unplugMarker = '    cps1Write("playEnabled", false);';
if (!control.func.includes(playMarker) || !control.func.includes(stopMarker)) throw new Error('Unexpected control function shape');
control.func = control.func.replace(playMarker, `${playMarker}\n    cps1StateAdapter.updateState(flow, { lifecyclePhase: "play", operationMode: "running" });`);
control.func = control.func.replace(stopMarker, `${stopMarker}\n    cps1StateAdapter.updateState(flow, { operationMode: "stopped" });`);
const unplugIndex = control.func.indexOf(unplugMarker, control.func.indexOf('// UNPLUG'));
if (unplugIndex < 0) throw new Error('Unplug marker not found');
control.func = control.func.slice(0, unplugIndex + unplugMarker.length) + '\n    cps1StateAdapter.updateState(flow, { lifecyclePhase: "unplug", operationMode: "stopped" });' + control.func.slice(unplugIndex + unplugMarker.length);

const serialIn = find('818ebeae744d8887');
serialIn.d = true;

let settings = fs.readFileSync(settingsFile, 'utf8');
settings = settings.replace(/process\.env\.CPS_SERIAL_PORT = process\.env\.CPS_SERIAL_PORT \|\| 'COM3';\r?\n\r?\n/g, '');
fs.writeFileSync(file, JSON.stringify(flows, null, 4) + '\n');
fs.writeFileSync(settingsFile, settings);
console.log(JSON.stringify({ stateFunctions: stateFunctionIds, control: control.id, serialNodeDisabled: serialIn.id }, null, 2));
