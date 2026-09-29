'use strict';

const fs = require('node:fs');
const path = require('node:path');

const runtimeDir = 'C:\\Users\\marco\\.node-red-acsm';
const flowPath = path.join(runtimeDir, 'flows.json');
const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
const backupPath = path.join(runtimeDir, `flows.etapa12-${stamp}.json`);

const flows = JSON.parse(fs.readFileSync(flowPath, 'utf8'));
fs.copyFileSync(flowPath, backupPath);

const disableIds = new Set([
  // CPS-1 local command, lifecycle, simulation and calculations.
  '1d38aa7f281512a5', 'e61dd5edf3689fde', '81bc70ebdc51da5a', 'ccee193ed9eb64f0',
  '50921eb8ac83fc14', '48d1b89997ce80c4', 'fba777c0df507aed', '73722ec20b5176f1',
  '8717ef22c9e0e286', '1071fec7f0f0ae69', 'a7be7d42e7092c4a', '0842a722cf0b7570',
  'b92f85a42b51e8b8', '5d998f19b2967ca9', '335d3ea6e4e50130', '740d87e054899bc5',
  'b80d9c547182e28b', 'b50b665b853f6a87', '026b924eaa8f05e3', '808df23eb5c09f78',
  'a5c8db3a3df608b8', 'c1f5c140e854b472', 'd3e5a8cc8b647277', 'a015b06c2df3c9ba',
  '58ab49cf96df8db7', '5c49e831f7582b8f', '7701a05357d2d093', 'afcd3e4e91d70553',
  'd62bbd99e34f5fd6', 'e28f5b241c755e9c', '168feb79ec136059', 'f02a84795d1acf0a',
  '0c84851e77beb7ec',
  // Direct CPS-1 REST implementations replaced by the proxy below.
  'ed3b7654aefb310d', 'bc9d94dfa1279059', '8db66bb9bc595a52', '873e9a7369516c1d',
  '2030c48f04d62fb9', '67608fc39a345726', 'b79504782bd6772d', 'c1d6721ce41a3d8e',
  '4c8032ba528bbb6a', '7f86f47005f808a9'
]);

for (const node of flows) {
  if (disableIds.has(node.id)) node.d = true;
}

const tab = '2619f13a318f303f';
const makeId = (suffix) => `etapa12_cps1_proxy_${suffix}`;
const existing = new Set(flows.map((node) => node.id));
const add = (node) => {
  const current = flows.find((item) => item.id === node.id);
  if (current) Object.assign(current, node);
  else { flows.push(node); existing.add(node.id); }
};

const jsonIn = makeId('json_in');
const jsonPrepare = makeId('json_prepare');
const jsonRequest = makeId('json_request');
const jsonResponse = makeId('json_response');
add({ id: jsonIn, type: 'http in', z: tab, name: 'CPS-1 REST proxy JSON', url: '/api/cps1/:resource', method: 'get', upload: false, swaggerDoc: '', wires: [[jsonPrepare]] });
add({ id: jsonPrepare, type: 'function', z: tab, name: 'Route CPS-1 REST proxy JSON', func: `const base = (env.get('CPS1_SERVICE_URL') || 'http://localhost:3001').replace(/\\/$/, '');\nconst routes = {\n  '/api/cps1/description': '/api/cps/description',\n  '/api/cps1/status': '/api/cps/status',\n  '/api/cps1/health': '/api/cps/health',\n  '/api/cps1/summary': '/api/cps/summary',\n  '/api/cps1/oee': '/api/cps/oee',\n  '/api/cps1/data': '/api/cps/data',\n  '/api/cps1/interfaces': '/api/cps/interfaces',\n  '/api/cps1/lifecycle': '/api/cps/lifecycle'\n};\nconst target = routes[msg.req?.path];\nif (!target) { msg.statusCode = 404; msg.payload = { error: 'CPS-1 endpoint not found' }; return msg; }\nmsg.method = 'GET';\nmsg.url = base + target;\nreturn msg;`, outputs: 1, noerr: 0, initialize: '', finalize: '', libs: [], wires: [[jsonRequest]] });
add({ id: jsonRequest, type: 'http request', z: tab, name: 'Request CPS-1 REST JSON', method: 'use', ret: 'obj', paytoqs: 'ignore', url: '', tls: '', persist: false, proxy: '', insecureHTTPParser: false, authType: '', senderr: false, headers: [], x: 0, y: 0, wires: [[jsonResponse]] });
add({ id: jsonResponse, type: 'function', z: tab, name: 'Respond CPS-1 REST JSON', func: `const unavailable = !!msg.error || (typeof msg.payload === 'string' && msg.payload.startsWith('RequestError'));\nif (unavailable) { msg.statusCode = 503; msg.payload = { error: 'CPS-1 unavailable' }; } else if (msg.statusCode === undefined) msg.statusCode = 200;\nif (!msg.headers) msg.headers = {};\nmsg.headers['Content-Type'] = msg.headers['content-type'] || msg.headers['Content-Type'] || 'application/json';\nreturn msg;`, outputs: 1, noerr: 0, initialize: '', finalize: '', libs: [], wires: [['274307d31bc7e99c']] });

