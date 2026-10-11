import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const load = (name) => {
  const nodes = JSON.parse(readFileSync(new URL(`../node-red/lai/flows/${name}`, import.meta.url), 'utf8'));
  return { nodes, byId: new Map(nodes.map((node) => [node.id, node])) };
};
const flows = [
  { cps: 'cpslai2', ...load('cps-lai-02-opcua-mqtt.json'), client: 'cpslai2_opcua_read' },
  { cps: 'cpslai3', ...load('cps-lai-03-opcua-mqtt.json'), client: 'c3a0000000000005' },
];
const execute = (source, msg, state = new Map()) => {
  const flow = { get: (key) => state.get(key), set: (key, value) => state.set(key, value) };
  const node = { warn: () => {}, status: () => {} };
  return { result: new Function('msg', 'flow', 'node', source)(msg, flow, node), state };
};

test('diagnostics reuse each operational OPC UA READ client and contain no WRITE, CALL or MQTT path', () => {
  for (const { cps, nodes, byId, client } of flows) {
    assert.ok(byId.has(client));
    assert.equal(nodes.filter((node) => node.type === 'OpcUa-Client').length, cps === 'cpslai2' ? 2 : 1);
    const diagnosticNodes = nodes.filter((node) => String(node.id).includes('init_diag'));
    assert.equal(diagnosticNodes.some((node) => node.type === 'OpcUa-Client'), false);
    assert.equal(diagnosticNodes.some((node) => node.type === 'mqtt out'), false);
    assert.doesNotMatch(JSON.stringify(diagnosticNodes), /"action":"(?:write|call)"/i);
  }
});

test('manual Start and Stop gate four same-batch READs and preserve an experimental step', () => {
  for (const { cps, byId } of flows) {
    const state = new Map();
    execute(byId.get(`${cps}_init_diag_control`).func, { payload: 'START' }, state);
    execute(byId.get(`${cps}_init_diag_set_step`).func, { payload: 'STATION_INITIALIZING' }, state);
    const { result } = execute(byId.get(`${cps}_init_diag_build`).func, {}, state);
    assert.equal(result[0].length, 4);
    assert.equal(new Set(result[0].map((msg) => msg._initBatchId)).size, 1);
    assert.deepEqual(result[0].map((msg) => msg._initTag), [
      'OperatingMode', 'sys_man', 'sys_sup', 'sys_man2',
    ]);
    assert.ok(result[0].every((msg) => msg.action === 'info' && msg._initDiagnostic === true));
    assert.equal(state.get(`${cps}_init_diag_batch`).testStep, 'STATION_INITIALIZING');
    execute(byId.get(`${cps}_init_diag_control`).func, { payload: 'STOP' }, state);
    assert.deepEqual(execute(byId.get(`${cps}_init_diag_build`).func, {}, state).result, [null, null]);
  }
});

test('incomplete batches expire, record missing tags and allow the next batch', () => {
  for (const { cps, byId } of flows) {
    const state = new Map([[`${cps}_init_diag_enabled`, true], [`${cps}_init_diag_step`, 'PLC_STARTING']]);
    execute(byId.get(`${cps}_init_diag_build`).func, {}, state);
    const active = state.get(`${cps}_init_diag_batch`);
    active.expiresAt = Date.now() - 1;
    active.samples.OperatingMode = { valid: true };
    const { result } = execute(byId.get(`${cps}_init_diag_build`).func, {}, state);
    assert.equal(result[1].payload.complete, false);
    assert.deepEqual(result[1].payload.missingTags, ['sys_man', 'sys_sup', 'sys_man2']);
    assert.equal(result[1].payload.failureReason, 'BATCH_TIMEOUT');
    assert.notEqual(state.get(`${cps}_init_diag_batch`).batchId, active.batchId);
  }
});

test('collector validates server-returned Int32 and Boolean attributes and emits one complete record', () => {
  for (const { cps, byId } of flows) {
    const state = new Map([[`${cps}_init_diag_enabled`, true]]);
    const reads = execute(byId.get(`${cps}_init_diag_build`).func, {}, state).result[0];
    let output = null;
    for (const read of reads) {
      const isMode = read._initTag === 'OperatingMode';
      output = execute(byId.get(`${cps}_init_diag_collect`).func, {
        ...read,
        value: isMode ? 8 : false,
        dataType: isMode ? 'ns=0;i=6' : 'ns=0;i=1',
        statusCode: { name: 'Good' },
        sourceTimestamp: '2026-10-11T10:00:00.000Z',
        serverTimestamp: '2026-10-11T10:00:00.100Z',
      }, state).result;
    }
    assert.equal(output.payload.complete, true);
    assert.equal(output.payload.samples.OperatingMode.datatype, 'Int32');
    assert.equal(output.payload.samples.sys_man.datatype, 'Boolean');
    assert.equal(output.payload.failureReason, null);
    assert.ok(Object.values(output.payload.samples).every((sample) => sample.statusCode === 'Good'));
  }
});

test('collector records datatype, quality and value failures without accepting configured fallbacks', () => {
  for (const { cps, byId } of flows) {
    const state = new Map([[`${cps}_init_diag_enabled`, true]]);
    const reads = execute(byId.get(`${cps}_init_diag_build`).func, {}, state).result[0];
    let output = null;
    for (const read of reads) {
      output = execute(byId.get(`${cps}_init_diag_collect`).func, {
        ...read,
        value: read._initTag === 'OperatingMode' ? 8 : false,
        dataType: read._initTag === 'OperatingMode' ? 'ns=0;i=1' : 'ns=0;i=1',
        statusCode: read._initTag === 'sys_sup' ? { name: 'BadNotConnected' } : { name: 'Good' },
      }, state).result;
    }
    assert.equal(output.payload.failureReason, 'INVALID_SAMPLE');
    assert.equal(output.payload.samples.OperatingMode.failureReason, 'DATATYPE_MISMATCH');
    assert.equal(output.payload.samples.sys_sup.failureReason, 'BAD_STATUS_CODE');
  }
});

test('diagnostic outputs are separate JSONL files and operational mode branches remain present', () => {
  for (const { cps, byId } of flows) {
    const file = byId.get(`${cps}_init_diag_file`);
    assert.equal(file.type, 'file');
    assert.equal(file.filename, `${cps}-init-diagnostic.jsonl`);
  }
  assert.ok(flows[0].byId.has('cpslai2_derive_operation_mode'));
  assert.ok(flows[1].byId.has('c3a000000000000e'));
});
