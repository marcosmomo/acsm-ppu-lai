'use strict';

const fs = require('node:fs');

const file = process.argv[2];
if (!file) throw new Error('Usage: node scripts/refine-cps1-status-contract.js <flows.json>');
const flows = JSON.parse(fs.readFileSync(file, 'utf8'));
const node = flows.find((item) => item.id === 'a7d43a27e67682d8');
if (!node) throw new Error('CPS-1 status function not found');
const marker = "const feature = live.feature || {};";
if (!node.func.includes(marker) || node.func.includes('const lifecyclePhase =')) throw new Error('Unexpected CPS-1 status function shape');
node.func = node.func.replace(marker, `${marker}\nconst rawState = String(status.state || '').toLowerCase();\nconst operationMode = ['running', 'stopped', 'maintenance'].includes(rawState)\n  ? rawState\n  : rawState === 'unplugged' ? 'stopped' : 'unknown';\nconst lifecyclePhase = aas?.lifecycleIntegration?.CurrentPhase || 'unknown';`);
node.func = node.func.replace("  state: status.state || 'unknown',", "  state: status.state || 'unknown',\n  lifecyclePhase,\n  operationMode,");
fs.writeFileSync(file, JSON.stringify(flows, null, 4) + '\n');
console.log(JSON.stringify({ id: node.id, changed: true }, null, 2));
