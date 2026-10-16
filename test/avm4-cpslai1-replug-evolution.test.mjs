import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { AasArchive } from '../lib/evolution/aasArchive.mjs';
import { ExperimentalAasSelectionStore } from '../lib/evolution/experimentalAasSelectionStore.mjs';
import { EvolutionStore } from '../lib/evolution/evolutionStore.mjs';
import { GovernanceRepository } from '../lib/governance/governanceRepository.mjs';
import { runAvm4Experiment } from '../scripts/experiments/run-avm4-cpslai1-replug-evolution.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (filePath) => createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

async function isolated(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avm4-test-'));
  try {
    const result = await runAvm4Experiment({ rootDir: root });
    return await run({ root, ...result });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('three generated PPU cycles bind V1/V2/V3 to actual facade cycle and profile identities', () => isolated(({ report }) => {
  assert.equal(report.simulation, true);
  assert.equal(report.physicalValidationClaimed, false);
  assert.equal(report.operationalValidationClaimed, false);
  assert.equal(report.cycles.length, 3);
  assert.deepEqual(report.cycles.map((item) => item.aasVersion), ['v1', 'v2', 'v3']);
  assert.equal(new Set(report.cycles.map((item) => item.plugCycleId)).size, 3);
  assert.equal(new Set(report.cycles.map((item) => item.profileId)).size, 3);
  assert.deepEqual(report.cycles.map((item) => item.profileId), ['GOV-CPSLAI1-003', 'GOV-CPSLAI1-004', 'GOV-CPSLAI1-005']);
  assert.equal(report.cycles.every((item) => item.selectionOutcome === 'SELECTED' && item.selectionRetryOutcome === 'NO_OP'), true);
  assert.equal(report.cycles.every((item) => item.lifecycle.baseline.validation.status === 'PASS'), true);
  assert.equal(report.cycles.every((item) => item.lifecycle.confirmationLevel === 'BACKEND_ACCEPTED'), true);
}));

test('Evolution sequence and exact PieceDetection/experimental capability differences are preserved', () => isolated(({ report }) => {
  assert.deepEqual(report.cycles.map((item) => item.evolution.status), ['BASELINE', 'CHANGED', 'CHANGED']);
  assert.equal(report.cycles.every((item) => item.evolution.duplicateRetry === true), true);
  assert.deepEqual(report.cycles[1].evolution.differences, [{
    type: 'CHANGED',
    identity: 'semantic:GlobalReference:urn:ufsc:lai:experimental:capability:piece-detection:1',
    capabilityBefore: 'PieceDetection', capabilityCurrent: 'PieceDetection',
    changedAttributes: [{ name: 'PieceAtMiddle', before: 'true', current: 'false' }],
  }]);
  assert.equal(report.cycles[2].evolution.differences.length, 1);
  assert.equal(report.cycles[2].evolution.differences[0].type, 'ADDED');
  assert.equal(report.cycles[2].evolution.differences[0].capabilityCurrent, 'ExperimentalAdaptivePieceDetection');
}));

test('replug closes prior cycles, leaves cycle 3 active and never inherits approval', () => isolated(({ report }) => {
  assert.deepEqual(report.checks.finalCycleStates, ['CLOSED', 'CLOSED', 'ACTIVE']);
  assert.equal(report.checks.allProfilesPending, true);
  assert.equal(report.checks.noApprovalInherited, true);
  assert.equal(report.checks.initialApprovedProfilePreserved, true);
  assert.equal(report.checks.allPlayBlocked, true);
  assert.equal(report.cycles.every((item) => item.playGate.reason === 'GOVERNANCE_APPROVAL_REQUIRED'), true);
  assert.equal(report.cycles[0].delayedUnplugRetry.cycleState, 'CLOSED');
  assert.equal(report.cycles[0].delayedUnplugRetry.didNotCloseCurrentCycle, true);
}));

test('restart recovers governance, selections, Evolution history and all archived AAS bytes', () => isolated(async ({ root, report }) => {
  const governance = new GovernanceRepository({ filePath: path.join(root, 'governance', 'governance.json') }).read();
  const selections = await new ExperimentalAasSelectionStore({ filePath: path.join(root, 'selection', 'selection-store.json') }).inspect();
  const evolution = await new EvolutionStore({ filePath: path.join(root, 'evolution', 'evolution-store.json') }).inspect();
  const archive = new AasArchive({ rootDir: path.join(root, 'aas-archive') });
  assert.equal(Object.keys(governance.document.plugCycles).length, 3);
  assert.equal(Object.keys(selections.selections).length, 3);
  assert.equal(Object.keys(evolution.snapshots).length, 3);
  assert.equal(Object.keys(evolution.comparisons).length, 3);
  for (const cycle of report.cycles) {
    const bytes = await archive.getByHash(cycle.aasSha256);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), cycle.aasSha256);
  }
}));

test('same event cannot switch AAS after immutable selection', () => isolated(async ({ root, report }) => {
  const store = new ExperimentalAasSelectionStore({ filePath: path.join(root, 'selection', 'selection-store.json') });
  const first = report.cycles[0];
  await assert.rejects(store.requestSelection({
    cpsId: first.cpsId, plugEventId: first.plugEventId, plugCycleId: first.plugCycleId,
    profileId: first.profileId, aasVersion: 'v2', aasSha256: report.cycles[1].aasSha256,
  }), (error) => error.code === 'EXPERIMENTAL_SELECTION_CONFLICT');
  assert.equal((await store.inspect()).history.length, 3);
}));

test('activation and close interruptions recover from already persisted lifecycle evidence', () => isolated(({ report }) => {
  assert.equal(report.faultRecovery.activation.evidenceStoredBeforeRecovery, true);
  assert.equal(report.faultRecovery.activation.recoveredState, 'ACTIVE');
  assert.equal(report.faultRecovery.close.evidenceStoredBeforeRecovery, true);
  assert.equal(report.faultRecovery.close.recoveredState, 'CLOSED');
}));

test('report, summary and manifest are generated only in injected temporary root', () => isolated(({ root, report, manifest }) => {
  for (const name of ['report.json', 'summary.md', 'manifest.json']) assert.equal(fs.existsSync(path.join(root, name)), true);
  assert.equal(manifest.rootDir, root);
  assert.equal(manifest.generatedFiles.includes('report.json'), true);
  assert.equal(manifest.generatedFiles.includes('summary.md'), true);
  assert.equal(manifest.generatedFiles.includes('manifest.json'), true);
  assert.equal(report.rootDir, root);
}));

test('runner does not mutate operational or visual assets', async () => {
  const protectedPaths = [
    path.join(projectRoot, 'cps-defs', 'cps-lai-01-aas-acsm-compatible-revised.json'),
    ...['v1', 'v2', 'v3'].map((version) => path.join(projectRoot, 'cps-defs', 'evolution-experiments', 'cpslai1', `aas-${version}.json`)),
    path.join(projectRoot, 'services', 'governance', 'governanceStore.js'),
    path.join(projectRoot, 'context', 'CPSContext.js'),
    path.join(projectRoot, 'app', 'experiments', 'evolution', 'route.js'),
  ];
  const before = protectedPaths.map(sha256);
  await isolated(() => {});
  assert.deepEqual(protectedPaths.map(sha256), before);
});
