import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  getOperationModePresentation,
  getOperationalStateForPresentation,
  getOperationalStatePresentation,
  operationModeBadgeClass,
  operationalStateBadgeClass,
  operationalStateCardClass,
} from '../lib/acsm/cpsStatusPresentation.mjs';

test('operational aliases share labels and colors', () => {
  for (const alias of ['running', 'active', 'Rodando']) {
    assert.deepEqual(getOperationalStatePresentation(alias), {
      state: 'running', label: 'Running', tone: 'active',
    });
    assert.equal(operationalStateBadgeClass(alias), 'feat-badge feat-active');
    assert.equal(operationalStateCardClass(alias), 'cps-item-play status-running');
  }
  for (const alias of ['stopped', 'paused', 'Parado']) {
    assert.equal(getOperationalStatePresentation(alias).label, 'Stopped');
    assert.equal(operationalStateBadgeClass(alias), 'feat-badge feat-stopped');
    assert.equal(operationalStateCardClass(alias), 'cps-item-play status-stopped');
  }
  assert.equal(operationalStateCardClass('maintenance'), 'cps-item-play status-maintenance');
  assert.equal(operationalStateCardClass('UNKNOWN'), 'cps-item-play status-unknown');
});

test('physical CPS outer cards receive their isolated state color classes', () => {
  assert.equal(
    operationalStateCardClass('running', 'CPS-LAI-01'),
    'cps-item-play status-running cps-lai-01-operational-card'
  );
  assert.equal(
    operationalStateCardClass('stopped', 'cpslai2'),
    'cps-item-play status-stopped cps-lai-02-operational-card'
  );
  assert.equal(
    operationalStateCardClass('maintenance', 'cpslai3'),
    'cps-item-play status-maintenance cps-lai-03-operational-card'
  );
});

test('physical CPS card CSS shares full background and border while preserving text styling', () => {
  const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');
  const expectedColors = {
    running: ['#d4edda', '#28a745'],
    stopped: ['#f8d7da', '#dc3545'],
    maintenance: ['#fef3c7', '#d97706'],
    unknown: ['#f1f5f9', '#64748b'],
  };

  for (const cardClass of [
    'cps-lai-01-operational-card',
    'cps-lai-02-operational-card',
    'cps-lai-03-operational-card',
  ]) {
    for (const [state, [background, border]] of Object.entries(expectedColors)) {
      const selector = `.cps-item-play.${cardClass}.status-${state}`;
      const selectorStart = css.indexOf(selector);
      assert.notEqual(selectorStart, -1, `${selector} must exist`);
      const ruleStart = css.indexOf('{', selectorStart);
      const rule = css.slice(ruleStart, css.indexOf('}', ruleStart) + 1);
      assert.match(rule, new RegExp(`background:\\s*${background}`, 'i'));
      assert.match(rule, new RegExp(`border:\\s*1px solid ${border}`, 'i'));
      assert.doesNotMatch(rule, /(?:^|[;\s])color\s*:/i);
    }
  }
});

test('physical modes share one color vocabulary', () => {
  assert.equal(operationModeBadgeClass('AUTOMATIC'), 'feat-badge feat-active');
  assert.equal(operationModeBadgeClass('MANUAL'), 'feat-badge feat-manual');
  assert.equal(operationModeBadgeClass('STEP_BY_STEP'), 'feat-badge feat-maintenance');
  assert.equal(operationModeBadgeClass('INIT'), 'feat-badge feat-ready');
  assert.deepEqual(getOperationModePresentation(null), {
    mode: 'UNKNOWN', label: 'UNKNOWN', tone: 'unknown',
  });
});

const cpsLai1 = (overrides = {}) => ({
  id: 'CPS-LAI-01',
  operationalState: 'stopped',
  lifecyclePhase: 'play',
  operationalData: {
    operationMode: 'MANUAL',
    evidenceStatus: 'PHYSICALLY_VALIDATED_MODE',
    operationModeEvidence: { sourceTag: 'Manual_sys' },
  },
  health: { communication: { dataFresh: true } },
  ...overrides,
});

test('valid current CPS-LAI-01 MANUAL mode is presented as Running with the existing green card', () => {
  const cps = cpsLai1();
  const displayedState = getOperationalStateForPresentation(cps, cps.operationalState);
  assert.equal(displayedState, 'running');
  assert.equal(getOperationalStatePresentation(displayedState).label, 'Running');
  assert.equal(operationalStateCardClass(displayedState), 'cps-item-play status-running');
  assert.equal(cps.operationalState, 'stopped');
  assert.equal(cps.lifecyclePhase, 'play');
  assert.equal(cps.operationalData.operationMode, 'MANUAL');
});

