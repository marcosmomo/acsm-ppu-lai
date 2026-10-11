import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flowPath = path.join(root, 'node-red/lai/flows/cps-lai-03-opcua-tag-discovery.json');
const flow = JSON.parse(fs.readFileSync(flowPath, 'utf8'));
const byId = new Map(flow.map(node => [node.id, node]));

test('specialist discovery flow is isolated, disabled, and has no duplicate OPC UA or MQTT client', () => {
  const tab = flow.find(node => node.type === 'tab');
  assert.equal(tab?.label, 'CPS-LAI-03 — OPC UA Tag Discovery');
  assert.equal(tab?.disabled, true);
  assert.equal(flow.filter(node => node.type === 'OpcUa-Client').length, 0);
  assert.equal(flow.filter(node => node.type === 'OpcUa-Browser').length, 0);
  assert.equal(flow.filter(node => node.type.startsWith('mqtt')).length, 0);
  assert.equal(flow.filter(node => ['http request', 'tcp request', 'OpcUa-Item', 'OpcUa-Server'].includes(node.type)).length, 0);
  assert.equal(flow.filter(node => node.type === 'link call').length, 1);
  assert.ok(flow.filter(node => node.type === 'inject').every(node => node.once === false));
  assert.ok(flow.filter(node => node.type === 'inject' && node.repeat !== '').every(node => node.id === 'cpslai3-tag-discovery-tick' && node.repeat === '0.1'));
  assert.ok(flow.filter(node => node.type === 'debug').every(node => node.wires.length === 0));
});

test('local Browse preparation lists only bounded known roots and documents browse safety', () => {
  const builder = flow.find(node => node.name === 'Build non-executable Browse plan');
  assert.ok(builder);
  assert.doesNotThrow(() => new Function(builder.func));
  const msg = new Function('msg', builder.func)({});
  assert.equal(msg.payload.executionStatus, 'PREPARED_ONLY_NOT_EXECUTED');
  assert.equal(msg.payload.clientReuseRequired, 'CPS-LAI-03 OPC UA READ');
  assert.deepEqual(msg.payload.roots.map(root => root.nodeId), [
    'ns=3;s=Inputs', 'ns=3;s=Outputs', 'ns=3;s=Memory', 'ns=3;s=PLC',
    'ns=3;s=DataBlocksGlobal', 'ns=3;s=DataBlocksInstance'
  ]);
  assert.equal(msg.payload.limits.maxDepth, 5);
  assert.equal(msg.payload.limits.maxNodes, 500);
  assert.equal(msg.payload.browseSafety.installedNodeSupportsBrowse, true);
  assert.equal(msg.payload.browseSafety.existingClientBrowseSafeForStructuralNodes, false);
});

test('local monitor preparation carries candidate tags and never claims semantic validation', () => {
  const builder = flow.find(node => node.name === 'Build monitor configuration reference');
  assert.ok(builder);
  assert.doesNotThrow(() => new Function(builder.func));
  const msg = new Function('msg', builder.func)({});
  assert.equal(msg.payload.executionStatus, 'PREPARED_ONLY_NOT_EXECUTED');
  assert.equal(msg.payload.intervalMs, 200);
  assert.equal(msg.payload.maxConcurrentCycles, 1);
  assert.deepEqual(msg.payload.selectedTags.map(tag => tag.tag), ['B1BG1', 'B1BG3', 'G1BG3', 'G1MB1', 'G1MB2', 'G1MB3']);
  assert.deepEqual(msg.payload.selectedTags.map(tag => tag.nodeId), [
    'ns=3;s="B1BG1"', 'ns=3;s="B1BG3"', 'ns=3;s="G1BG3"',
    'ns=3;s="G1MB1"', 'ns=3;s="G1MB2"', 'ns=3;s="G1MB3"'
  ]);
  assert.ok(msg.payload.selectedTags.every(tag => tag.semanticValidationStatus === 'PENDING_SUPERVISED_CONFIRMATION'));
  assert.ok(msg.payload.recordFields.includes('sourceTimestamp'));
  assert.ok(msg.payload.recordFields.includes('semanticValidationStatus'));
  assert.equal(msg.payload.outputFiles.catalog, 'cpslai3-opcua-tag-catalog.json');
  assert.equal(msg.payload.outputFiles.readings, 'cpslai3-opcua-tag-monitor.jsonl');
  assert.equal(msg.payload.outputFiles.transitions, 'cpslai3-opcua-tag-transitions.jsonl');
});

