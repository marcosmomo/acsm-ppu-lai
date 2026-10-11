import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { deriveCpsLai3PhysicalOperationMode } from '../lib/acsm/cpsLai3OperationMode.mjs';
import {
  getOperationalStateForPresentation,
  operationalStateCardClass,
} from '../lib/acsm/cpsStatusPresentation.mjs';

const at = '2026-10-10T18:00:00.000Z';
const markers = (manual, automatic, stepByStep, overrides = {}) => {
  const values = { GCT_0: false, sys_man: manual, sys_sup: automatic, sys_man2: stepByStep };
  const nodeIds = {
    GCT_0: 'ns=3;s="GCT_0"',
    sys_man: 'ns=3;s="sys_man"',
    sys_sup: 'ns=3;s="sys_sup"',
    sys_man2: 'ns=3;s="sys_man2"',
  };
  return Object.fromEntries(Object.entries(values).map(([tag, value]) => [tag, {
    field: tag,
    nodeId: nodeIds[tag],
    value,
    dataType: 'Boolean',
    dataTypeNodeId: 'ns=0;i=1',
    dataTypeEvidence: 'OPC_UA_ATTRIBUTE_DATATYPE',
    statusCode: 'Good',
    quality: 'Good',
    valid: true,
    stale: false,
    collectedAt: at,
    semanticMappingStatus: 'PHYSICALLY_VALIDATED_MODE_MARKER',
    ...(overrides[tag] || {}),
  }]));
};

const evidence = (manual, automatic, stepByStep, overrides = {}) => {
  const data = markers(manual, automatic, stepByStep, overrides);
  const active = [manual, automatic, stepByStep].filter(Boolean).length;
  const operationMode = active !== 1 ? 'UNKNOWN' : manual ? 'MANUAL' : automatic ? 'AUTOMATIC' : 'STEP_BY_STEP';
  const reason = active === 0 ? 'NO_ACTIVE_MODE_MARKER'
    : active > 1 ? 'NON_EXCLUSIVE_MODE_MARKERS'
      : manual ? 'EXCLUSIVE_MANUAL_MARKER'
        : automatic ? 'EXCLUSIVE_AUTOMATIC_MARKER'
          : 'EXCLUSIVE_STEP_BY_STEP_MARKER';
  return {
    publishedAt: at,
    data,
    derived: {
      operationMode,
      reason,
      source: 'CPS_LAI_03_PHYSICAL_MODE_MARKERS',
      semanticValidationStatus: 'PHYSICALLY_VALIDATED',
      derivedAt: at,
    },
  };
};

const derive = (entry, dataFresh = true) => deriveCpsLai3PhysicalOperationMode({
  cpsId: 'cpslai3', evidence: entry, communication: { dataFresh },
});

test('exclusive Boolean combinations derive the three validated physical modes', () => {
  assert.equal(derive(evidence(true, false, false)).operationMode, 'MANUAL');
  assert.equal(derive(evidence(false, true, false)).operationMode, 'AUTOMATIC');
  assert.equal(derive(evidence(false, false, true)).operationMode, 'STEP_BY_STEP');
});

test('validated GCT_0 derives INIT only without an active physical mode marker', () => {
  const init = evidence(false, false, false, { GCT_0: { value: true } });
  init.derived.operationMode = 'INIT';
  init.derived.reason = 'VALIDATED_GCT_0_ACTIVE';
  assert.equal(derive(init).operationMode, 'INIT');
  const conflict = evidence(true, false, false, { GCT_0: { value: true } });
  conflict.derived.operationMode = 'UNKNOWN';
  conflict.derived.reason = 'INIT_MARKER_CONFLICT';
  assert.equal(derive(conflict).operationMode, 'UNKNOWN');
});

test('all other Boolean combinations remain UNKNOWN', () => {
  for (const values of [
    [false, false, false], [true, true, false], [true, false, true],
    [false, true, true], [true, true, true],
  ]) assert.equal(derive(evidence(...values)).operationMode, 'UNKNOWN');
});