test('CPS-LAI-01 MANUAL override requires validated current evidence', () => {
  const cases = [
    [cpsLai1({ health: { communication: { dataFresh: false } } }), 'unknown'],
    [cpsLai1({ health: { communication: {} } }), 'stopped'],
    [cpsLai1({ operationalData: {
      operationMode: 'MANUAL',
      evidenceStatus: 'PENDING',
      operationModeEvidence: { valid: true, stale: false },
    } }), 'stopped'],
    [cpsLai1({ operationalData: {
      operationMode: 'MANUAL',
      evidenceStatus: 'PHYSICALLY_VALIDATED_MODE',
      operationModeEvidence: { valid: true, stale: true },
    } }), 'unknown'],
  ];
  for (const [cps, expected] of cases) {
    assert.equal(getOperationalStateForPresentation(cps, 'stopped'), expected);
  }
});

test('CPS-LAI-01 presentation follows the required connectivity and operation-mode matrix', () => {
  const online = { dataFresh: true };
  const scenarios = [
    { mode: 'MANUAL', state: 'stopped', communication: online, expected: 'running', card: 'status-running' },
    { mode: 'AUTOMATIC', state: 'running', communication: online, expected: 'running', card: 'status-running' },
    { mode: 'AUTOMATIC', state: 'stopped', communication: online, expected: 'stopped', card: 'status-stopped' },
    { mode: 'STEP_BY_STEP', state: 'running', communication: online, expected: 'maintenance', card: 'status-maintenance' },
    { mode: 'UNKNOWN', state: 'running', communication: { dataFresh: false }, expected: 'unknown', card: 'status-unknown' },
  ];

  for (const scenario of scenarios) {
    const cps = cpsLai1({
      operationalState: scenario.state,
      operationalData: {
        operationMode: scenario.mode,
        evidenceStatus: 'PHYSICALLY_VALIDATED_MODE',
        operationModeEvidence: { valid: true, stale: false },
      },
      health: { communication: scenario.communication },
    });
    const displayed = getOperationalStateForPresentation(cps, cps.operationalState);
    assert.equal(displayed, scenario.expected);
    assert.equal(operationalStateCardClass(displayed), `cps-item-play ${scenario.card}`);
    assert.equal(cps.operationalState, scenario.state);
    assert.equal(cps.operationalData.operationMode, scenario.mode);
    assert.equal(cps.lifecyclePhase, 'play');
  }
});

test('CPS-LAI-02 presentation follows the validated physical-mode matrix without mutating state', () => {
  const scenarios = [
    { mode: 'MANUAL', state: 'stopped', valid: true, expected: 'running', card: 'status-running' },
    { mode: 'AUTOMATIC', state: 'running', valid: true, expected: 'running', card: 'status-running' },
    { mode: 'AUTOMATIC', state: 'stopped', valid: true, expected: 'stopped', card: 'status-stopped' },
    { mode: 'STEP_BY_STEP', state: 'running', valid: true, expected: 'maintenance', card: 'status-maintenance' },
    { mode: 'UNKNOWN', state: 'running', valid: false, expected: 'unknown', card: 'status-unknown' },
  ];

  for (const scenario of scenarios) {
    const cps = {
      id: 'CPS-LAI-02',
      operationalState: scenario.state,
      lifecyclePhase: 'play',
      operationalData: { operationMode: scenario.mode },
    };
    const displayed = getOperationalStateForPresentation(cps, cps.operationalState, {
      operationMode: scenario.mode,
      valid: scenario.valid,
    });
    assert.equal(displayed, scenario.expected);
    assert.match(operationalStateCardClass(displayed, cps.id), new RegExp(scenario.card));
    assert.equal(cps.operationalState, scenario.state);
    assert.equal(cps.operationalData.operationMode, scenario.mode);
    assert.equal(cps.lifecyclePhase, 'play');
  }
});

test('CPS-LAI-02 disconnected, stale or invalid evidence presents UNKNOWN', () => {
  const cps = {
    id: 'cpslai2',
    operationalState: 'running',
    lifecyclePhase: 'play',
    operationalData: { operationMode: 'MANUAL' },
  };
  for (const evidence of [
    { operationMode: 'UNKNOWN', valid: false, reason: 'DISCONNECTED' },
    { operationMode: 'UNKNOWN', valid: false, reason: 'STALE_MODE_MARKER' },
    { operationMode: 'UNKNOWN', valid: false, reason: 'BAD_OPCUA_QUALITY' },
    { operationMode: 'MANUAL', valid: false, reason: 'INVALID_MODE_MARKER' },
  ]) {
    assert.equal(getOperationalStateForPresentation(cps, cps.operationalState, evidence), 'unknown');
  }
});

test('CPS-LAI-02 AUTOMATIC preserves the CPS-LAI-01 fallback for unsupported internal states', () => {
  const cps = { id: 'cpslai2', operationalData: { operationMode: 'AUTOMATIC' } };
  for (const state of ['maintenance', 'failure', 'ready']) {
    assert.equal(
      getOperationalStateForPresentation(cps, state, { operationMode: 'AUTOMATIC', valid: true }),
      state
    );
  }
});

