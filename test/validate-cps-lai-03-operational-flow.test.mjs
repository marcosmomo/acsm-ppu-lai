import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const flowPath = new URL('../node-red/lai/flows/cps-lai-03-opcua-mqtt.json', import.meta.url);
const nodes = JSON.parse(readFileSync(flowPath, 'utf8'));
const byId = new Map(nodes.map((node) => [node.id, node]));

test('installed OPC UA client info action reads server attributes while read omits datatype output', () => {
  const clientSource = readFileSync(new URL(
    '../node-red/lai/node_modules/node-red-contrib-opcua/opcua/102-opcuaclient.js',
    import.meta.url
  ), 'utf8');
  assert.match(clientSource, /function info_action_input\(msg\)/);
  assert.match(clientSource, /session\.readAllAttributes/);
  assert.match(clientSource, /Object\.assign\(msg, result\)/);
  assert.match(clientSource, /DataType\[dataValue\.value\.dataType\]/);
  assert.doesNotMatch(
    clientSource.slice(clientSource.indexOf('async function read_action_input'), clientSource.indexOf('function readmultiple_action_input')),
    /msg\.(?:dataType|datatype)\s*=\s*dataValue\.value\.dataType/
  );
});

test('flow is disabled and uses exactly one read-only OPC UA metadata client', () => {
  assert.equal(byId.get('c3a0000000000001').disabled, true);
  const clients = nodes.filter((node) => node.type === 'OpcUa-Client');
  assert.equal(clients.length, 1);
  assert.equal(clients[0].action, 'info');
  const serialized = JSON.stringify(nodes).toLowerCase();
  assert.doesNotMatch(serialized, /"action":"(?:write|call)"/);
});

