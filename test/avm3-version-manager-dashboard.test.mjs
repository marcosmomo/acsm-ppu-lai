import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import artifact from '../docs/experiments/avm3-cpslai1-version-manager.json' with { type: 'json' };
import { CPSLAI1_EXPERIMENTAL_AAS_CATALOG } from '../lib/evolution/experimentalAasCatalog.mjs';
import {
  buildAvm3VersionManagerViewModel, renderAvm3VersionManagerHtml,
} from '../lib/evolution/avm3VersionManagerDashboard.mjs';
import { renderE1OfflineHtml } from '../lib/evolution/e1OfflineDashboard.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const routePath = path.join(projectRoot, 'app', 'experiments', 'evolution', 'route.js');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('artifact renders V1, V2 and V3 with hashes verified against catalog and bytes', () => {
  const model = buildAvm3VersionManagerViewModel();
  assert.deepEqual(Object.keys(model.versions), ['v1', 'v2', 'v3']);
  for (const version of ['v1', 'v2', 'v3']) {
    const catalog = CPSLAI1_EXPERIMENTAL_AAS_CATALOG.cps.cpslai1.versions[version];
    const bytes = fs.readFileSync(path.join(projectRoot, 'cps-defs', catalog.relativePath));
    assert.equal(model.versions[version].aasSha256, sha256(bytes));
    assert.equal(model.versions[version].aasSha256, catalog.sha256);
    assert.equal(model.versions[version].aasId, catalog.aasId);
    assert.equal(model.versions[version].assetId, catalog.assetId);
    assert.equal(model.versions[version].capabilities.length >= 6, true);
  }
});

test('artifact contains comparator-derived baseline, direct and accumulated comparisons', () => {
  const byId = Object.fromEntries(artifact.comparisons.map((item) => [item.id, item]));
  assert.equal(byId['baseline-v1'].status, 'BASELINE');
  assert.deepEqual(byId['v1-v2'].differences.map((item) => item.type), ['CHANGED']);
  assert.deepEqual(byId['v1-v2'].differences[0].changedAttributes,
    [{ name: 'PieceAtMiddle', before: 'true', current: 'false' }]);
  assert.deepEqual(byId['v2-v3'].differences.map((item) => item.type), ['ADDED']);
  assert.equal(byId['v2-v3'].differences[0].capabilityCurrent, 'ExperimentalAdaptivePieceDetection');
  assert.deepEqual(byId['v1-v3'].differences.map((item) => item.type).sort(), ['ADDED', 'CHANGED']);
  assert.equal(byId['v1-v3'].differences.some((item) => item.capabilityCurrent === 'PieceDetection'), true);
  assert.equal(byId['v1-v3'].differences.some((item) => item.capabilityCurrent === 'ExperimentalAdaptivePieceDetection'), true);
});

test('AVM preview is explicitly unbound and contains no invented lifecycle or governance values', () => {
  const model = buildAvm3VersionManagerViewModel();
  assert.deepEqual(model.previewBinding, {
    status: 'PREVIEW_NOT_BOUND_TO_PLUG_CYCLE', plugEventId: null, plugCycleId: null,
    profileId: null, selectionId: null,
  });
  assert.equal(model.physicalValidationClaimed, false);
  assert.equal('governance' in model, false);
  assert.equal('selection' in model, false);
  assert.doesNotMatch(JSON.stringify(model), /PENDING_APPROVAL|APPROVED|REJECTED/);
});

test('composed page preserves E1 panel and adds interactive read-only Version Manager', () => {
  const e1 = renderE1OfflineHtml();
  const html = renderAvm3VersionManagerHtml(e1);
  for (const marker of [
    'Selecionar cenário E1', 'E1.8-plug-replug', 'Referência da AAS V1 extraída',
  ]) assert.match(html, new RegExp(marker));
  assert.match(html, /AAS Version Manager — CPS-LAI-01/);
  assert.match(html, /OFFLINE EXPERIMENT — DOCUMENTAL AAS — NO PHYSICAL VALIDATION/);
  assert.match(html, /PREVIEW — NOT BOUND TO PLUG CYCLE/);
  assert.match(html, /value="v1"/);
  assert.match(html, /value="v2"/);
  assert.match(html, /value="v3"/);
  assert.match(html, /value="v1-v3"/);
  assert.match(html, /addEventListener\('change'/);
  assert.doesNotMatch(html, /<button\b|<form\b|fetch\s*\(|XMLHttpRequest|WebSocket|EventSource/i);
});

test('route remains GET-only and has no operational or mutable selection imports', () => {
  const route = fs.readFileSync(routePath, 'utf8');
  assert.match(route, /export function GET\(\)/);
  assert.doesNotMatch(route, /export function (POST|PUT|PATCH|DELETE)\b/);
  assert.doesNotMatch(route, /CPSContext|governanceStore|experimentalAasSelectionStore|EvolutionStore|AasArchive/i);
  const routeFiles = fs.readdirSync(path.dirname(routePath));
  assert.deepEqual(routeFiles, ['route.js']);
});

test('offline artifact is sanitized and contains no operational store or governance document', () => {
  const serialized = JSON.stringify(artifact);
  assert.doesNotMatch(serialized, /governanceStore|profileVersions|plugCycles|mysql|mqtt|opcua|localhost/i);
  assert.equal(artifact.generatedBy, 'scripts/experiments/build-avm3-version-manager-artifact.mjs');
  assert.equal(artifact.evidenceScope, 'OFFLINE_DOCUMENTAL_AAS');
});
