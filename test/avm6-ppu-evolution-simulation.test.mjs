import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyPpuSimulationAction, buildPpuSimulationModel, createPpuSimulationState, SIMULATED_AUTHORITY } from '../lib/evolution/ppuEvolutionSimulation.mjs';
import { renderPpuEvolutionSimulationHtml } from '../lib/evolution/ppuEvolutionSimulationDashboard.mjs';
import { installPpuEvolutionSimulation } from '../lib/evolution/ppuEvolutionSimulationClient.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const act = (state, action, model) => applyPpuSimulationAction(state, action, model);

class FakeElement {
  constructor(id = '', phase = null) {
    this.id = id; this.value = ''; this.textContent = ''; this.children = [];
    this.dataset = phase ? { phase } : {}; this.listeners = {};
    this.className = '';
    this.classList = { toggle: (name, enabled) => { this.activeClass = enabled ? name : ''; } };
  }
  addEventListener(type, handler) { this.listeners[type] = handler; }
  click() { this.listeners.click?.({ type: 'click', target: this }); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
}

function isolatedDom(model = buildPpuSimulationModel()) {
  const ids = Object.fromEntries(['status', 'active', 'history', 'version', 'plug', 'approve', 'play', 'unplug', 'functional', 'functional-context', 'functional-history']
    .map((id) => [id, new FakeElement(id)]));
  ids.version.value = 'v1';
  ids.model = new FakeElement('model');
  ids.model.textContent = JSON.stringify(model);
  const phases = ['PLUG', 'PLAY', 'UNPLUGGED'].map((phase) => new FakeElement('', phase));
  return {
    ids,
    document: {
      getElementById: (id) => ids[id] || null,
      querySelectorAll: (selector) => selector === '.phase' ? phases : [],
      createElement: () => new FakeElement(),
      createTextNode: (textContent) => ({ textContent }),
    },
  };
}

test('full V1 V2 V3 PPU replay enforces approval and preserves Evolution history', () => {
  const model = buildPpuSimulationModel();
  let state = createPpuSimulationState(model);
  const statuses = [], differences = [];
  for (const version of ['v1', 'v2', 'v3']) {
    let out = act(state, { type: 'PLUG', version }, model); assert.equal(out.ok, true); state = out.state;
    statuses.push(state.active.evolution.status); differences.push(state.active.evolution.differences.map((item) => item.type));
    const retry = act(state, { type: 'PLUG', version }, model); assert.equal(retry.idempotent, true); assert.equal(retry.state, state);
    out = act(state, { type: 'PLAY' }, model); assert.equal(out.code, 'GOVERNANCE_APPROVAL_REQUIRED');
    out = act(state, { type: 'APPROVE', authority: SIMULATED_AUTHORITY }, model); assert.equal(out.ok, true); state = out.state;
    out = act(state, { type: 'PLAY' }, model); assert.equal(out.code, 'PLAY_LOGICAL_ONLY'); state = out.state;
    out = act(state, { type: 'UNPLUG', plugCycleId: state.active.plugCycleId }, model); assert.equal(out.ok, true); state = out.state;
  }
  assert.deepEqual(statuses, ['BASELINE', 'CHANGED', 'CHANGED']);
  assert.deepEqual(differences, [[], ['CHANGED'], ['ADDED']]);
  assert.equal(state.completed.length, 3);
  assert.equal(state.completed.every((cycle) => cycle.lifecycleState === 'CLOSED'), true);
  assert.equal(state.physicalEffects, 0);
});

test('authority is fixed server-authored fixture and divergent Unplug is rejected', () => {
  const model = buildPpuSimulationModel();
  let state = act(createPpuSimulationState(model), { type: 'PLUG', version: 'v1' }, model).state;
  assert.equal(act(state, { type: 'APPROVE', authority: { trusted: true, kind: 'request-body' } }, model).code, 'SIMULATED_AUTHORITY_REQUIRED');
  assert.equal(act(state, { type: 'UNPLUG', plugCycleId: 'late-cycle' }, model).code, 'UNPLUG_IDENTITY_CONFLICT');
  assert.equal(act(state, { type: 'PLUG', version: 'not-listed' }, model).code, 'AAS_NOT_ALLOWLISTED');
});

test('page is self-contained, GET-only, network-denied and imports no mutable runtime', () => {
  const html = renderPpuEvolutionSimulationHtml();
  assert.match(html, /OFFLINE PPU SIMULATION — NO PHYSICAL EXECUTION/);
  assert.match(html, /Plug simulado/); assert.match(html, /Play simulado/); assert.match(html, /Unplug simulado/);
  assert.doesNotMatch(html, /fetch\s*\(|XMLHttpRequest|WebSocket|EventSource|CPSProvider/);
  const route = fs.readFileSync(path.join(root, 'app/experiments/ppu-evolution/route.js'), 'utf8');
  assert.match(route, /export function GET\(\)/);
  assert.doesNotMatch(route, /export function (POST|PUT|PATCH|DELETE)\b/);
  assert.doesNotMatch(route, /GovernanceRepository|EvolutionStore|ExperimentalAasSelectionStore|CPSContext|governanceStore/);
  assert.match(route, /connect-src 'none'/);
  assert.match(route, /script-src 'self'/);
  assert.doesNotMatch(route, /script-src[^;]*unsafe-inline|unsafe-eval/);
  assert.match(html, /src="\/experiments\/ppu-evolution-client" defer/);
});

test('browser controller registers all handlers and button clicks drive the DOM state', () => {
  const { document, ids } = isolatedDom();
  const controller = installPpuEvolutionSimulation(document);
  for (const id of ['plug', 'approve', 'play', 'unplug']) assert.equal(typeof ids[id].listeners.click, 'function');

  ids.plug.click();
  assert.equal(controller.getState().active.profileStatus, 'PENDING_APPROVAL');
  assert.equal(controller.getState().active.evolution.status, 'BASELINE');
  assert.equal(ids.history.children.length, 1);
  assert.equal(ids.active.children.some((item) => item.textContent === 'PENDING_APPROVAL'), true);

  ids.play.click();
  assert.match(ids.status.children[0].textContent, /GOVERNANCE_APPROVAL_REQUIRED/);
  assert.equal(controller.getState().active.played, false);
  ids.approve.click();
  assert.equal(controller.getState().active.profileStatus, 'APPROVED');
  ids.play.click();
  assert.equal(controller.getState().active.played, true);
  ids.unplug.click();
  assert.equal(controller.getState().completed[0].lifecycleState, 'CLOSED');

  for (const [version, status, difference] of [['v2', 'CHANGED', 'CHANGED'], ['v3', 'CHANGED', 'ADDED']]) {
    ids.version.value = version;
    ids.plug.click();
    assert.equal(controller.getState().active.evolution.status, status);
    assert.deepEqual(controller.getState().active.evolution.differences.map((item) => item.type), [difference]);
    ids.approve.click(); ids.play.click(); ids.unplug.click();
  }
  assert.equal(controller.getState().completed.length, 3);
  assert.equal(controller.getState().physicalEffects, 0);
  assert.equal(ids.history.children.length, 12);
});
