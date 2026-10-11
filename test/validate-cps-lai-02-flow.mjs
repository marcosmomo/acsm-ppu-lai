import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const FLOW_PATH = new URL('../node-red/lai/flows/cps-lai-02-opcua-mqtt.json', import.meta.url);
const CATALOG_PATH = new URL('../node-red/lai/flows/cps-lai-02-validation-tags.json', import.meta.url);
const AAS_PATH = new URL('../cps-defs/cps-lai-02-aas-acsm-compatible-revised.json', import.meta.url);
const EXPECTED = new Map([
  ['sys_man', 'ns=3;s="sys_man"'],
  ['sys_man2', 'ns=3;s="sys_man2"'],
  ['sys_sup', 'ns=3;s="sys_sup"'],
  ['sys_menu', 'ns=3;s="sys_menu"'],
  ['man_step_0', 'ns=3;s="man_step_0"'],
  ['man_step_1', 'ns=3;s="man_step_1"'],
]);

const [flow, catalog, aas] = await Promise.all([
  readFile(FLOW_PATH, 'utf8').then(JSON.parse),
  readFile(CATALOG_PATH, 'utf8').then(JSON.parse),
  readFile(AAS_PATH, 'utf8').then(JSON.parse),
]);

assert.ok(Array.isArray(flow), 'Node-RED flow must be an array');
const ids = new Set();
for (const node of flow) {
  assert.ok(node.id, 'Every node must have an id');
  assert.ok(!ids.has(node.id), `Duplicate node id: ${node.id}`);
  ids.add(node.id);
}
for (const node of flow) {
  for (const group of node.wires || []) {
    for (const target of group || []) assert.ok(ids.has(target), `Missing wire target: ${node.id} -> ${target}`);
  }
}

const tabs = flow.filter((node) => node.type === 'tab');
assert.equal(tabs.length, 1, 'CPS-LAI-02 integration must have exactly one independent tab');
assert.equal(tabs[0].disabled, true, 'CPS-LAI-02 tab must be disabled by default');

const opcuaClients = flow.filter((node) => node.type === 'OpcUa-Client');
assert.equal(opcuaClients.length, 2, 'One subscribe client and one periodic read client are expected');
assert.deepEqual(opcuaClients.map((node) => node.action).sort(), ['read', 'subscribe']);
assert.equal(flow.some((node) => /write/i.test(String(node.action || '')) || /OpcUa-Write/i.test(node.type)), false, 'OPC UA writes are forbidden');
const endpoint = flow.find((node) => node.type === 'OpcUa-Endpoint');
assert.equal(endpoint?.endpoint, 'opc.tcp://192.168.1.20:4840');

const mqttOutputs = flow.filter((node) => node.type === 'mqtt out');
assert.equal(mqttOutputs.length, 1, 'Only one MQTT output is allowed in the first integration');
const mqttTopics = new Set(mqttOutputs.map((node) => node.topic).filter(Boolean));
const functionText = flow.filter((node) => node.type === 'function').map((node) => node.func || '').join('\n');
assert.match(functionText, /cpslai2\/data/, 'cpslai2/data contract is required');
assert.deepEqual([...mqttTopics], [], 'MQTT topic must be supplied by the validated normalizer');
const broker = flow.find((node) => node.type === 'mqtt-broker');
assert.equal(broker?.broker, 'localhost');
assert.equal(broker?.port, '1883');
for (const forbidden of ['cpslai2/status', 'cpslai2/oee', 'cpslai2/health', 'acsm/cpslai2/lifecycle']) {
  assert.equal(JSON.stringify(flow).includes(forbidden), false, `Forbidden first-integration contract found: ${forbidden}`);
}