test('all flow node references resolve within the standalone tab', () => {
  for (const node of flow) {
    for (const wireGroup of node.wires || []) {
      for (const targetId of wireGroup) assert.ok(byId.has(targetId), `${node.id} references missing ${targetId}`);
    }
  }
  const linkCall = flow.find(node => node.type === 'link call');
  assert.deepEqual(linkCall.links, ['cpslai3_tag_discovery_in']);
  for (const node of flow.filter(node => node.type === 'function')) assert.doesNotThrow(() => new Function(node.func), node.name);
  assert.ok(flow.filter(node => node.type === 'file').every(node => node.filename === '' && node.filenameType === 'msg' && node.overwriteFile === false && node.appendNewline === true));
});

test('output directory accepts a local absolute drive path and rejects traversal or UNC paths', () => {
  const validate = flow.find(node => node.id === 'cpslai3-tag-discovery-dir-validate');
  const state = new Map();
  const context = { get: key => state.get(key), set: (key, value) => state.set(key, value) };
  const run = value => new Function('msg', 'flow', 'node', validate.func)({ payload: value }, context, { warn() {} });
  assert.equal(run('C:\\Users\\marco\\Downloads').payload.recordType, 'OUTPUT_DIRECTORY_SET');
  assert.equal(context.get('cpslai3_tag_discovery_output_dir'), 'C:\\Users\\marco\\Downloads');
  assert.equal(run('C:\\Users\\..\\Windows'), null);
  assert.equal(run('\\\\server\\share'), null);
});

test('START/STOP are manual gates and tick creates serialized INFO candidates only while enabled', () => {
  const start = flow.find(node => node.id === 'cpslai3-tag-discovery-start');
  const stop = flow.find(node => node.id === 'cpslai3-tag-discovery-stop');
  const tick = flow.find(node => node.id === 'cpslai3-tag-discovery-begin-adaptive-cycle');
  assert.ok(start && stop && tick);
  const state = new Map();
  const context = { get: key => state.get(key), set: (key, value) => state.set(key, value) };
  assert.equal(new Function('msg', 'flow', 'node', start.func)({ payload: 'START' }, context, { warn() {} }), null);
  context.set('cpslai3_tag_discovery_output_dir', 'C:\\Users\\marco\\Downloads');
  const started = new Function('msg', 'flow', 'node', start.func)({ payload: 'START' }, context, { warn() {} });
  assert.equal(started[0].payload.recordType, 'MONITOR_STARTED');
  assert.equal(context.get('cpslai3_tag_discovery_interval_state').activeIntervalMs, 500);
  assert.equal(context.get('cpslai3_tag_discovery_interval_state').targetIntervalMs, 200);
  const request = new Function('msg', 'flow', 'node', tick.func)({ payload: '' }, context, { warn() {} });
  assert.equal(request.action, undefined); // the existing client is configured for INFO
  assert.equal(request._tagDiscovery, true);
  assert.equal(request.topic, 'ns=3;s="B1BG1"');
  assert.equal(context.get('cpslai3_tag_discovery_batch').index, 0);
  const metricsInit = flow.find(node => node.id === 'cpslai3-tag-discovery-cycle-metrics-init');
  const initialized = new Function('msg', 'flow', metricsInit.func)(request, context);
  assert.equal(initialized._tagDiscovery, true);
  context.set('cpslai3_tag_discovery_batch', null);
  const stopped = new Function('msg', 'flow', 'node', stop.func)({ payload: 'STOP' }, context, { warn() {} });
  assert.equal(stopped.payload.recordType, 'MONITOR_STOPPED');
  assert.equal(context.get('cpslai3_tag_discovery_enabled'), false);
  assert.equal(new Function('msg', 'flow', 'node', tick.func)({ payload: '' }, context, { warn() {} }), null);
});

