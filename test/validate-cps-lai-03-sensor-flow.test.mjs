import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const flowPath = new URL('../node-red/lai/flows/cps-lai-03-sensor-validation.json', import.meta.url);
const flow = JSON.parse(readFileSync(flowPath, 'utf8'));
const source = JSON.stringify(flow);
const byId = new Map(flow.map((node) => [node.id, node]));
const tab = byId.get('cpslai3_sensorval_tab');

test('CPS-LAI-03 sensor flow is isolated, importable and disabled by default', () => {
  assert.equal(tab.type, 'tab');
  assert.equal(tab.label, 'CPS-LAI-03 | Sensor Validation');
  assert.equal(tab.disabled, true);
  for (const node of flow.filter((entry) => entry.type !== 'tab' && entry.type !== 'OpcUa-Endpoint')) {
    assert.equal(node.z, tab.id);
  }
});

test('uses one READ-only OPC UA client and the exact candidate endpoint and NodeIds', () => {
  const clients = flow.filter((node) => node.type === 'OpcUa-Client');
  assert.equal(clients.length, 1);
  assert.equal(clients[0].action, 'read');
  assert.equal(clients[0].endpoint, 'cpslai3_sensorval_endpoint');
  assert.equal(clients[0].securitymode, 'None');
  assert.equal(clients[0].securitypolicy, 'None');
  assert.equal(byId.get('cpslai3_sensorval_endpoint').endpoint, 'opc.tcp://192.168.1.30:4840');
  const buildReads = byId.get('cpslai3_sensorval_build_reads').func;
  const candidates = [
    ['G1MB1', 'ns=3;s="G1MB1"'],
    ['G1MB2', 'ns=3;s="G1MB2"'],
    ['G1BG3', 'ns=3;s="G1BG3"'],
    ['B1BG1', 'ns=3;s="B1BG1"'],
    ['sys_man', 'ns=3;s="sys_man"'],
    ['sys_sup', 'ns=3;s="sys_sup"'],
    ['sys_man2', 'ns=3;s="sys_man2"'],
    ['GoodPieceCount', 'ns=3;s="GoodPieceCount"'],
    ['RejectedPieceCount', 'ns=3;s="RejectedPieceCount"'],
    ['TotalPieceCount', 'ns=3;s="TotalPieceCount"'],
    ['ProcessingTimeMs', 'ns=3;s="ProcessingTimeMs"'],
  ];
  assert.equal((buildReads.match(/\{ tag:/g) || []).length, 11);
  for (const [tag, nodeId] of candidates) {
    assert.equal(buildReads.includes(`tag:'${tag}'`), true);
    assert.equal(buildReads.includes(`nodeId:'${nodeId.replaceAll('"', '\\"')}'`), true);
  }
  assert.equal(flow.some((node) => /mqtt/i.test(node.type)), false);
  assert.equal(flow.some((node) => ['write', 'call', 'method'].includes(String(node.action).toLowerCase())), false);
  assert.doesNotMatch(source, /\/(?:cmd|status|health|oee|data)\b/i);
});

test('collection requires manual Start and reads conservatively every two seconds', () => {
  const tick = byId.get('cpslai3_sensorval_tick');
  assert.equal(tick.repeat, '2');
  assert.equal(tick.once, false);
  for (const inject of flow.filter((node) => node.type === 'inject')) assert.equal(inject.once, false);
  assert.match(byId.get('cpslai3_sensorval_build_reads').func, /sensorval_enabled/);
  assert.match(byId.get('cpslai3_sensorval_build_reads').func, /ROUND_TIMEOUT_MS = 22000/);
  assert.match(byId.get('cpslai3_sensorval_build_reads').func, /flow\.set\('cpslai3_sensorval_round', null\)/);
  assert.match(byId.get('cpslai3_sensorval_build_reads').func, /READ_TIMEOUT/);
});

test('cross-CPS mode names remain untyped, uninterpreted hypotheses', () => {
  const buildReads = byId.get('cpslai3_sensorval_build_reads').func;
  const normalize = byId.get('cpslai3_sensorval_normalize').func;
  const formatter = byId.get('cpslai3_sensorval_log_reading').func;
  assert.equal((buildReads.match(/candidateBasis:'CROSS_CPS_NAME_HYPOTHESIS'/g) || []).length, 3);
  assert.doesNotMatch(buildReads, /dataType\s*:/);
  assert.doesNotMatch(buildReads, /datatype\s*:/);
  assert.match(normalize, /candidateBasis/);
  assert.match(normalize, /CANDIDATE_UNVALIDATED/);
  assert.match(formatter, /candidateBasis/);
  assert.doesNotMatch(normalize, /operationMode|MANUAL|AUTOMATIC|STEP_BY_STEP/);
});

test('AAS field-name candidates remain explicitly unvalidated and preserve requested/response NodeIds', () => {
  const buildReads = byId.get('cpslai3_sensorval_build_reads').func;
  const normalize = byId.get('cpslai3_sensorval_normalize').func;
  const classifier = byId.get('cpslai3_sensorval_classify_client').func;
  const formatter = byId.get('cpslai3_sensorval_log_reading').func;
  assert.equal((buildReads.match(/candidateBasis:'AAS_FIELD_NAME_HYPOTHESIS'/g) || []).length, 4);
  assert.match(buildReads, /GoodPieceCount/);
  assert.match(buildReads, /RejectedPieceCount/);
  assert.match(buildReads, /TotalPieceCount/);
  assert.match(buildReads, /ProcessingTimeMs/);
  assert.match(normalize, /requestedNodeId/);
  assert.match(normalize, /returnedNodeId/);
  assert.match(classifier, /returnedNodeId = null/);
  assert.match(formatter, /requestedNodeId/);
  assert.match(formatter, /returnedNodeId/);
  assert.match(formatter, /candidateBasis/);
  assert.match(formatter, /CANDIDATE_UNVALIDATED/);
  assert.match(formatter, /readStatus/);
});

test('diagnostics preserve raw evidence and distinguish valid reads from failures', () => {
  const normalize = byId.get('cpslai3_sensorval_normalize').func;
  for (const field of ['cpsId', 'tag', 'nodeId', 'value', 'dataType', 'statusCode', 'quality', 'sourceTimestamp', 'serverTimestamp', 'collectedAt', 'error']) {
    assert.match(normalize, new RegExp(field));
  }
  assert.doesNotMatch(normalize, /Boolean\s*\(/);
  assert.match(source, /BadNodeIdUnknown/);
  assert.match(source, /BadAttributeIdInvalid/);
  assert.match(source, /CANDIDATE_UNVALIDATED/);
});

test('successful and failed reads share one append-only deduplicated JSONL path', () => {
  const formatter = byId.get('cpslai3_sensorval_log_reading');
  const file = byId.get('cpslai3_sensorval_readings_file');
  assert.match(formatter.func, /sensorval_enabled/);
  assert.match(formatter.func, /readStatus/);
  assert.match(formatter.func, /sensorval_logged_events/);
  assert.equal(file.filename, 'C:\\bkp\\estagio doutoral\\Implementação ACSM PPU\\ACSM-PPU-LAI\\node-red\\lai\\logs\\cps-lai-03\\opcua-readings.jsonl');
  assert.equal(file.overwriteFile, 'false');
  assert.equal(file.appendNewline, true);
  assert.equal(file.createDir, true);
  assert.deepEqual(byId.get('cpslai3_sensorval_normalize').wires[0], [
    'cpslai3_sensorval_valid_debug',
    formatter.id,
  ]);
  assert.deepEqual(byId.get('cpslai3_sensorval_normalize').wires[1], [
    'cpslai3_sensorval_failure_debug',
    formatter.id,
  ]);
});

test('physical validation log requires an explicit supervised observation', () => {
  const prepare = byId.get('cpslai3_sensorval_prepare_validation');
  const file = byId.get('cpslai3_sensorval_validation_file');
  assert.match(prepare.func, /EXPLICIT_TAG_OBSERVATION_AND_OPERATOR_REQUIRED/);
  assert.match(prepare.func, /SUPERVISED_OBSERVATION_RECORDED/);
  assert.equal(file.filename.endsWith('node-red\\lai\\logs\\cps-lai-03\\sensor-validation.jsonl'), true);
  assert.equal(file.overwriteFile, 'false');
  assert.equal(file.appendNewline, true);
});

test('all used node types exist and function source parses', () => {
  const coreTypes = new Set(['tab', 'comment', 'inject', 'function', 'debug', 'status', 'catch', 'file']);
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
