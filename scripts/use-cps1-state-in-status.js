'use strict';

const fs = require('node:fs');

const file = process.argv[2];
if (!file) throw new Error('Usage: node scripts/use-cps1-state-in-status.js <flows.json>');
const flows = JSON.parse(fs.readFileSync(file, 'utf8'));
const node = flows.find((item) => item.id === 'a7d43a27e67682d8');
if (!node) throw new Error('CPS-1 status function not found');
const old = "const rawState = String(status.state || '').toLowerCase();\nconst operationMode = ['running', 'stopped', 'maintenance'].includes(rawState)\n  ? rawState\n  : rawState === 'unplugged' ? 'stopped' : 'unknown';\nconst lifecyclePhase = aas?.lifecycleIntegration?.CurrentPhase || 'unknown';";
const next = "const cps1RuntimeState = cps1StateAdapter ? cps1StateAdapter.getState(flow) : {};\nconst rawState = String(status.state || cps1RuntimeState.operationMode || '').toLowerCase();\nconst operationMode = ['running', 'stopped', 'maintenance'].includes(rawState)\n  ? rawState\n  : rawState === 'unplugged' ? 'stopped' : 'unknown';\nconst lifecyclePhase = cps1RuntimeState.lifecyclePhase || aas?.lifecycleIntegration?.CurrentPhase || 'unknown';";
if (!node.func.includes(old)) throw new Error('Expected status state block not found');
node.func = node.func.replace(old, next);
node.func = node.func.replace("  state: status.state || 'unknown',", "  state: operationMode,\n  lifecyclePhase,\n  operationMode,");
node.func = node.func.replace("  lifecyclePhase,\n  operationMode,\n  operationMode,", "  lifecyclePhase,\n  operationMode,");
node.func = node.func.replace("  playEnabled: !!status.playEnabled,", "  playEnabled: status.playEnabled !== undefined ? !!status.playEnabled : !!cps1RuntimeState.playEnabled,");
fs.writeFileSync(file, JSON.stringify(flows, null, 4) + '\n');
console.log(JSON.stringify({ id: node.id, changed: true }, null, 2));
