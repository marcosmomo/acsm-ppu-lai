import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const nodes = JSON.parse(readFileSync(new URL(
  '../node-red/lai/flows/cps-lai-02-opcua-mqtt.json', import.meta.url
), 'utf8'));
const byId = new Map(nodes.map((node) => [node.id, node]));

test('GCT_0 probe reuses the existing READ client and adds no OPC UA or MQTT node', () => {
  const diagnostic = nodes.filter((node) => String(node.id).includes('gct0'));
  assert.equal(diagnostic.some((node) => node.type === 'OpcUa-Client'), false);
  assert.equal(diagnostic.some((node) => node.type === 'mqtt out'), false);
  assert.deepEqual(byId.get('cpslai2_gct0_build_read').wires, [['cpslai2_opcua_read']]);
  assert.deepEqual(byId.get('cpslai2_init_diag_router').wires[2], ['cpslai2_gct0_normalize']);
});

test('manual probe requests only exact GCT_0 through INFO and never WRITE or CALL', () => {
  const builder = byId.get('cpslai2_gct0_build_read');
  const msg = new Function('msg', 'flow', 'node', builder.func)({}, {}, {});
  assert.equal(msg.topic, 'ns=3;s="GCT_0"');
  assert.equal(msg.action, 'info');
  assert.equal(msg._gct0Probe, true);
  assert.doesNotMatch(JSON.stringify(nodes.filter((node) => String(node.id).includes('gct0'))), /"action":"(?:write|call)"/i);
});

test('GCT_0 response is normalized with raw server evidence and no physical interpretation', () => {
  const normalizer = byId.get('cpslai2_gct0_normalize');
  const msg = new Function('msg', 'flow', 'node', normalizer.func)({
    topic: 'ns=3;s="GCT_0"', _gct0NodeId: 'ns=3;s="GCT_0"',
    _gct0RequestedAt: '2026-10-11T10:00:00.000Z', value: true,
    dataType: 'ns=0;i=1', statusCode: { name: 'Good' },
    sourceTimestamp: '2026-10-11T10:00:00.100Z',
    serverTimestamp: '2026-10-11T10:00:00.200Z',
  }, {}, {});
  assert.equal(msg.payload.cpsId, 'cpslai2');
  assert.equal(msg.payload.returnedNodeId, 'ns=3;s="GCT_0"');
  assert.equal(msg.payload.value, true);
  assert.equal(msg.payload.datatype, 'ns=0;i=1');
  assert.equal(msg.payload.statusCode, 'Good');
  assert.equal(msg.payload.goodQuality, true);
  assert.equal(msg.payload.interpretation, 'UNVALIDATED_CANDIDATE_ONLY');
  assert.ok(Number.isFinite(Date.parse(msg.payload.collectedAt)));
});

test('probe terminates only at an independent Debug node and operational batch now contains seven tags', () => {
  assert.equal(byId.get('cpslai2_gct0_debug').type, 'debug');
  assert.deepEqual(byId.get('cpslai2_gct0_normalize').wires, [['cpslai2_gct0_debug']]);
  const operationalBuilder = byId.get('cpslai2_build_read_batch').func;
  assert.match(operationalBuilder, /tags\.length !== 7/);
  assert.match(operationalBuilder, /requireServerDataType/);
  assert.match(byId.get('cpslai2_normalize_sample').func, /PHYSICALLY_VALIDATED_INIT_MARKER/);
});

test('operational normalizer accepts the INFO envelope used by GCT_0', () => {
  const normalizer = byId.get('cpslai2_normalize_sample');
  const nodeId = 'ns=3;s="GCT_0"';
  const batchId = 'cpslai2-read-test';
  const state = new Map([
    ['cpslai2_telemetry_by_nodeid', {
      [nodeId]: { tag: 'GCT_0', nodeId, dataType: 'Boolean', requireServerDataType: true },
    }],
    ['cpslai2_read_batch', {
      batchId,
      expiresAt: Date.now() + 5000,
      expectedNodeIds: [nodeId],
      receivedNodeIds: [],
    }],
  ]);
  const flow = {
    get: (key) => state.get(key),
    set: (key, value) => state.set(key, value),
  };
  const warnings = [];
  new Function('msg', 'flow', 'node', normalizer.func)({
    topic: nodeId,
    _nodeId: nodeId,
    _tag: 'GCT_0',
    _batchId: batchId,
    _readRequestedAt: '2026-10-11T12:00:00.000Z',
    value: true,
    payload: { attributes: { dataType: 'ns=0;i=1' } },
    dataTypeNodeId: 'ns=0;i=1',
    statusCode: { name: 'Good' },
    sourceTimestamp: '2026-10-11T12:00:00.100Z',
    serverTimestamp: '2026-10-11T12:00:00.200Z',
  }, flow, { warn: (message) => warnings.push(message) });

  assert.equal(warnings.length, 0);
  assert.equal(state.get('cpslai2_samples').GCT_0.value, true);
  assert.equal(state.get('cpslai2_samples').GCT_0.dataTypeNodeId, 'ns=0;i=1');
  assert.equal(state.get('cpslai2_samples').GCT_0.semanticMappingStatus, 'PHYSICALLY_VALIDATED_INIT_MARKER');
  assert.equal(state.get('cpslai2_read_batch'), null);
});