const pdfIn = makeId('pdf_in');
const pdfPrepare = makeId('pdf_prepare');
const pdfRequest = makeId('pdf_request');
const pdfResponse = makeId('pdf_response');
add({ id: pdfIn, type: 'http in', z: tab, name: 'CPS-1 datasheet proxy', url: '/api/cps1/datasheet/pdf', method: 'get', upload: false, swaggerDoc: '', wires: [[pdfPrepare]] });
add({ id: pdfPrepare, type: 'function', z: tab, name: 'Route CPS-1 datasheet proxy', func: `msg.method = 'GET';\nmsg.url = (env.get('CPS1_SERVICE_URL') || 'http://localhost:3001').replace(/\\/$/, '') + '/api/cps/datasheet/pdf';\nreturn msg;`, outputs: 1, noerr: 0, initialize: '', finalize: '', libs: [], wires: [[pdfRequest]] });
add({ id: pdfRequest, type: 'http request', z: tab, name: 'Request CPS-1 datasheet', method: 'use', ret: 'bin', paytoqs: 'ignore', url: '', tls: '', persist: false, proxy: '', insecureHTTPParser: false, authType: '', senderr: false, headers: [], x: 0, y: 0, wires: [[pdfResponse]] });
add({ id: pdfResponse, type: 'function', z: tab, name: 'Respond CPS-1 datasheet', func: `const unavailable = !!msg.error || (typeof msg.payload === 'string' && msg.payload.startsWith('RequestError'));\nif (unavailable) { msg.statusCode = 503; msg.payload = { error: 'CPS-1 unavailable' }; msg.headers = { 'Content-Type': 'application/json' }; return msg; }\nif (msg.statusCode === undefined) msg.statusCode = 200;\nmsg.headers = { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="cps1-datasheet.pdf"' };\nreturn msg;`, outputs: 1, noerr: 0, initialize: '', finalize: '', libs: [], wires: [['fed36d7e52226885']] });

const cmdIn = makeId('cmd_in');
const cmdPrepare = makeId('cmd_prepare');
const cmdRequest = makeId('cmd_request');
const cmdResponse = makeId('cmd_response');
add({ id: cmdIn, type: 'http in', z: tab, name: 'CPS-1 command proxy', url: '/api/cps1/cmd', method: 'post', upload: false, swaggerDoc: '', wires: [[cmdPrepare]] });
add({ id: cmdPrepare, type: 'function', z: tab, name: 'Route CPS-1 command proxy', func: `msg.method = 'POST';\nmsg.url = (env.get('CPS1_SERVICE_URL') || 'http://localhost:3001').replace(/\\/$/, '') + '/api/cps/command';\nmsg.headers = { 'Content-Type': 'application/json' };\nreturn msg;`, outputs: 1, noerr: 0, initialize: '', finalize: '', libs: [], wires: [[cmdRequest]] });
add({ id: cmdRequest, type: 'http request', z: tab, name: 'Request CPS-1 command', method: 'use', ret: 'obj', paytoqs: 'ignore', url: '', tls: '', persist: false, proxy: '', insecureHTTPParser: false, authType: '', senderr: false, headers: [], x: 0, y: 0, wires: [[cmdResponse]] });
add({ id: cmdResponse, type: 'function', z: tab, name: 'Respond CPS-1 command', func: `const unavailable = !!msg.error || (typeof msg.payload === 'string' && msg.payload.startsWith('RequestError'));\nif (unavailable) { msg.statusCode = 503; msg.payload = { error: 'CPS-1 unavailable' }; } else if (msg.statusCode === undefined) msg.statusCode = 200;\nmsg.headers = { 'Content-Type': 'application/json' };\nreturn msg;`, outputs: 1, noerr: 0, initialize: '', finalize: '', libs: [], wires: [['cb3c5d10d0577da7']] });

fs.writeFileSync(flowPath, JSON.stringify(flows, null, 2) + '\n');
console.log(JSON.stringify({ backupPath, disabled: [...disableIds].filter((id) => flows.some((node) => node.id === id)), added: [jsonIn, pdfIn, cmdIn] }));