test('presentation override changes neither unrelated CPS nor other CPS-LAI-01 modes', () => {
  for (const operationMode of ['AUTOMATIC', 'STEP_BY_STEP', 'UNKNOWN']) {
    const cps = cpsLai1({
      operationalData: {
        operationMode,
        evidenceStatus: 'PHYSICALLY_VALIDATED_MODE',
        operationModeEvidence: { valid: true, stale: false },
      },
    });
    assert.equal(getOperationalStateForPresentation(cps, 'maintenance'), 'maintenance');
  }
  assert.equal(
    getOperationalStateForPresentation({ ...cpsLai1(), id: 'cps7' }, 'stopped'),
    'stopped'
  );
});

test('CPS-LAI-03 remains Unknown without explicitly validated physical mode evidence', () => {
  const cps = {
    id: 'cpslai3',
    lifecyclePhase: 'play',
    operationalData: {
      operationMode: 'UNKNOWN',
      operationModeRaw: 8,
      operationModeSemanticStatus: 'PENDING',
    },
  };

  for (const operationalState of ['running', 'stopped', 'maintenance']) {
    const displayed = getOperationalStateForPresentation(cps, operationalState, {
      modeEvidence: {
        operationMode: 'AUTOMATIC',
        operationModeRaw: 8,
        semanticMappingStatus: 'PENDING',
        valid: true,
        stale: false,
        G1MB1: true,
        G1MB2: false,
      },
      communication: { dataFresh: true },
    });
    assert.equal(displayed, 'unknown');
    assert.equal(cps.operationalData.operationMode, 'UNKNOWN');
    assert.equal(cps.operationalData.operationModeRaw, 8);
    assert.equal(cps.lifecyclePhase, 'play');
  }

  assert.equal(
    operationalStateCardClass('unknown', cps.id),
    'cps-item-play status-unknown cps-lai-03-operational-card'
  );
});

test('CPS-LAI-03 disconnected or stale future evidence remains Unknown', () => {
  const cps = { id: 'cpslai3', operationalState: 'running' };
  const validated = {
    operationMode: 'MANUAL',
    source: 'CPS_LAI_03_PHYSICAL_MODE_MARKERS',
    semanticMappingStatus: 'PHYSICALLY_VALIDATED_MODE_MARKER',
    valid: true,
    stale: false,
  };

  assert.equal(getOperationalStateForPresentation(cps, 'running', {
    modeEvidence: validated,
    communication: { dataFresh: false },
  }), 'unknown');
  assert.equal(getOperationalStateForPresentation(cps, 'running', {
    modeEvidence: { ...validated, stale: true },
    communication: { dataFresh: true },
  }), 'unknown');
});

test('CPS-LAI-03 presentation projects validated physical modes without changing internal state', () => {
  const makeEvidence = (manual, automatic, stepByStep) => {
    const at = '2026-10-10T18:00:00.000Z';
    const values = { sys_man: manual, sys_sup: automatic, sys_man2: stepByStep };
    const nodeIds = {
      sys_man: 'ns=3;s="sys_man"', sys_sup: 'ns=3;s="sys_sup"', sys_man2: 'ns=3;s="sys_man2"',
    };
    const active = Object.values(values).filter(Boolean).length;
    const operationMode = active !== 1 ? 'UNKNOWN' : manual ? 'MANUAL' : automatic ? 'AUTOMATIC' : 'STEP_BY_STEP';
    const reason = active === 0 ? 'NO_ACTIVE_MODE_MARKER'
      : active > 1 ? 'NON_EXCLUSIVE_MODE_MARKERS'
        : manual ? 'EXCLUSIVE_MANUAL_MARKER'
          : automatic ? 'EXCLUSIVE_AUTOMATIC_MARKER'
            : 'EXCLUSIVE_STEP_BY_STEP_MARKER';
    return {
      publishedAt: at,
      data: Object.fromEntries(Object.entries(values).map(([tag, value]) => [tag, {
        nodeId: nodeIds[tag], value, dataType: 'Boolean', dataTypeNodeId: 'ns=0;i=1',
        dataTypeEvidence: 'OPC_UA_ATTRIBUTE_DATATYPE', statusCode: 'Good', quality: 'Good',
        valid: true, stale: false, collectedAt: at,
      }])),
      derived: {
        operationMode, reason, derivedAt: at,
        source: 'CPS_LAI_03_PHYSICAL_MODE_MARKERS', semanticValidationStatus: 'PHYSICALLY_VALIDATED',
      },
    };
  };
  const cps = { id: 'cpslai3', operationalState: 'stopped', lifecyclePhase: 'play' };
  const presentation = (state, modeEvidence) => getOperationalStateForPresentation(cps, state, {
    modeEvidence, communication: { dataFresh: true },
  });

  assert.equal(presentation('stopped', makeEvidence(true, false, false)), 'running');
  assert.equal(presentation('running', makeEvidence(false, false, true)), 'maintenance');
  assert.equal(presentation('running', makeEvidence(false, true, false)), 'running');
  assert.equal(presentation('stopped', makeEvidence(false, true, false)), 'stopped');
  assert.equal(presentation('running', makeEvidence(false, false, false)), 'unknown');
  assert.equal(cps.operationalState, 'stopped');
  assert.equal(cps.lifecyclePhase, 'play');
});
