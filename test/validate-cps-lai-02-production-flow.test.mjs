import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const flowPath = new URL(
  '../node-red/lai/flows/cps-lai-02-production-validation.json',
  import.meta.url
);
const adapterPath = new URL(
  '../node-red/lai/flows/cps-lai-02-opcua-mqtt.json',
  import.meta.url
);
const flow = JSON.parse(readFileSync(flowPath, 'utf8'));
const adapterSource = readFileSync(adapterPath, 'utf8');
const source = JSON.stringify(flow);
const byId = new Map(flow.map((node) => [node.id, node]));
const tab = byId.get('cpslai2_prodval_tab');

const expectedNodeIds = [
  'ns=3;s="xMProcessBusy"',
  'ns=3;s="xMStartProcess"',
  'ns=3;s="xMontar"',
  'ns=3;s="iStep"',
  'ns=3;s="iStep_seq"',
  'ns=3;s="inBusy"',
  'ns=3;s="G2BG4_A"',
  'ns=3;s="evt_blk"',
];

test('production validation flow imports as an isolated disabled tab', () => {
  assert.equal(tab.type, 'tab');
  assert.equal(tab.label, 'CPS-LAI-02 | Production Tag Validation');
  assert.equal(tab.disabled, true);
  for (const node of flow.filter((entry) => entry.type !== 'tab' && entry.type !== 'OpcUa-Endpoint')) {
    assert.equal(node.z, tab.id, `${node.id} must belong only to the diagnostic tab`);
  }
  assert.doesNotMatch(adapterSource, /cpslai2_prodval_/);
});

test('flow has exactly one read-only OPC UA client and no MQTT or PLC command node', () => {
  const clients = flow.filter((node) => node.type === 'OpcUa-Client');
  assert.equal(clients.length, 1);
  assert.equal(clients[0].action, 'readmultiple');
  assert.equal(clients[0].endpoint, 'cpslai2_prodval_endpoint');
  assert.equal(clients[0].securitymode, 'None');
  assert.equal(clients[0].securitypolicy, 'None');
  assert.equal(flow.some((node) => /mqtt/i.test(node.type)), false);
  assert.equal(flow.some((node) => ['write', 'method', 'call'].includes(String(node.action).toLowerCase())), false);
  assert.doesNotMatch(source, /cpslai2\/(?:data|status|health|oee)/i);
});

test('endpoint and all eight recovered candidate NodeIds are exact', () => {
  const endpoint = byId.get('cpslai2_prodval_endpoint');
  assert.equal(endpoint.endpoint, 'opc.tcp://192.168.1.20:4840');
  assert.equal(endpoint.secpol, 'None');
  assert.equal(endpoint.secmode, 'None');
  const readBuilder = byId.get('cpslai2_prodval_build_read').func;
  for (const nodeId of expectedNodeIds) assert.equal(readBuilder.includes(nodeId), true, nodeId);
  assert.match(source, /CANDIDATE_UNVALIDATED/);
});

test('collection is manual, rate-limited and persists only diagnostic JSONL', () => {
  const tick = byId.get('cpslai2_prodval_tick');
  assert.equal(tick.repeat, '2');
  assert.equal(tick.once, false);
  for (const inject of flow.filter((node) => node.type === 'inject')) assert.equal(inject.once, false);
  const build = byId.get('cpslai2_prodval_build_read');
  assert.match(build.func, /TIMEOUT_MS = 8000/);
  assert.match(build.func, /prodval_inflight/);
  assert.match(build.func, /prodval_collecting', false/);
  const file = byId.get('cpslai2_prodval_file');
  assert.equal(file.filenameType, 'msg');
  assert.equal(file.overwriteFile, 'false');
  assert.equal(file.appendNewline, true);
  assert.match(byId.get('cpslai2_prodval_event_output').func, /CPSLAI2_PRODUCTION_VALIDATION_JSONL/);
});

test('transition processor covers baseline, change, quality, failure and recovery', () => {
  const processor = byId.get('cpslai2_prodval_process_batch').func;
  for (const event of ['FIRST_VALID_READ', 'VALUE_CHANGE', 'QUALITY_CHANGE', 'READ_FAILURE', 'READ_RECOVERY', 'BASELINE_SNAPSHOT']) {
    assert.match(processor, new RegExp(event));
  }
  assert.match(processor, /JSON\.stringify\(prior\.value\) !== JSON\.stringify\(value\)/);
  assert.match(processor, /collectedAt/);
  assert.match(processor, /sourceTimestamp/);
  assert.match(processor, /serverTimestamp/);
  assert.match(processor, /sampleNumber/);
});

test('OPC UA client output 2 status messages do not stop a valid collection', () => {
  const client = byId.get('cpslai2_prodval_opcua_read');
  const classifier = byId.get('cpslai2_prodval_classify_client_output');
  assert.deepEqual(client.wires[1], [classifier.id]);
  assert.deepEqual(classifier.wires[0], ['cpslai2_prodval_failure']);
  assert.deepEqual(classifier.wires[1], ['cpslai2_prodval_status_debug']);

  const run = new Function('msg', 'flow', 'node', 'env', classifier.func);
  assert.deepEqual(
    run({ error: null, status: 'active multiple reading' }, {}, {}, {}),
    [null, { error: null, status: 'active multiple reading' }]
  );
  const realError = { error: 'can\'t work without OPC UA client', status: 'connecting' };
  const routed = run(realError, {}, {}, {});
  assert.equal(routed[0], realError);
  assert.equal(routed[1], null);
});

test('failure handler preserves actionable OPC UA diagnostics', () => {
  const handler = byId.get('cpslai2_prodval_failure');
  assert.doesNotMatch(handler.func, /Unknown OPC UA error/);
  for (const field of ['statusCode', 'stack', 'catchSource', 'endpoint']) {
    assert.match(handler.func, new RegExp(field));
  }
});

test('every node type is available in the installed Node-RED environment and functions parse', () => {
  const coreTypes = new Set(['tab', 'comment', 'inject', 'function', 'debug', 'file', 'status', 'catch']);
  for (const node of flow) {
    if (coreTypes.has(node.type)) continue;
    if (node.type === 'OpcUa-Client') {
      assert.equal(existsSync(new URL('../node-red/lai/node_modules/node-red-contrib-opcua/opcua/102-opcuaclient.js', import.meta.url)), true);
      continue;
    }
    if (node.type === 'OpcUa-Endpoint') {
      assert.equal(existsSync(new URL('../node-red/lai/node_modules/node-red-contrib-opcua/opcua/105-opcuaendpoint.js', import.meta.url)), true);
      continue;
    }
    assert.fail(`Unsupported node type: ${node.type}`);
  }
  for (const node of flow.filter((entry) => entry.type === 'function')) {
    assert.doesNotThrow(() => new Function('msg', 'flow', 'node', 'env', node.func), node.name);
    if (node.initialize) assert.doesNotThrow(() => new Function('flow', node.initialize), `${node.name} initialize`);
    if (node.finalize) assert.doesNotThrow(() => new Function('flow', node.finalize), `${node.name} finalize`);
  }
});