assert.equal(catalog.accessMode, 'READ_ONLY');
const catalogByTag = new Map(catalog.tags.map((entry) => [entry.tag, entry]));
for (const [tag, nodeId] of EXPECTED) {
  const entry = catalogByTag.get(tag);
  assert.ok(entry, `Missing catalog entry: ${tag}`);
  assert.equal(entry.nodeId, nodeId, `Unexpected NodeId for ${tag}`);
  assert.equal(entry.dataType, 'Boolean', `Unexpected datatype for ${tag}`);
  const expectedSemanticStatus = ['sys_man', 'sys_man2', 'sys_sup'].includes(tag)
    ? 'PHYSICALLY_VALIDATED_MODE_MARKER'
    : 'PRELIMINARY_UNVALIDATED';
  assert.equal(entry.semanticMappingStatus, expectedSemanticStatus);
  assert.match(functionText, new RegExp(nodeId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `Flow does not subscribe ${nodeId}`);
}

for (const required of ['nodeId', 'statusCode', 'quality', 'sourceTimestamp', 'serverTimestamp', 'collectedAt', 'semanticMappingStatus']) {
  assert.match(functionText, new RegExp(required), `Telemetry contract is missing ${required}`);
}

const normalizer = flow.find((node) => node.id === 'cpslai2_normalize_sample');
const tick = flow.find((node) => node.id === 'cpslai2_snapshot_tick');
const readTick = flow.find((node) => node.id === 'cpslai2_read_tick');
const readBatchBuilder = flow.find((node) => node.id === 'cpslai2_build_read_batch');
const readClient = flow.find((node) => node.id === 'cpslai2_opcua_read');
const snapshotBuilder = flow.find((node) => node.id === 'cpslai2_build_snapshot');
const modeDeriver = flow.find((node) => node.id === 'cpslai2_derive_operation_mode');
const mqttOutput = flow.find((node) => node.id === 'cpslai2_data_out');
assert.ok(normalizer && tick && readTick && readBatchBuilder && readClient && snapshotBuilder && modeDeriver && mqttOutput, 'Read/cache/derive/snapshot pipeline is incomplete');
assert.equal(tick.repeat, '1', 'Snapshot clock must run every second');
assert.equal(readTick.repeat, '2', 'Real OPC UA reads must run every two seconds');
assert.equal(readClient.action, 'read');
assert.equal(readClient.endpoint, 'cpslai2_opcua_endpoint');
assert.deepEqual(normalizer.wires, [[]], 'Normalizer must not publish individual MQTT messages');
assert.deepEqual(readTick.wires, [[readBatchBuilder.id]]);
assert.deepEqual(readBatchBuilder.wires, [[readClient.id]]);
assert.deepEqual(readClient.wires[0], [normalizer.id]);
assert.deepEqual(tick.wires, [[snapshotBuilder.id]], 'Periodic clock must only invoke the snapshot builder');
assert.deepEqual(snapshotBuilder.wires, [[modeDeriver.id]]);
assert.deepEqual(modeDeriver.wires, [[mqttOutput.id]], 'Derived mode must preserve the single cpslai2/data publisher');
assert.match(normalizer.func, /flow\.set\('cpslai2_samples'/, 'Samples must use a CPS-LAI-02-specific cache');
assert.match(snapshotBuilder.func, /publishedAt/, 'Publication time must be separate from sample collection time');
assert.match(snapshotBuilder.func, /ageMs/, 'Snapshot must expose sample age');
assert.match(snapshotBuilder.func, /stale/, 'Snapshot must expose stale samples');
assert.match(snapshotBuilder.func, /snapshotComplete/, 'Snapshot completeness must be explicit');
assert.match(snapshotBuilder.func, /STALE_AFTER_MS = 6000/, 'Staleness must be six seconds');
assert.match(readBatchBuilder.func, /BATCH_TIMEOUT_MS = 5000/, 'Read batch timeout must be five seconds');
assert.match(readBatchBuilder.func, /cpslai2_read_batch/, 'Read batches must use CPS-LAI-02-isolated state');
assert.match(normalizer.func, /DUPLICATE_READ_RESPONSE/);
assert.match(normalizer.func, /OLDER_SAMPLE_REJECTED/);
assert.equal(snapshotBuilder.func.includes('flow.set'), false, 'Periodic snapshot must not create or restart subscriptions');

const cache = new Map([
  ['cpslai2_telemetry_by_nodeid', Object.fromEntries([...EXPECTED].map(([tag, nodeId]) => [nodeId, { tag, nodeId, dataType: 'Boolean' }]))],
]);
const flowContext = {
  get: (key) => cache.get(key),
  set: (key, value) => cache.set(key, value),
};
const executeFunction = (code, msg) => vm.runInNewContext(`(() => { ${code} })()`, {
  msg,
  flow: flowContext,
  node: { warn: () => {} },
});

const firstBatchResult = executeFunction(readBatchBuilder.func, { payload: Date.now() });
assert.equal(firstBatchResult.length, 1);
const readRequests = firstBatchResult[0];
assert.equal(readRequests.length, EXPECTED.size, 'Each batch must contain exactly six real reads');
assert.equal(new Set(readRequests.map((request) => request.topic)).size, EXPECTED.size);
assert.deepEqual(new Set(readRequests.map((request) => request.topic)), new Set(EXPECTED.values()));
assert.equal(new Set(readRequests.map((request) => request._batchId)).size, 1);
assert.equal(executeFunction(readBatchBuilder.func, { payload: Date.now() }), null, 'An active batch must block overlapping reads');

const values = [false, true, true, false, true, false];
const responseFor = (request, value, overrides = {}) => ({
  ...request,
  payload: value,
  datatype: 'Boolean',
  statusCode: { name: 'Good' },
  sourceTimestamp: '2026-10-09T10:00:00.000Z',
  serverTimestamp: '2026-10-09T10:00:00.010Z',
  ...overrides,
});

executeFunction(normalizer.func, responseFor(readRequests[0], values[0]));
assert.equal(cache.get('cpslai2_read_batch').receivedNodeIds.length, 1);
executeFunction(normalizer.func, responseFor(readRequests[0], values[0]));
assert.equal(cache.get('cpslai2_read_batch').receivedNodeIds.length, 1, 'Duplicate response must not advance batch completion');
for (let index = 1; index < readRequests.length; index += 1) {
  executeFunction(normalizer.func, responseFor(readRequests[index], values[index]));
}
assert.equal(cache.get('cpslai2_read_batch'), null, 'Six unique responses must release the batch lock');
assert.equal(cache.get('cpslai2_last_read_batch').receivedNodeIds.length, EXPECTED.size);
for (const [[tag], value] of [...EXPECTED].map((entry, index) => [entry, values[index]])) {
  assert.equal(cache.get('cpslai2_samples')[tag].value, value, `${tag} Boolean value was not preserved`);
}

const priorSysMan = { ...cache.get('cpslai2_samples').sys_man };
executeFunction(normalizer.func, responseFor({ ...readRequests[0], _batchId: undefined }, true, {
  statusCode: { name: 'BadNotConnected' },
  serverTimestamp: '2026-10-09T10:01:00.000Z',
}));
assert.equal(JSON.stringify(cache.get('cpslai2_samples').sys_man), JSON.stringify(priorSysMan), 'Invalid quality must not erase prior evidence');
executeFunction(normalizer.func, responseFor({ ...readRequests[0], _batchId: undefined }, true, {
  datatype: 'Int32',
  serverTimestamp: '2026-10-09T10:01:00.000Z',
}));
assert.equal(JSON.stringify(cache.get('cpslai2_samples').sys_man), JSON.stringify(priorSysMan), 'Invalid datatype must not update cache');
executeFunction(normalizer.func, responseFor({ ...readRequests[0], _batchId: undefined }, true, {
  serverTimestamp: '2026-10-09T09:59:00.000Z',
}));
assert.equal(JSON.stringify(cache.get('cpslai2_samples').sys_man), JSON.stringify(priorSysMan), 'Older reading must not overwrite a newer sample');

const timeoutBatch = executeFunction(readBatchBuilder.func, { payload: Date.now() })[0];
const timedOutState = cache.get('cpslai2_read_batch');
timedOutState.expiresAt = Date.now() - 1;
timedOutState.receivedNodeIds = [timeoutBatch[0].topic];
cache.set('cpslai2_read_batch', timedOutState);
const replacementBatch = executeFunction(readBatchBuilder.func, { payload: Date.now() })[0];
assert.equal(replacementBatch.length, EXPECTED.size);
assert.notEqual(replacementBatch[0]._batchId, timeoutBatch[0]._batchId, 'Timeout must release the old batch and create an isolated replacement');
assert.equal(cache.get('cpslai2_read_diagnostics').some((entry) => entry.type === 'READ_BATCH_TIMEOUT'), true);
const beforeLateResponse = JSON.stringify(cache.get('cpslai2_samples').sys_man);
executeFunction(normalizer.func, responseFor(timeoutBatch[0], true, { serverTimestamp: '2026-10-09T10:02:00.000Z' }));
assert.equal(JSON.stringify(cache.get('cpslai2_samples').sys_man), beforeLateResponse, 'A response from an expired batch must not update cache');
assert.equal(cache.get('cpslai2_read_diagnostics').some((entry) => entry.type === 'LATE_OR_UNKNOWN_READ_RESPONSE'), true);

executeFunction(normalizer.func, responseFor({ ...readRequests[0], _batchId: undefined }, false, {
  serverTimestamp: '2026-10-09T10:03:00.000Z',
}));
assert.equal(cache.get('cpslai2_samples').sys_man.value, false);
assert.equal(cache.get('cpslai2_samples').sys_man.serverTimestamp, '2026-10-09T10:03:00.000Z');
assert.equal(cache.get('cpslai2_samples').sys_man.semanticMappingStatus, 'PHYSICALLY_VALIDATED_MODE_MARKER');

for (const sample of Object.values(cache.get('cpslai2_samples'))) {
  sample.collectedAt = '2026-10-09T10:00:00.020Z';
}
const snapshot = executeFunction(snapshotBuilder.func, { payload: Date.now() });
assert.equal(snapshot.topic, 'cpslai2/data');
assert.equal(snapshot.payload.snapshotComplete, true);
assert.equal(Object.keys(snapshot.payload.data).length, EXPECTED.size);
assert.equal(snapshot.payload.data.sys_man.value, false);
assert.equal(snapshot.payload.data.sys_man2.value, true);
assert.equal(snapshot.payload.data.sys_man.quality, 'Good');
assert.equal(snapshot.payload.data.sys_man.semanticMappingStatus, 'PHYSICALLY_VALIDATED_MODE_MARKER');
assert.equal(snapshot.payload.data.sys_man.collectedAt === snapshot.payload.publishedAt, false, 'Publishing must not refresh collection time');
assert.equal(snapshot.payload.data.sys_man.stale, true, 'Old cached PLC data must be marked stale');
assert.equal(snapshot.payload.data.sys_man.validAtCollection, true, 'Original OPC UA validity must be preserved');
assert.equal(snapshot.payload.data.sys_man.valid, false, 'A stale sample must not be presented as a current valid reading');

const runDerivation = (data) => executeFunction(modeDeriver.func, {
  payload: { publishedAt: '2026-10-09T12:00:00.000Z', data },
}).payload;
const modeSample = (value, overrides = {}) => ({ value, dataType: 'Boolean', statusCode: 'Good', quality: 'Good', valid: true, stale: false, ...overrides });
const modeData = (manual, automatic, stepByStep) => ({
  sys_man: modeSample(manual), sys_sup: modeSample(automatic), sys_man2: modeSample(stepByStep),
  sys_menu: modeSample(true), man_step_0: modeSample(false), man_step_1: modeSample(false),
});
for (const [valuesForMode, expectedMode] of [
  [[true, false, false], 'MANUAL'],
  [[false, true, false], 'AUTOMATIC'],
  [[false, false, true], 'STEP_BY_STEP'],
]) {
  const data = modeData(...valuesForMode);
  const result = runDerivation(data);
  assert.equal(result.derived.operationMode, expectedMode);
  assert.equal(Object.keys(result.data).length, EXPECTED.size, 'Derivation must preserve all six physical tags');
}
assert.equal(runDerivation(modeData(false, false, false)).derived.reason, 'NO_ACTIVE_MODE_MARKER');
assert.equal(runDerivation(modeData(true, true, false)).derived.reason, 'NON_EXCLUSIVE_MODE_MARKERS');
const missingMarker = modeData(true, false, false); delete missingMarker.sys_sup;
assert.equal(runDerivation(missingMarker).derived.reason, 'MISSING_MODE_MARKER');
const badQuality = modeData(true, false, false); badQuality.sys_man.statusCode = 'BadNotConnected';
assert.equal(runDerivation(badQuality).derived.reason, 'BAD_OPCUA_QUALITY');
const staleMarker = modeData(true, false, false); staleMarker.sys_man.stale = true; staleMarker.sys_man.valid = false;
assert.equal(runDerivation(staleMarker).derived.reason, 'STALE_MODE_MARKER');
const badDatatype = modeData(true, false, false); badDatatype.sys_man.dataType = 'Int32';
assert.equal(runDerivation(badDatatype).derived.reason, 'INCOMPATIBLE_MARKER_DATATYPE');
assert.equal(JSON.stringify(flow).includes('cpslai2/status'), false);
assert.equal(JSON.stringify(flow).includes('cpslai2/health'), false);
assert.equal(JSON.stringify(flow).includes('cpslai2/oee'), false);

const fieldMapping = aas.submodels.find((submodel) => submodel.idShort === 'FieldIOMapping');
const markerCollection = fieldMapping?.submodelElements?.find((element) => element.idShort === 'PhysicalOperationModeMarkers');
assert.ok(markerCollection, 'AAS must document the validated physical mode markers');
const markerEntries = new Map(markerCollection.value.map((entry) => [entry.idShort, Object.fromEntries(entry.value.map((item) => [item.idShort, item.value]))]));
assert.equal(markerEntries.get('ManualModeMarker').ValidationStatus, 'PHYSICALLY_VALIDATED_MODE_MARKER');
assert.equal(markerEntries.get('AutomaticModeMarker').OPCUANodeId, 'ns=3;s="sys_sup"');
assert.equal(markerEntries.get('StepByStepModeMarker').OriginalTagName, 'sys_man2');
const complementary = fieldMapping.submodelElements.find((element) => element.idShort === 'ComplementaryPhysicalEvidence');
assert.deepEqual(complementary.value.map((entry) => entry.idShort), ['sys_menu', 'man_step_0', 'man_step_1']);
assert.equal(complementary.value.every((entry) => entry.qualifiers[0].value === 'PRELIMINARY_UNVALIDATED'), true);

console.log(`CPS-LAI-02 static validation OK: ${EXPECTED.size} cached real tags, periodic snapshots, data-only MQTT, read-only OPC UA, disabled tab.`);