test('adaptive cadence requires 10 stable 500ms cycles and falls back when 200ms cannot be sustained', () => {
  const cadence = flow.find(node => node.id === 'cpslai3-tag-discovery-cadence-record');
  assert.ok(cadence);
  assert.doesNotThrow(() => new Function('msg', 'flow', cadence.func));
  const state = new Map();
  const context = { get: key => state.get(key), set: (key, value) => state.set(key, value) };
  context.set('cpslai3_tag_discovery_interval_state', { targetIntervalMs: 200, activeIntervalMs: 500, phase: 'VALIDATING_500MS', stableCycles: 0, recentCycleDurations: [], totalMissedCycles: 0, totalLostSamples: 0 });
  const runCycle = (duration, valid) => {
    context.set('cpslai3_tag_discovery_cycle_metrics', { batchId: 'cycle', valid: valid ? 5 : 4, invalid: valid ? 0 : 1, durations: [duration], startedAt: Date.now() - duration, scheduledDelayMs: 0, intervalMs: context.get('cpslai3_tag_discovery_interval_state').activeIntervalMs });
    const message = { payload: { recordType: 'OPCUA_TAG_MONITOR_SAMPLE', tag: 'G1MB3', batchId: 'cycle', requestedAt: new Date(Date.now() - duration).toISOString(), valid, experimentId: 'test' } };
    return new Function('msg', 'flow', cadence.func)(message, context);
  };
  for (let i = 0; i < 10; i++) runCycle(100, true);
  assert.equal(context.get('cpslai3_tag_discovery_interval_state').phase, 'TARGET_INTERVAL_ACTIVE');
  assert.equal(context.get('cpslai3_tag_discovery_interval_state').activeIntervalMs, 200);
  runCycle(250, true);
  assert.equal(context.get('cpslai3_tag_discovery_interval_state').phase, 'SAFE_FALLBACK');
  assert.ok(context.get('cpslai3_tag_discovery_interval_state').activeIntervalMs >= 500);
});

test('STOP preserves the in-flight lock and START guard prevents overlap after a quick restart', () => {
  const stop = flow.find(node => node.id === 'cpslai3-tag-discovery-stop');
  const guard = flow.find(node => node.id === 'cpslai3-tag-discovery-start-guard');
  const context = new Map();
  const flowContext = { get: key => context.get(key), set: (key, value) => context.set(key, value) };
  const activeBatch = { batchId: 'pending', startedAt: Date.now(), index: 1, tags: [] };
  context.set('cpslai3_tag_discovery_batch', activeBatch);
  const stopped = new Function('msg', 'flow', stop.func)({ payload: 'STOP' }, flowContext);
  assert.equal(stopped.payload.pendingCycleRetainedForOverlapSafety, true);
  assert.equal(context.get('cpslai3_tag_discovery_batch'), activeBatch);
  const blocked = new Function('msg', 'flow', 'node', guard.func)({ payload: 'START' }, flowContext, { warn() {} });
  assert.equal(blocked, null);
});

test('operational adapter adds only an isolated Link In/return route on the existing OPC UA client', () => {
  const operationalPath = path.join(root, 'node-red/lai/flows/cps-lai-03-opcua-mqtt.json');
  const operational = JSON.parse(fs.readFileSync(operationalPath, 'utf8'));
  const client = operational.find(node => node.type === 'OpcUa-Client');
  const input = operational.find(node => node.id === 'cpslai3_tag_discovery_in');
  const output = operational.find(node => node.id === 'cpslai3_tag_discovery_return');
  const router = operational.find(node => node.id === 'c3a000000000001b');
  assert.equal(operational.filter(node => node.type === 'OpcUa-Client').length, 1);
  assert.equal(client.name, 'CPS-LAI-03 OPC UA READ');
  assert.equal(input.type, 'link in');
  assert.deepEqual(input.wires, [[client.id]]);
  assert.equal(output.type, 'link out');
  assert.equal(output.mode, 'return');
  assert.equal(router.outputs, 5);
  assert.deepEqual(new Function('msg', router.func)({ _tagDiscovery: true }), [null, null, null, null, { _tagDiscovery: true }]);
  assert.deepEqual(router.wires[4], [output.id]);
});