test('missing or incompatible datatype, bad quality, invalid and stale samples are rejected', () => {
  for (const override of [
    { dataType: null }, { dataType: 'Int32' }, { statusCode: 'BadNodeIdUnknown', quality: 'BadNodeIdUnknown' },
    { valid: false }, { stale: true }, { value: 1 }, { collectedAt: null },
  ]) {
    assert.equal(derive(evidence(true, false, false, { sys_man: override })).operationMode, 'UNKNOWN');
  }
});

test('missing sample, timeout and unconfirmed communication remain UNKNOWN; recovery restores mode', () => {
  const current = evidence(false, true, false);
  const incomplete = structuredClone(current);
  delete incomplete.data.sys_sup;
  assert.equal(derive(incomplete).reason, 'MISSING_MODE_MARKER');
  assert.equal(derive(current, false).reason, 'COMMUNICATION_LOST');
  assert.equal(deriveCpsLai3PhysicalOperationMode({ cpsId: 'cpslai3', evidence: current }).reason, 'COMMUNICATION_UNCONFIRMED');
  assert.equal(derive(current, true).operationMode, 'AUTOMATIC');
});

test('CPS-LAI-03 uses INIT only before first adapter evidence', () => {
  const initial = deriveCpsLai3PhysicalOperationMode({
    cpsId: 'cpslai3', evidence: null, communication: { dataFresh: false },
  });
  assert.equal(initial.operationMode, 'INIT');
  assert.equal(initial.valid, false);
  assert.equal(initial.reason, 'AWAITING_INITIAL_MODE_EVIDENCE');

  for (const values of [[true, false, false], [false, true, false], [false, false, true]]) {
    assert.notEqual(derive(evidence(...values)).operationMode, 'INIT');
  }
  assert.equal(derive(evidence(true, false, false), false).operationMode, 'UNKNOWN');
  assert.equal(derive(evidence(true, true, false)).operationMode, 'UNKNOWN');
});

test('adapter semantic string or claimed mode cannot replace raw marker validation', () => {
  const forged = evidence(true, false, false);
  forged.derived.operationMode = 'AUTOMATIC';
  forged.derived.reason = 'EXCLUSIVE_AUTOMATIC_MARKER';
  assert.equal(derive(forged).reason, 'ADAPTER_DERIVATION_MISMATCH');
  assert.equal(derive({ ...forged, data: null }).operationMode, 'UNKNOWN');
});

test('real schema 1.2 MQTT contract survives normalization and derives STEP_BY_STEP', async () => {
  const { mergeCpsTelemetry } = await import('../lib/acsm/cpsTelemetry.mjs');
  const payload = {
    schemaVersion: '1.2', cpsId: 'cpslai3', timestamp: at, publishedAt: at,
    staleAfterMs: 6000, communication: { dataFresh: true },
    data: markers(false, false, true),
    derived: {
      operationMode: 'STEP_BY_STEP', source: 'CPS_LAI_03_PHYSICAL_MODE_MARKERS',
      semanticValidationStatus: 'PHYSICALLY_VALIDATED',
      reason: 'EXCLUSIVE_STEP_BY_STEP_MARKER', derivedAt: at,
    },
  };
  const normalized = mergeCpsTelemetry(null, payload);
  assert.equal(normalized.data.sys_man2.dataTypeEvidence, 'OPC_UA_ATTRIBUTE_DATATYPE');
  assert.equal(normalized.data.sys_man2.dataTypeNodeId, 'ns=0;i=1');
  const physical = derive(normalized);
  assert.equal(physical.operationMode, 'STEP_BY_STEP');
  assert.equal(physical.valid, true);
  assert.equal(physical.reason, 'EXCLUSIVE_STEP_BY_STEP_MARKER');
  assert.equal(physical.initEvidence.sourceTag, 'GCT_0');
});

