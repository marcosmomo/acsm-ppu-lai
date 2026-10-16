import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyPhysicalActivity, createPhysicalActivityObservation,
  deriveCpsLai1OperationalState, invalidatePhysicalActivity, observePhysicalSensor,
} from '../lib/acsm/cpsLai1PhysicalActivity.mjs';

const samples = [
  { field: 'PieceAtEntry', tag: 'G1BG3', value: false },
  { field: 'PieceAtMiddle', tag: 'G1BG2', value: false },
  { field: 'PieceAtExit', tag: 'G1BG1', value: false },
];
const baseline = (confirmed) => samples.reduce(
  (state, sample, index) => observePhysicalSensor(state, sample, 1000 + index),
  { ...createPhysicalActivityObservation(), subscriptionConfirmed: confirmed },
);

test('baseline is not activity and unconfirmed continuity remains UNKNOWN', () => {
  const state = baseline(false);
  assert.equal(state.lastActivityAt, null);
  assert.equal(classifyPhysicalActivity(state, { nowMs: 9000 }).state, 'UNKNOWN');
});

test('confirmed baseline opens observation and becomes inactive only after threshold', () => {
  const state = baseline(true);
  assert.equal(classifyPhysicalActivity(state, { nowMs: 5000 }).state, 'OBSERVING_NO_TRANSITION');
  assert.equal(classifyPhysicalActivity(state, { nowMs: 7003 }).state, 'INACTIVE_WINDOW_EXCEEDED');
});

test('both boolean edges record activity and STOPPED returns to RUNNING', () => {
  let state = baseline(true);
  let inactive = classifyPhysicalActivity(state, { nowMs: 8000 });
  assert.equal(deriveCpsLai1OperationalState({ dataFresh: true, lifecyclePhase: 'play', operationMode: 'AUTOMATIC', activity: inactive }).state, 'STOPPED');
  state = observePhysicalSensor(state, { ...samples[0], value: true }, 8100);
  let active = classifyPhysicalActivity(state, { nowMs: 8200 });
  assert.equal(deriveCpsLai1OperationalState({ dataFresh: true, lifecyclePhase: 'play', operationMode: 'AUTOMATIC', activity: active }).state, 'RUNNING');
  state = observePhysicalSensor(state, samples[0], 8300);
  assert.equal(state.lastActivityAt, 8300);
});

test('disconnect/reconnect invalidates observation and requires a new confirmed baseline', () => {
  const disconnected = invalidatePhysicalActivity(baseline(true), 'OPCUA_DISCONNECTED', 3000);
  assert.equal(classifyPhysicalActivity(disconnected, { nowMs: 10000 }).state, 'UNKNOWN');
  assert.equal(disconnected.observationStartedAt, null);
});

test('other modes are preserved and AUTOMATIC alone never proves RUNNING', () => {
  const unknown = classifyPhysicalActivity(baseline(false), { nowMs: 9000 });
  assert.equal(deriveCpsLai1OperationalState({ dataFresh: true, lifecyclePhase: 'play', operationMode: 'AUTOMATIC', activity: unknown }).state, 'UNKNOWN');
  assert.equal(deriveCpsLai1OperationalState({ dataFresh: true, lifecyclePhase: 'play', operationMode: 'STEP_BY_STEP', activity: unknown }).state, 'MAINTENANCE');
  assert.equal(deriveCpsLai1OperationalState({ dataFresh: false, lifecyclePhase: 'play', operationMode: 'AUTOMATIC', activity: unknown }).state, 'UNKNOWN');
});
