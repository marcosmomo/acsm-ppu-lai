'use strict';

const fs = require('node:fs');

const file = process.argv[2];
const settingsFile = process.argv[3];
if (!file || !settingsFile) throw new Error('Usage: node scripts/parameterize-cps1-serial.js <flows.json> <settings.js>');
const flows = JSON.parse(fs.readFileSync(file, 'utf8'));
const node = flows.find((item) => item.id === '220681ea7853f9fd');
if (!node || node.type !== 'serial-port') throw new Error('CPS-1 serial config not found');
if (node.serialport === 'COM3') node.serialport = '${CPS_SERIAL_PORT}';
fs.writeFileSync(file, JSON.stringify(flows, null, 4) + '\n');

let settings = fs.readFileSync(settingsFile, 'utf8');
const marker = "process.env.CPS_SERIAL_PORT = process.env.CPS_SERIAL_PORT || 'COM3';";
if (!settings.includes(marker)) {
  settings = settings.replace('module.exports = {', `${marker}\n\nmodule.exports = {`);
  fs.writeFileSync(settingsFile, settings);
}
console.log(JSON.stringify({ serialNode: node.id, serialPort: node.serialport, default: 'COM3' }, null, 2));