test('CPS identity is isolated and CPSContext preserves internal state while storing physical evidence', () => {
  assert.equal(deriveCpsLai3PhysicalOperationMode({
    cpsId: 'cpslai2', evidence: evidence(true, false, false), communication: { dataFresh: true },
  }).reason, 'CPS_ID_MISMATCH');
  const source = readFileSync(new URL('../context/CPSContext.js', import.meta.url), 'utf8');
  assert.match(source, /deriveCpsLai3PhysicalOperationMode/);
  assert.match(source, /physicalModeEvidence/);
  assert.match(source, /physicalModeCommunication/);
  assert.doesNotMatch(source, /isCpsLai3Status[\s\S]{0,700}operationMode:\s*'UNKNOWN'/);
});

test('a later cpslai3/status update cannot replace physical operationalData from /data', () => {
  const contextSource = readFileSync(new URL('../context/CPSContext.js', import.meta.url), 'utf8');
  assert.match(contextSource, /operationalData:\s*isCpsLai3Status\s*\?\s*c\?\.operationalData\s*:\s*nextOperationalData/);
  assert.match(contextSource, /\.\.\.\(isCpsLai3Status \? \{\} : \{ operationalData: nextOperationalData \}\)/);
});

test('CPSContext initializes LAI-02/03 with INIT and status messages preserve that field', () => {
  const contextSource = readFileSync(new URL('../context/CPSContext.js', import.meta.url), 'utf8');
  assert.match(contextSource, /cpsId === 'cpslai2' \|\| cpsId === 'cpslai3' \? 'INIT' : operationMode/);
  assert.match(contextSource, /isCpsLai2Status\s*\? \{ \.\.\.\(owner\?\.operationalData \|\| \{\}\) \}/);
  assert.match(contextSource, /operationalData: isCpsLai3Status\s*\? c\?\.operationalData/);
});

test('Play Phase renders the Operation Mode field for CPS-LAI-03', () => {
  const playSource = readFileSync(new URL('../components/PlayFase.js', import.meta.url), 'utf8');
  assert.match(playSource, /\(isCpsLai1 \|\| usesLocalTelemetryModal \|\| isCpsLai3\)/);
  assert.match(playSource, /Operation Mode:\s*<strong>\{operationModeText\}<\/strong>/);
});

test('successive real MQTT snapshots and interleaved status messages project one physical snapshot', async () => {
  const { mergeTelemetryState } = await import('../lib/acsm/cpsTelemetry.mjs');
  let telemetry = {};
  let internalState = 'Running';
  const cases = [
    { mode: 'AUTOMATIC', values: [false, true, false], state: 'Running', expectedState: 'running', tone: 'status-running' },
    { mode: 'MANUAL', values: [true, false, false], state: 'Stopped', expectedState: 'intervention', tone: 'status-intervention' },
    { mode: 'STEP_BY_STEP', values: [false, false, true], state: 'Running', expectedState: 'maintenance', tone: 'status-maintenance' },
    { mode: 'AUTOMATIC', values: [false, true, false], state: 'Stopped', expectedState: 'stopped', tone: 'status-stopped' },
  ];

  for (let index = 0; index < cases.length; index += 1) {
    const item = cases[index];
    const publishedAt = `2026-10-10T18:00:0${index}.000Z`;
    const payloadEvidence = evidence(...item.values);
    payloadEvidence.publishedAt = publishedAt;
    payloadEvidence.derived.derivedAt = publishedAt;
    for (const sample of Object.values(payloadEvidence.data)) {
      sample.collectedAt = publishedAt;
      // Older controller timestamps must not outrank current collection time.
      sample.sourceTimestamp = '2014-01-01T00:00:00.000Z';
      sample.serverTimestamp = '2014-01-01T00:00:00.000Z';
    }
    const payload = {
      schemaVersion: '1.2', cpsId: 'cpslai3', timestamp: publishedAt,
      publishedAt, staleAfterMs: 6000, communication: { dataFresh: true, connected: true },
      data: payloadEvidence.data,
      derived: payloadEvidence.derived,
    };
    telemetry = mergeTelemetryState(telemetry, 'cpslai3', payload);
    // Interleaved /status updates internal state, but must not become the source
    // of the physical mode shown by the card.
    internalState = item.state;

    const snapshot = telemetry.cpslai3;
    const mode = derive(snapshot, true);
    const shownState = getOperationalStateForPresentation(
      { id: 'cpslai3' }, internalState,
      { modeEvidence: snapshot, communication: { dataFresh: true } }
    );
    assert.equal(mode.operationMode, item.mode);
    assert.equal(shownState, item.expectedState);
    assert.match(operationalStateCardClass(shownState, 'cpslai3'), new RegExp(item.tone));
    assert.equal(snapshot.data.sys_sup.sourceTimestamp, '2014-01-01T00:00:00.000Z');
    assert.equal(snapshot.data.sys_sup.collectedAt, publishedAt);
    assert.equal(internalState, item.state, 'presentation must not mutate internal state');
  }
});