test('read batch contains exactly the three validated NodeIds without configured datatype fallback', () => {
  const builder = byId.get('c3a0000000000004');
  for (const [tag, nodeId] of [
    ['sys_man', 'ns=3;s="sys_man"'],
    ['sys_sup', 'ns=3;s="sys_sup"'],
    ['sys_man2', 'ns=3;s="sys_man2"'],
  ]) {
    assert.match(builder.func, new RegExp(tag));
    assert.ok(
      builder.func.includes(nodeId) || builder.func.includes(nodeId.replaceAll('"', '\\"')),
      `${nodeId} must be present in the read batch`
    );
  }
  assert.equal((builder.func.match(/tag:'sys_/g) || []).length, 3);
  assert.doesNotMatch(builder.func, /dataType|datatype/);
});

test('sample validation requires server DataType attribute, Boolean value and Good quality', () => {
  const normalize = byId.get('c3a0000000000006').func;
  assert.match(normalize, /ns=0;i=1/);
  assert.match(normalize, /OPC_UA_ATTRIBUTE_DATATYPE/);
  assert.match(normalize, /typeof raw === 'boolean'/);
  assert.match(normalize, /Good/);
  assert.match(normalize, /MISSING_DATATYPE_ATTRIBUTE/);
  assert.match(normalize, /INCOMPATIBLE_DATATYPE_ATTRIBUTE/);
  assert.match(normalize, /BAD_OPCUA_QUALITY/);
  assert.match(normalize, /late, unknown or duplicate/);
  assert.doesNotMatch(normalize, /msg\.datatype/);
});

const runNormalizer = (response) => {
  const state = new Map([
    ['cpslai3_mode_tags', {
      'ns=3;s="sys_sup"': { tag: 'sys_sup', nodeId: 'ns=3;s="sys_sup"' },
    }],
    ['cpslai3_mode_read_batch', {
      batchId: 'batch-1', expiresAt: Date.now() + 6000, received: [],
      expected: ['ns=3;s="sys_sup"'],
    }],
  ]);
  const flow = { get: (key) => state.get(key), set: (key, value) => state.set(key, value) };
  const node = { warn: () => {} };
  const execute = new Function('msg', 'flow', 'node', byId.get('c3a0000000000006').func);
  return execute({
    topic: 'ns=3;s="sys_sup"', _nodeId: 'ns=3;s="sys_sup"', _tag: 'sys_sup',
    _batchId: 'batch-1', statusCode: { name: 'Good' }, ...response,
  }, flow, node)?.payload;
};

test('Boolean datatype is proven from supported OPC UA attribute response formats', () => {
  for (const response of [
    { value: true, dataType: 'ns=0;i=1' },
    { value: true, dataType: { namespace: 0, value: 1 } },
    { payload: { attributes: { value: true, dataType: 'Boolean' } } },
    { payload: { value: true, dataTypeNodeId: 'ns=0;i=1' } },
  ]) {
    const sample = runNormalizer(response);
    assert.equal(sample.valid, true);
    assert.equal(sample.dataType, 'Boolean');
    assert.equal(sample.dataTypeEvidence, 'OPC_UA_ATTRIBUTE_DATATYPE');
    assert.equal(sample.value, true);
    assert.ok(Number.isFinite(Date.parse(sample.timestamp)));
    assert.ok(Number.isFinite(Date.parse(sample.collectedAt)));
  }
});

test('missing, incompatible and failed DataType attribute reads remain invalid', () => {
  const missing = runNormalizer({ value: false });
  assert.equal(missing.valid, false);
  assert.equal(missing.invalidReason, 'MISSING_DATATYPE_ATTRIBUTE');
  assert.equal(missing.dataType, null);

  const incompatible = runNormalizer({ value: false, dataType: 'ns=0;i=6' });
  assert.equal(incompatible.valid, false);
  assert.equal(incompatible.invalidReason, 'INCOMPATIBLE_DATATYPE_ATTRIBUTE');

  const failed = runNormalizer({ value: false, statusCode: { name: 'BadAttributeIdInvalid' } });
  assert.equal(failed.valid, false);
  assert.equal(failed.invalidReason, 'MISSING_DATATYPE_ATTRIBUTE');
  assert.equal(failed.statusCode, 'BadAttributeIdInvalid');
});

test('MQTT contract carries evidence, freshness and conservative derivation on cpslai3/data', () => {
  const snapshot = byId.get('c3a000000000000e').func;
  assert.match(snapshot, /STALE_AFTER_MS = 6000/);
  assert.match(snapshot, /snapshotComplete/);
  assert.match(snapshot, /availableTagCount/);
  assert.match(snapshot, /expectedTagCount/);
  assert.match(snapshot, /communication:\{ dataFresh/);
  assert.match(snapshot, /CPS_LAI_03_PHYSICAL_MODE_MARKERS/);
  assert.match(snapshot, /INCOMPATIBLE_MARKER_DATATYPE/);
  assert.match(snapshot, /NON_EXCLUSIVE_MODE_MARKERS/);
  assert.equal(byId.get('c3a000000000000f').topic, 'cpslai3/data');
  assert.equal(byId.get('c3a000000000000f').qos, '1');
});

test('adapter does not publish a physical mode as ACSM internal operationalState', () => {
  const snapshot = byId.get('c3a000000000000e').func;
  assert.doesNotMatch(snapshot, /operationalState\s*:/);
  assert.match(snapshot, /lifecyclePhase/);
  assert.doesNotMatch(snapshot, /NOT_COMPUTED/);
});

test('cpslai3/oee is explicitly NOT_COMPUTED and clears unavailable components', () => {
  const publisher = byId.get('c3a0000000000019');
  assert.equal(publisher.type, 'function');
  assert.deepEqual(publisher.wires[0], ['c3a0000000000011']);
  assert.equal(byId.get('c3a0000000000011').topic, 'cpslai3/oee');
  const execute = new Function('msg', 'flow', publisher.func);
  const result = execute({ payload: JSON.stringify({
    schemaVersion: '1.0', cpsId: 'cpslai3', timestamp: '2026-10-10T12:00:00.000Z',
    oee: { current: 0.8, availability: 0.9, performance: 0.9, quality: 0.99 },
  }) }, { get: () => undefined });
  const payload = JSON.parse(result.payload);
  assert.equal(payload.calculationState, 'NOT_COMPUTED');
  assert.equal(payload.sourceStatus, 'NOT_COMPUTED');
  assert.equal(payload.evidenceStatus, 'INSUFFICIENT_PROCESS_DATA');
  assert.deepEqual(payload.oee, { current: null, availability: null, performance: null, quality: null });
  assert.match(payload.reason, /CPS_LAI_03_SIGNALS_DO_NOT_YET_PROVE_THE_CPS_LAI_01_OEE_INPUT_SEMANTICS/);
  assert.ok(Number.isFinite(Date.parse(payload.timestamp)));
});

test('flow has no CPS-LAI-01/02 topics and no additional MQTT data publisher', () => {
  const mqttOutputs = nodes.filter((node) => node.type === 'mqtt out');
  assert.equal(mqttOutputs.filter((node) => node.topic === 'cpslai3/data').length, 1);
  const serialized = JSON.stringify(nodes);
  assert.doesNotMatch(serialized, /cpslai[12]\/data/);
});
