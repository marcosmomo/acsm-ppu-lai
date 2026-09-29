'use strict';

const fs = require('node:fs');

const file = process.argv[2];
if (!file) throw new Error('Usage: node scripts/fix-cps1-datasheet-path.js <flows.json>');
const flows = JSON.parse(fs.readFileSync(file, 'utf8'));
const node = flows.find((item) => item.id === 'be799afa0d86ef76');
if (!node) throw new Error('CPS-1 datasheet resolver not found');
const expected = /const root = env\.get\('ACSM_PROJECT_ROOT'\) \|\| '[^']+';/;
if (!expected.test(node.func)) throw new Error('Expected legacy datasheet path not found');
node.func = node.func.replace(expected, "const configuredPath = env.get('CPS_DATASHEET_PATH');\nif (configuredPath) { msg.filename = configuredPath; return msg; }\nconst root = env.get('ACSM_PROJECT_ROOT') || 'C:\\\\bkp\\\\estagio doutoral\\\\Implementação ACSM PPU\\\\acsm-main';");
fs.writeFileSync(file, JSON.stringify(flows, null, 4) + '\n');
console.log(JSON.stringify({ id: node.id, changed: true }, null, 2));