test('CPS-LAI-03 AUTOMATIC with non-running/non-stopped internal state is Unknown', () => {
  const automatic = evidence(false, true, false);
  for (const internalState of ['Maintenance', 'Ready', 'Unknown']) {
    const state = getOperationalStateForPresentation(
      { id: 'cpslai3' }, internalState,
      { modeEvidence: automatic, communication: { dataFresh: true } }
    );
    assert.equal(state, 'unknown');
    assert.match(operationalStateCardClass(state, 'cpslai3'), /status-unknown/);
  }
});

test('old physical samples are rejected and freshness loss hides both indicators until recovery', async () => {
  const { mergeTelemetryState } = await import('../lib/acsm/cpsTelemetry.mjs');
  const currentAt = '2026-10-10T18:00:05.000Z';
  const previous = mergeTelemetryState({}, 'cpslai3', {
    schemaVersion: '1.2', cpsId: 'cpslai3', timestamp: currentAt, publishedAt: currentAt,
    staleAfterMs: 6000, communication: { dataFresh: true },
    data: Object.fromEntries(Object.entries(markers(false, true, false)).map(([tag, sample]) => [tag, {
      ...sample, collectedAt: currentAt,
    }])),
    derived: { operationMode: 'AUTOMATIC', reason: 'EXCLUSIVE_AUTOMATIC_MARKER',
      source: 'CPS_LAI_03_PHYSICAL_MODE_MARKERS', semanticValidationStatus: 'PHYSICALLY_VALIDATED', derivedAt: currentAt },
  });
  const olderAt = '2026-10-10T18:00:01.000Z';
  const oldEvidence = evidence(true, false, false);
  for (const sample of Object.values(oldEvidence.data)) sample.collectedAt = olderAt;
  const afterOld = mergeTelemetryState(previous, 'cpslai3', {
    schemaVersion: '1.2', cpsId: 'cpslai3', timestamp: currentAt, publishedAt: currentAt,
    data: oldEvidence.data, derived: { ...oldEvidence.derived, derivedAt: olderAt },
  });
  assert.equal(afterOld.cpslai3.data.sys_man.value, false, 'older collectedAt must not replace the current marker');
  assert.equal(derive(afterOld.cpslai3, true).operationMode, 'AUTOMATIC');

  const unavailableState = getOperationalStateForPresentation(
    { id: 'cpslai3' }, 'Running',
    { modeEvidence: afterOld.cpslai3, communication: { dataFresh: false } }
  );
  assert.equal(unavailableState, 'unknown');
  assert.equal(derive(afterOld.cpslai3, false).operationMode, 'UNKNOWN');
  assert.equal(derive(afterOld.cpslai3, true).operationMode, 'AUTOMATIC', 'new current evidence recovers mode');
});

test('PlayFase derives CPS-LAI-03 mode and state from the same latest telemetry snapshot', () => {
  const playSource = readFileSync(new URL('../components/PlayFase.js', import.meta.url), 'utf8');
  assert.match(playSource, /const cpsLai3ModeEvidence = isCpsLai3 \? telemetryData\?\.\[normalizedCpsId\] : null/);
  assert.match(playSource, /evidence: cpsLai3ModeEvidence/);
  assert.match(playSource, /modeEvidence: cpsLai3ModeEvidence/);
  assert.match(playSource, /cpsLai3Mode\?\.operationMode \|\| 'INIT'/);
});
