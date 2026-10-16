import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runIntEvo6OfflineCardDemo } from '../scripts/experiments/run-int-evo-6-offline-card.mjs';

test('four isolated cycles automatically project their verified bound AAS', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'int-evo-6-test-'));
  try {
    const { report } = await runIntEvo6OfflineCardDemo({ rootDir: root });
    assert.deepEqual(report.checks.evolutionSequence, ['BASELINE', 'NO_CHANGE', 'CHANGED', 'CHANGED']);
    assert.equal(report.checks.distinctCycleIds, 4);
    assert.equal(report.checks.distinctProfileIds, 4);
    assert.equal(report.checks.allCardsBoundToOneAas, true);
    assert.deepEqual(report.cycles.map((item) => item.card.aas.capabilities.length), [6, 6, 6, 7]);
    assert.deepEqual(report.cycles.map((item) => item.card.aas.version), ['v1', 'v1', 'v2', 'v3']);
    const v2Difference = report.cycles[2].evolution.differences.find((item) => item.type === 'CHANGED');
    assert.equal(v2Difference.current.name, 'PieceDetection');
    const v3Added = report.cycles[3].evolution.differences.find((item) => item.type === 'ADDED');
    assert.equal(v3Added.current.name, 'ExperimentalAdaptivePieceDetection');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('approval, unplug, operating mode and conflicts remain isolated', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'int-evo-6-test-'));
  try {
    const { report, files } = await runIntEvo6OfflineCardDemo({ rootDir: root });
    assert.equal(report.checks.allApprovalsExplicit, true);
    assert.equal(report.checks.noEvolutionOnUnplug, true);
    assert.equal(report.checks.operatingModeIndependent, true);
    assert.equal(report.checks.hashConflictState, 'UNBOUND');
    assert.equal(report.checks.profileConflictState, 'UNBOUND');
    assert.equal(report.cycles.every((item) => item.unplug.cycleState === 'CLOSED'), true);
    assert.equal(fs.existsSync(files.report), true);
    assert.match(fs.readFileSync(files.html, 'utf8'), /NO PHYSICAL EXECUTION/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('runner imports no operational route, context, transport or operational store', () => {
  const source = fs.readFileSync(path.resolve('scripts/experiments/run-int-evo-6-offline-card.mjs'), 'utf8');
  assert.doesNotMatch(source, /CPSContext|PlugFase|PlayFase|app\/api|governanceStore\.js|fetch\(|mqtt|opcua|mysql/i);
});
