import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveCpsLai2OperationMode } from '../lib/acsm/cpsLai2OperationMode.mjs';

const at = '2026-10-09T12:00:00.000Z';
const sample = (value, overrides = {}) => ({
  value,
  dataType: 'Boolean',
  statusCode: 'Good',
  quality: 'Good',
  valid: true,
  stale: false,
  collectedAt: '2026-10-09T11:59:59.500Z',
  ...overrides,
});
const markers = (manual, automatic, stepByStep) => ({
  sys_man: sample(manual),
  sys_sup: sample(automatic),
  sys_man2: sample(stepByStep),
  sys_menu: sample(true),
  man_step_0: sample(false),
  man_step_1: sample(false),
});

test('identifies physically validated Manual mode', () => {
  const result = deriveCpsLai2OperationMode(markers(true, false, false), at);
  assert.equal(result.operationMode, 'MANUAL');
  assert.equal(result.reason, 'EXCLUSIVE_MANUAL_MARKER');
});

test('identifies physically validated Automatic mode', () => {
  assert.equal(deriveCpsLai2OperationMode(markers(false, true, false), at).operationMode, 'AUTOMATIC');
});

test('identifies physically validated Step-by-Step mode', () => {
  assert.equal(deriveCpsLai2OperationMode(markers(false, false, true), at).operationMode, 'STEP_BY_STEP');
});

test('all false is UNKNOWN', () => {
  assert.equal(deriveCpsLai2OperationMode(markers(false, false, false), at).reason, 'NO_ACTIVE_MODE_MARKER');
});

test('two or more active markers are UNKNOWN', () => {
  assert.equal(deriveCpsLai2OperationMode(markers(true, true, false), at).reason, 'NON_EXCLUSIVE_MODE_MARKERS');
  assert.equal(deriveCpsLai2OperationMode(markers(true, true, true), at).operationMode, 'UNKNOWN');
});

test('missing marker is UNKNOWN', () => {
  const data = markers(true, false, false);
  delete data.sys_sup;
  assert.equal(deriveCpsLai2OperationMode(data, at).reason, 'MISSING_MODE_MARKER');
});

test('bad OPC UA quality is UNKNOWN', () => {
  const data = markers(true, false, false);
  data.sys_man.statusCode = 'BadNotConnected';
  assert.equal(deriveCpsLai2OperationMode(data, at).reason, 'BAD_OPCUA_QUALITY');
});

test('stale marker is UNKNOWN', () => {
  const data = markers(true, false, false);
  data.sys_man.stale = true;
  data.sys_man.valid = false;
  assert.equal(deriveCpsLai2OperationMode(data, at).reason, 'STALE_MODE_MARKER');
});

test('incompatible datatype is UNKNOWN', () => {
  const data = markers(true, false, false);
  data.sys_man.dataType = 'Int32';
  assert.equal(deriveCpsLai2OperationMode(data, at).reason, 'INCOMPATIBLE_MARKER_DATATYPE');
});

test('derivation preserves physical data and identifies only the three validated tags', () => {
  const data = markers(true, false, false);
  const before = JSON.stringify(data);
  const result = deriveCpsLai2OperationMode(data, at);
  assert.equal(JSON.stringify(data), before);
  assert.deepEqual(result.tagsUsed.map((entry) => entry.tag).sort(), ['sys_man', 'sys_man2', 'sys_sup']);
  assert.equal(result.semanticValidationStatus, 'PHYSICALLY_VALIDATED');
  assert.equal(result.derivedAt, at);
});
