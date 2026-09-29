'use strict';

const fs = require('node:fs');

const file = process.argv[2];
if (!file) throw new Error('Usage: node scripts/adapt-all-cps1-flow-access.js <flows.json>');
const flows = JSON.parse(fs.readFileSync(file, 'utf8'));
const tabId = '2619f13a318f303f';
const helper = "const cps1StateAdapter = global.get('cps1StateAdapter');\nconst cps1Read = (key) => cps1StateAdapter ? cps1StateAdapter.get(flow, key) : flow.get(key);\nconst cps1Write = (key, value) => cps1StateAdapter ? cps1StateAdapter.set(flow, key, value) : flow.set(key, value);\n";
const changed = [];
for (const node of flows) {
  if (node.z !== tabId || node.type !== 'function' || typeof node.func !== 'string') continue;
  let body = node.func;
  if (body.startsWith("const cps1StateAdapter = global.get('cps1StateAdapter');")) body = body.split('\n').slice(3).join('\n');
  if (!body.includes('flow.get(') && !body.includes('flow.set(')) continue;
  body = body.replace(/flow\.get\(/g, 'cps1Read(').replace(/flow\.set\(/g, 'cps1Write(');
  node.func = helper + body;
  changed.push(node.id);
}
fs.writeFileSync(file, JSON.stringify(flows, null, 4) + '\n');
console.log(JSON.stringify({ changed }, null, 2));
