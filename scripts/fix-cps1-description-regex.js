'use strict';

const fs = require('node:fs');

const file = process.argv[2];
if (!file) throw new Error('Usage: node scripts/fix-cps1-description-regex.js <flows.json>');
const flows = JSON.parse(fs.readFileSync(file, 'utf8'));
const node = flows.find((item) => item.id === 'e8184dced0fbd93f');
if (!node) throw new Error('CPS-1 description function not found');
const before = "msg.req?.originalUrl?.replace(/\\\\/description$/, '/datasheet/pdf')";
const after = "msg.req?.originalUrl?.replace(/\\/description$/, '/datasheet/pdf')";
if (!node.func.includes(before)) throw new Error('Expected legacy regex not found');
node.func = node.func.replace(before, after);
fs.writeFileSync(file, JSON.stringify(flows, null, 4) + '\n');
console.log(JSON.stringify({ id: node.id, changed: true }, null, 2));
