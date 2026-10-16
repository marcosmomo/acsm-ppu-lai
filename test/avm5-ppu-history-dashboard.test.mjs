import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import artifact from '../docs/experiments/avm4-cpslai1/ppu-evolution-history.json' with { type: 'json' };
import provenance from '../docs/experiments/avm4-cpslai1/provenance.json' with { type: 'json' };
import { renderE1OfflineHtml } from '../lib/evolution/e1OfflineDashboard.mjs';
import { renderAvm3VersionManagerHtml } from '../lib/evolution/avm3VersionManagerDashboard.mjs';
import { buildAvm5PpuHistoryViewModel, renderAvm5PpuHistoryHtml } from '../lib/evolution/avm5PpuHistoryDashboard.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidenceDir = path.join(root, 'docs', 'experiments', 'avm4-cpslai1');
const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('preserved AVM-4 evidence matches the recorded SHA-256 provenance', () => {
  for (const [file, expected] of Object.entries(provenance.files)) {
    assert.equal(hash(path.join(evidenceDir, file)), expected);
  }
  assert.equal(artifact.source.sha256, provenance.files['report.json']);
  assert.deepEqual(provenance.copyScope, ['report.json', 'summary.md', 'manifest.json']);
});

test('projection contains exactly the three documented cycles in order', () => {
  const model = buildAvm5PpuHistoryViewModel();
  assert.deepEqual(model.cycles.map((cycle) => cycle.sequence), [1, 2, 3]);
  assert.deepEqual(model.cycles.map((cycle) => cycle.aasVersion), ['v1', 'v2', 'v3']);
  assert.deepEqual(model.cycles.map((cycle) => cycle.evolution.status), ['BASELINE', 'CHANGED', 'CHANGED']);
  assert.deepEqual(model.cycles.map((cycle) => cycle.lifecycleState), ['CLOSED', 'CLOSED', 'ACTIVE']);
  assert.deepEqual(model.cycles.map((cycle) => cycle.profileStatus), ['PENDING_APPROVAL', 'PENDING_APPROVAL', 'PENDING_APPROVAL']);
  assert.equal(model.cycles.every((cycle) => cycle.playGate.allowed === false), true);
  assert.equal(model.cycles.every((cycle) => cycle.playGate.reason === 'GOVERNANCE_APPROVAL_REQUIRED'), true);
});

test('functional differences are copied without synthesizing results', () => {
  assert.deepEqual(artifact.cycles[0].evolution.differences, []);
  assert.deepEqual(artifact.cycles[1].evolution.differences.map((diff) => diff.type), ['CHANGED']);
  assert.deepEqual(artifact.cycles[1].evolution.differences[0].changedAttributes,
    [{ name: 'PieceAtMiddle', before: 'true', current: 'false' }]);
  assert.deepEqual(artifact.cycles[2].evolution.differences.map((diff) => diff.type), ['ADDED']);
  assert.equal(artifact.cycles[2].evolution.differences[0].capabilityCurrent, 'ExperimentalAdaptivePieceDetection');
  assert.equal(artifact.simulation, true);
  assert.equal(artifact.physicalValidationClaimed, false);
  assert.equal(artifact.operationalValidationClaimed, false);
});

test('combined page preserves E1 and AVM-3 and adds selectable AVM-5 history', () => {
  const html = renderAvm5PpuHistoryHtml(renderAvm3VersionManagerHtml(renderE1OfflineHtml()));
  assert.match(html, /Selecionar cenário E1/);
  assert.match(html, /AAS Version Manager — CPS-LAI-01/);
  assert.match(html, /PPU Evolution History — CPS-LAI-01/);
  assert.match(html, /OFFLINE SIMULATION/);
  assert.match(html, /Ciclo 1/);
  assert.match(html, /Ciclo 2/);
  assert.match(html, /Ciclo 3/);
  assert.match(html, /→ Unplug →/);
  assert.match(html, /id="avm5-cycle"/);
  assert.doesNotMatch(html, /fetch\s*\(|XMLHttpRequest|WebSocket|EventSource/i);
  assert.doesNotMatch(html, /Plug<\/button>|Play<\/button>|Unplug<\/button>|Approve<\/button>|Reject<\/button>/i);
});

test('HTTP route remains GET-only and imports no mutable or operational modules', () => {
  const route = fs.readFileSync(path.join(root, 'app', 'experiments', 'evolution', 'route.js'), 'utf8');
  assert.match(route, /export function GET\(\)/);
  assert.doesNotMatch(route, /export function (POST|PUT|PATCH|DELETE)\b/);
  assert.doesNotMatch(route, /CPSContext|governanceStore|TransactionalPlugUnplugOrchestrator|GovernanceRepository|EvolutionStore|ExperimentalAasSelectionStore/i);
});

test('read-only projection excludes stores and complete internal histories', () => {
  const serialized = JSON.stringify(artifact);
  assert.doesNotMatch(serialized, /governanceHistory|evolutionHistory|selectionHistory|authorityReceipt|authorizationId|rootDir|governance\.json|selection-store|evolution-store/i);
  assert.equal(artifact.source.kind, 'PRESERVED_AVM4_REPORT');
  assert.equal(artifact.generatedBy, 'scripts/experiments/build-avm5-ppu-history-artifact.mjs');
});
