'use strict';

const fs = require('node:fs');
const path = require('node:path');

const runtime = process.argv[2];
const projectRoot = process.argv[3];
if (!runtime || !projectRoot) throw new Error('Usage: node scripts/prepare-cps1-runtime.js <runtime> <projectRoot>');

const flowPath = path.join(runtime, 'flows.json');
const settingsPath = path.join(runtime, 'settings.js');
const source = JSON.parse(fs.readFileSync(flowPath, 'utf8'));
const tabId = '2619f13a318f303f';
const localKeys = [
  'playEnabled', 'maintenanceInProgress', 'autoReturnAfterMaintenance',
  'lastLifecycleReason', 'await_count', 'aas_cps1_model', 'aas_cps1_live',
  'aas_cps1_events', 'cps1_baseline', 'cps1_last_payload_acsm',
  'unplugSent', 'maintenanceStartTs'
];
const helper = "const cps1StateAdapter = global.get('cps1StateAdapter');\nconst cps1Read = (key) => cps1StateAdapter ? cps1StateAdapter.get(flow, key) : flow.get(key);\nconst cps1Write = (key, value) => cps1StateAdapter ? cps1StateAdapter.set(flow, key, value) : flow.set(key, value);\n";
const doubleKey = new RegExp(`flow\\.get\\(\\\"(${localKeys.join('|')})\\\"\\)`, 'g');
const singleKey = new RegExp(`flow\\.get\\(\\\'(${localKeys.join('|')})\\\'\\)`, 'g');
const doubleSet = new RegExp(`flow\\.set\\(\\\"(${localKeys.join('|')})\\\"\\s*,`, 'g');
const singleSet = new RegExp(`flow\\.set\\(\\\'(${localKeys.join('|')})\\\'\\s*,`, 'g');

let modifiedFunctions = [];
for (const node of source) {
  if (node.z !== tabId || node.type !== 'function' || typeof node.func !== 'string') continue;
  const touchesLocal = localKeys.some((key) => node.func.includes(`flow.get("${key}")`) || node.func.includes(`flow.get('${key}')`) || node.func.includes(`flow.set("${key}"`) || node.func.includes(`flow.set('${key}'`));
  if (!touchesLocal) continue;
  let next = node.func.replace(doubleKey, 'cps1Read("$1")').replace(singleKey, "cps1Read('$1')");
  next = next.replace(doubleSet, 'cps1Write("$1",').replace(singleSet, "cps1Write('$1',");
  if (next !== node.func && !next.includes('const cps1StateAdapter =')) {
    node.func = helper + next;
    modifiedFunctions.push(node.id);
  }
}

const serial = source.find((node) => node.id === '220681ea7853f9fd');

const pathReplacements = [
  ['const baseDir = "C:\\\\node-red-data\\\\logs";', 'const baseDir = env.get("CPS_LOG_DIR") || "C:\\\\cps1-logs";'],
  ["const logsDir = 'C:\\\\node-red-data\\\\logs';", "const logsDir = env.get('CPS_LOG_DIR') || 'C:\\\\cps1-logs';"],
  ["const pdfDir = 'C:\\\\cps1-logs';", "const pdfDir = env.get('CPS_LOG_DIR') || 'C:\\\\cps1-logs';"],
  ["msg.filename = 'C:\\\\cps1-logs\\\\cps1-events.jsonl';", "msg.filename = env.get('CPS_EVENTS_PATH') || ((env.get('CPS_LOG_DIR') || 'C:\\\\cps1-logs') + '\\\\cps1-events.jsonl');"]
];
for (const node of source) {
  if (node.z !== tabId || typeof node.func !== 'string') continue;
  for (const [from, to] of pathReplacements) node.func = node.func.split(from).join(to);
}

fs.writeFileSync(flowPath, JSON.stringify(source, null, 4) + '\n');

let settings = fs.readFileSync(settingsPath, 'utf8');
const contextLine = `        cps1StateAdapter: require(${JSON.stringify(path.join(projectRoot, 'config', 'cps1-state-adapter.js'))}),`;
if (!settings.includes('cps1StateAdapter:')) {
  settings = settings.replace('    functionGlobalContext: {\n', `    functionGlobalContext: {\n${contextLine}\n`);
  fs.writeFileSync(settingsPath, settings);
}

console.log(JSON.stringify({ flowPath, settingsPath, modifiedFunctions, serialNode: serial?.id || null, serialPort: serial?.serialport || null }, null, 2));