test('collector checks returned NodeId, server datatype, Good quality and freshness; emits samples and only real transitions', () => {
  const collector = flow.find(node => node.id === 'cpslai3-tag-discovery-collect');
  assert.doesNotThrow(() => new Function(collector.func));
  const state = new Map();
  const context = { get: key => state.get(key), set: (key, value) => state.set(key, value) };
  const tag = { tag: 'B1BG1', nodeId: 'ns=3;s="B1BG1"' };
  context.set('cpslai3_tag_discovery_enabled', true);
  context.set('cpslai3_tag_discovery_output_dir', 'C:\\Users\\marco\\Downloads');
  context.set('cpslai3_tag_discovery_batch', { batchId: 'batch-1', startedAt: Date.now(), index: 0, tags: [tag, { tag: 'B1BG3', nodeId: 'ns=3;s="B1BG3"' }] });
  const response = { topic: tag.nodeId, nodeId: tag.nodeId, value: false, dataType: 'ns=0;i=1', statusCode: { name: 'Good' }, _tagDiscoveryBatchId: 'batch-1', _tagDiscoveryIndex: 0, _tagDiscoveryTag: tag.tag, _tagDiscoveryExpectedNodeId: tag.nodeId, _tagDiscoveryRequestedAt: new Date().toISOString() };
  const first = new Function('msg', 'flow', 'node', collector.func)(response, context, { warn() {} });
  const firstRecord = first[1].payload;
  assert.equal(firstRecord.valid, true);
  assert.equal(firstRecord.nodeIdMatches, true);
  assert.equal(firstRecord.semanticValidationStatus, 'PENDING_PHYSICAL_SEMANTIC_VALIDATION');
  assert.equal(firstRecord.changed, false);
  assert.equal(first[1].filename, 'C:\\Users\\marco\\Downloads\\cpslai3-opcua-tag-monitor.jsonl');
  assert.equal(first[2], null);
  assert.equal(first[0]._tagDiscoveryIndex, 1);
  const secondBatch = context.get('cpslai3_tag_discovery_batch');
  secondBatch.index = 0;
  secondBatch.batchId = 'batch-2';
  context.set('cpslai3_tag_discovery_batch', secondBatch);
  const second = new Function('msg', 'flow', 'node', collector.func)({ ...response, _tagDiscoveryBatchId: 'batch-2', value: true }, context, { warn() {} });
  assert.equal(second[1].payload.changeType, 'VALUE_CHANGED');
  assert.equal(second[2].payload.recordType, 'OPCUA_TAG_TRANSITION');
  assert.equal(second[2].filename, 'C:\\Users\\marco\\Downloads\\cpslai3-opcua-tag-transitions.jsonl');
  const badBatch = context.get('cpslai3_tag_discovery_batch');
  badBatch.batchId = 'batch-3';
  context.set('cpslai3_tag_discovery_batch', badBatch);
  const invalid = new Function('msg', 'flow', 'node', collector.func)({ ...response, _tagDiscoveryBatchId: 'batch-3', nodeId: 'ns=3;s="OTHER"', value: true, statusCode: { name: 'BadNodeIdUnknown' } }, context, { warn() {} });
  assert.equal(invalid[1].payload.valid, false);
  assert.equal(invalid[2], null);
});

test('Link Call errors become invalid logged samples and do not wedge the serialized cycle', () => {
  const normalizeError = flow.find(node => node.id === 'cpslai3-tag-discovery-normalize-error');
  const collector = flow.find(node => node.id === 'cpslai3-tag-discovery-collect');
  const state = new Map();
  const context = { get: key => state.get(key), set: (key, value) => state.set(key, value) };
  const nodeId = 'ns=3;s="B1BG1"';
  context.set('cpslai3_tag_discovery_enabled', true);
  context.set('cpslai3_tag_discovery_output_dir', 'C:\\Users\\marco\\Downloads');
  context.set('cpslai3_tag_discovery_batch', { batchId: 'timeout-batch', startedAt: Date.now(), index: 0, tags: [{ tag: 'B1BG1', nodeId }, { tag: 'B1BG3', nodeId: 'ns=3;s="B1BG3"' }] });
  const request = { topic: nodeId, _tagDiscoveryBatchId: 'timeout-batch', _tagDiscoveryIndex: 0, _tagDiscoveryTag: 'B1BG1', _tagDiscoveryExpectedNodeId: nodeId, _tagDiscoveryRequestedAt: new Date().toISOString(), error: { message: 'timeout' } };
  const failedSample = new Function('msg', normalizeError.func)(request);
  const result = new Function('msg', 'flow', 'node', collector.func)(failedSample, context, { warn() {} });
  assert.equal(result[1].payload.valid, false);
  assert.match(result[1].payload.statusCode, /timeout/i);
  assert.equal(result[0]._tagDiscoveryIndex, 1);
});
