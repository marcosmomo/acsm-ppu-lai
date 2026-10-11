import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const nodes = JSON.parse(readFileSync(new URL(
  '../node-red/lai/flows/cps-lai-03-opcua-mqtt.json', import.meta.url
), 'utf8'));
const byId = new Map(nodes.map((node) => [node.id, node]));

test('CPS-LAI-03 GCT_0 probe reuses the only existing OPC UA client', () => {
  const clients = nodes.filter((node) => node.type === 'OpcUa-Client');
  const diagnostic = nodes.filter((node) => String(node.id).includes('gct0'));
  assert.equal(clients.length, 1);
  assert.equal(clients[0].id, 'c3a0000000000005');
  assert.equal(byId.get(clients[0].endpoint).endpoint, 'opc.tcp://192.168.1.30:4840');
  assert.equal(diagnostic.some((node) => node.type === 'OpcUa-Client'), false);
  assert.equal(diagnostic.some((node) => node.type === 'mqtt out'), false);
  assert.deepEqual(byId.get('cpslai3_gct0_build_read').wires, [['c3a0000000000005']]);
});

test('manual CPS-LAI-03 probe requests only the exact GCT_0 NodeId through INFO', () => {
  const builder = byId.get('cpslai3_gct0_build_read');
  const msg = new Function('msg', 'flow', 'node', builder.func)({}, {}, {});
  assert.equal(msg.topic, 'ns=3;s="GCT_0"');
  assert.equal(msg.action, 'info');
  assert.equal(msg._gct0Probe, true);
  assert.doesNotMatch(JSON.stringify(nodes.filter((node) => String(node.id).includes('gct0'))), /"action":"(?:write|call)"/i);
});

test('CPS-LAI-03 GCT_0 response carries normalized server evidence without INIT interpretation', () => {
  const normalizer = byId.get('cpslai3_gct0_normalize');
  const msg = new Function('msg', 'flow', 'node', normalizer.func)({
    topic: 'ns=3;s="GCT_0"', _gct0NodeId: 'ns=3;s="GCT_0"',
    _gct0RequestedAt: '2026-10-11T10:00:00.000Z', value: true,
    dataType: 'ns=0;i=1', statusCode: { name: 'Good' },
    sourceTimestamp: '2026-10-11T10:00:00.100Z',
    serverTimestamp: '2026-10-11T10:00:00.200Z',
  }, {}, {});
  assert.deepEqual(Object.keys(msg.payload), [
    'schemaVersion', 'recordType', 'cpsId', 'requestedNodeId', 'returnedNodeId',
    'nodeIdMatches', 'value', 'datatype', 'statusCode', 'goodQuality',
    'requestedAt', 'collectedAt', 'sourceTimestamp', 'serverTimestamp', 'interpretation',
  ]);
  assert.equal(msg.payload.cpsId, 'cpslai3');
  assert.equal(msg.payload.returnedNodeId, 'ns=3;s="GCT_0"');
  assert.equal(msg.payload.nodeIdMatches, true);
  assert.equal(msg.payload.value, true);
  assert.equal(msg.payload.datatype, 'ns=0;i=1');
  assert.equal(msg.payload.statusCode, 'Good');
  assert.equal(msg.payload.goodQuality, true);
  assert.equal(msg.payload.interpretation, 'UNVALIDATED_CANDIDATE_ONLY');
  assert.ok(Number.isFinite(Date.parse(msg.payload.collectedAt)));
});

test('manual B1BG1 probe uses the existing INFO client and normalized Debug path only', () => {
  const inject = byId.get('cpslai3_b1bg1_manual_read');
  assert.equal(inject.type, 'inject');
  assert.equal(inject.once, false);
  assert.equal(inject.repeat, '');
  assert.deepEqual(inject.wires, [['cpslai3_gct0_build_read']]);

  const builder = byId.get('cpslai3_gct0_build_read');
  const request = new Function('msg', 'flow', 'node', builder.func)(
    { _manualProbeTag: 'B1BG1' }, {}, {}
  );
  assert.equal(request.topic, 'ns=3;s="B1BG1"');
  assert.equal(request.action, 'info');
  assert.equal(request._gct0Probe, true);
  assert.equal(request._manualProbeTag, 'B1BG1');
  assert.deepEqual(builder.wires, [['c3a0000000000005']]);

  const router = byId.get('c3a000000000001b');
  const routed = new Function('msg', 'flow', 'node', router.func)(request, {}, {});
  assert.deepEqual(routed, [null, null, null, request, null]);

  const normalizer = byId.get('cpslai3_gct0_normalize');
  const response = new Function('msg', 'flow', 'node', normalizer.func)({
    ...request,
    topic: 'ns=3;s="B1BG1"',
    value: true,
    dataType: 'ns=0;i=1',
    statusCode: { name: 'Good' },
    sourceTimestamp: '2026-10-11T10:00:00.100Z',
    serverTimestamp: '2026-10-11T10:00:00.200Z',
  }, {}, {});

  assert.equal(response.payload.cpsId, 'cpslai3');
  assert.equal(response.payload.requestedNodeId, 'ns=3;s="B1BG1"');
  assert.equal(response.payload.returnedNodeId, 'ns=3;s="B1BG1"');
  assert.equal(response.payload.nodeIdMatches, true);
  assert.equal(response.payload.value, true);
  assert.equal(response.payload.datatype, 'ns=0;i=1');
  assert.equal(response.payload.statusCode, 'Good');
  assert.equal(response.payload.goodQuality, true);
  assert.equal(response.payload.interpretation, 'UNVALIDATED_CANDIDATE_ONLY');
  for (const field of ['requestedAt', 'collectedAt', 'sourceTimestamp', 'serverTimestamp']) {
    assert.ok(Number.isFinite(Date.parse(response.payload[field])), `${field} should be an ISO timestamp`);
  }

  assert.equal(normalizer.wires[0][0], 'cpslai3_gct0_debug');
  assert.equal(nodes.filter((node) => node.type === 'OpcUa-Client').length, 1);
  assert.equal(nodes.some((node) => node.id.includes('b1bg1') && node.type === 'mqtt out'), false);
  assert.doesNotMatch(JSON.stringify([inject, builder, normalizer]), /"action":"(?:write|call)"/i);
});

test('CPS-LAI-03 probe is manual, routes only to an independent Debug and preserves operational functions', () => {
  const inject = byId.get('cpslai3_gct0_manual_read');
  assert.equal(inject.once, false);
  assert.equal(inject.repeat, '');
  assert.equal(byId.get('cpslai3_gct0_debug').type, 'debug');
  assert.deepEqual(byId.get('c3a000000000001b').wires[3], ['cpslai3_gct0_normalize']);
  assert.deepEqual(byId.get('cpslai3_gct0_normalize').wires, [['cpslai3_gct0_debug']]);
  assert.match(byId.get('c3a0000000000006').func, /PHYSICALLY_VALIDATED_INIT_MARKER/);
});
