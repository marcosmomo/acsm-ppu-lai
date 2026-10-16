import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const evidenceDir = path.join(projectRoot, 'docs', 'experiments', 'avm4-cpslai1');
const reportPath = path.join(evidenceDir, 'report.json');
const outputPath = path.join(evidenceDir, 'ppu-evolution-history.json');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const bytes = fs.readFileSync(reportPath);
const report = JSON.parse(bytes);

if (report.schemaVersion !== 'AVM-4-report/1.0' || report.experiment !== 'AVM-4') {
  throw new Error('Unsupported AVM-4 report identity.');
}
if (report.simulation !== true || report.physicalValidationClaimed !== false
  || report.operationalValidationClaimed !== false) {
  throw new Error('AVM-4 evidence must remain explicitly offline and simulated.');
}
if (!Array.isArray(report.cycles) || report.cycles.length !== 3) {
  throw new Error('AVM-5 requires the three documented AVM-4 cycles.');
}

const reference = (entry) => entry ? {
  evidenceId: entry.evidence?.evidenceId ?? null,
  transitionId: entry.transition?.transitionId ?? null,
  confirmationLevel: entry.evidence?.confirmationLevel ?? null,
  recordId: entry.evidence?.evidenceReference?.recordId ?? null,
  contentHash: entry.evidence?.evidenceReference?.contentHash ?? null,
} : null;

const artifact = {
  schemaVersion: 'AVM-5-ppu-history/1.0',
  experiment: 'AVM-5',
  cpsId: 'cpslai1',
  title: 'PPU Evolution History — CPS-LAI-01',
  scope: 'OFFLINE_SIMULATION',
  simulation: report.simulation,
  physicalValidationClaimed: report.physicalValidationClaimed,
  operationalValidationClaimed: report.operationalValidationClaimed,
  source: {
    kind: 'PRESERVED_AVM4_REPORT',
    relativePath: 'docs/experiments/avm4-cpslai1/report.json',
    schemaVersion: report.schemaVersion,
    generatedAt: report.generatedAt,
    sha256: sha256(bytes),
  },
  generatedBy: 'scripts/experiments/build-avm5-ppu-history-artifact.mjs',
  cycles: report.cycles.map((cycle) => ({
    sequence: cycle.sequence,
    cpsId: cycle.cpsId,
    plugEventId: cycle.plugEventId,
    plugCycleId: cycle.plugCycleId,
    profileId: cycle.profileId,
    aasVersion: cycle.aasVersion,
    aasSha256: cycle.aasSha256,
    functionalHash: cycle.functionalHash,
    evolution: {
      status: cycle.evolution?.status ?? null,
      differences: cycle.evolution?.differences ?? [],
    },
    lifecycleState: cycle.finalCycleState ?? null,
    profileStatus: cycle.profileStatus ?? null,
    playGate: {
      allowed: cycle.playGate?.ok ?? null,
      reason: cycle.playGate?.reason ?? null,
    },
    references: {
      snapshotId: cycle.evolution?.snapshotId ?? null,
      previousSnapshotId: cycle.evolution?.previousSnapshotId ?? null,
      comparisonId: cycle.evolution?.comparisonId ?? null,
      archive: cycle.archive?.reference ?? null,
      baseline: cycle.lifecycle?.baseline?.baseline?.evidenceReference ?? null,
      plug: reference(cycle.lifecycle?.plug),
      unplug: reference(cycle.lifecycle?.unplug),
    },
  })),
};

fs.writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: 'utf8', flag: 'w' });
console.log(JSON.stringify({ outputPath, sourceSha256: artifact.source.sha256, cycles: artifact.cycles.length }));
