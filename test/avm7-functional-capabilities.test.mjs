import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import artifact from '../docs/experiments/avm7-cpslai1-functional-projection.json' with { type: 'json' };
import { buildAvm7FunctionalProjection } from '../scripts/experiments/build-avm7-functional-projection.mjs';
import { buildPpuSimulationModel } from '../lib/evolution/ppuEvolutionSimulation.mjs';
import { installPpuEvolutionSimulation } from '../lib/evolution/ppuEvolutionSimulationClient.mjs';

const version = (name) => artifact.versions.find((item) => item.version === name);
const capability = (name, capabilityName) => version(name).capabilities.find((item) => item.name === capabilityName);

class Element {
  constructor(id = '', phase = null) { this.id = id; this.value = ''; this.textContent = ''; this.children = []; this.dataset = phase ? { phase } : {}; this.listeners = {}; this.className = ''; this.classList = { toggle() {} }; }
  addEventListener(type, handler) { this.listeners[type] = handler; }
  click() { this.listeners.click?.({ target: this }); }
  change() { this.listeners.change?.({ target: this }); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
}

function dom() {
  const names = ['status', 'active', 'history', 'version', 'plug', 'approve', 'play', 'unplug', 'functional', 'functional-context', 'functional-history'];
  const ids = Object.fromEntries(names.map((id) => [id, new Element(id)]));
  ids.version.value = 'v1'; ids.model = new Element('model'); ids.model.textContent = JSON.stringify(buildPpuSimulationModel());
  const document = { getElementById: (id) => ids[id], querySelectorAll: () => [], createElement: () => new Element(), createTextNode: (textContent) => ({ textContent }) };
  return { document, ids };
}

function allText(element) { return [element.textContent, ...element.children.flatMap((child) => allText(child))].join(' '); }

test('offline artifact is reproducible through resolver and extractor', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avm7-projection-'));
  try {
    const generated = await buildAvm7FunctionalProjection({ outputPath: path.join(root, 'projection.json') });
    assert.deepEqual(generated, artifact);
    assert.equal(generated.operationalDataIncluded, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('V1 V2 V3 preserve real declarations and PieceDetection support semantics', () => {
  assert.deepEqual(artifact.versions.map((item) => item.capabilities.length), [6, 6, 7]);
  assert.deepEqual(artifact.versions.map((item) => item.services.length), [13, 13, 13]);
  assert.equal(capability('v1', 'PieceDetection').attributes.PieceAtMiddle.value, 'true');
  assert.equal(capability('v2', 'PieceDetection').attributes.PieceAtMiddle.value, 'false');
  assert.equal(capability('v3', 'PieceDetection').attributes.PieceAtMiddle.value, 'false');
  assert.equal(capability('v1', 'PieceDetection').attributes.PieceAtEntry.value, 'true');
  assert.equal(capability('v3', 'PieceDetection').attributes.PieceAtExit.value, 'true');
  assert.equal(Boolean(capability('v1', 'ExperimentalAdaptivePieceDetection')), false);
  assert.equal(Boolean(capability('v2', 'ExperimentalAdaptivePieceDetection')), false);
  assert.equal(capability('v3', 'ExperimentalAdaptivePieceDetection').experimental, true);
});

test('functional card previews selection, freezes active version and preserves closed history', () => {
  const { document, ids } = dom();
  const controller = installPpuEvolutionSimulation(document);
  assert.match(ids['functional-context'].textContent, /Prévia.*V1/);
  assert.match(allText(ids.functional), /PieceAtMiddle: true/);
  ids.plug.click();
  assert.equal(ids.version.value, 'v2');
  assert.match(ids['functional-context'].textContent, /Ciclo ativo congelado em V1.*Próximo Plug selecionado: V2/);
  assert.match(allText(ids.functional), /PieceAtMiddle: true/);
  ids.approve.click(); ids.play.click();
  assert.match(ids['functional-context'].textContent, /congelado em V1/);
  ids.unplug.click();
  assert.match(ids['functional-context'].textContent, /Histórico da sessão · V1/);
  assert.equal(ids['functional-history'].children.length, 1);
  ids.version.change();
  assert.match(ids['functional-context'].textContent, /Prévia.*V2/);
  assert.match(allText(ids.functional), /PieceAtMiddle: false/);
  ids.plug.click(); ids.approve.click(); ids.play.click(); ids.unplug.click();
  ids.version.value = 'v3'; ids.version.change(); ids.plug.click();
  assert.match(allText(ids.functional), /ExperimentalAdaptivePieceDetection · EXPERIMENTAL/);
  assert.equal(controller.getState().active.aasVersion, 'v3');
  assert.equal(controller.getState().physicalEffects, 0);
});
