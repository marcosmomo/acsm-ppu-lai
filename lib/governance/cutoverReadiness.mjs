import fs from 'node:fs';
import path from 'node:path';
import { LEGACY_GOVERNANCE_ACCESS_INVENTORY } from './legacyGovernanceInventory.mjs';

export const CUTOVER_INTEGRATION_MATRIX = Object.freeze([
  { id: 'plug', modules: ['app/api/acsm/plug/route.js', 'lib/acsm/plugPostHandler.mjs'], legacy: ['createGovernanceProfileForPlug', 'enqueuePpuOutboxEvent'], target: 'reservePlug -> lifecycle effect -> activatePlug/recordPlugFailure', type: 'writer' },
  { id: 'unplug', modules: ['app/api/acsm/plug/route.js', 'lib/acsm/plugPostHandler.mjs', 'lib/acsm/unplugLifecycle.mjs'], legacy: ['closeGovernancePlugCycle'], target: 'prepareUnplug -> correlated evidence -> closeUnplug', type: 'writer' },
  { id: 'snapshot-close', modules: ['lib/acsm/plugPostHandler.mjs'], legacy: ['closeGovernancePlugCycle(cpsId)'], target: 'remove CPS-only close; require correlated Unplug command', type: 'writer' },
  { id: 'profile-decisions', modules: ['app/api/governance/cps/[cpsId]/approve/route.js', 'app/api/governance/cps/[cpsId]/reject/route.js'], legacy: ['approveGovernanceProfile', 'rejectGovernanceProfile'], target: 'CAS decision + trusted server authorization', type: 'writer' },
  { id: 'policies', modules: ['app/api/governance/cps/[cpsId]/route.js'], legacy: ['updateGovernanceProfile'], target: 'updatePolicies with cycle/profile CAS', type: 'writer' },
  { id: 'governed-actions', modules: ['app/api/governance/check/route.js', 'app/api/governance/action/[actionId]/approve/route.js', 'app/api/governance/action/[actionId]/reject/route.js'], legacy: ['checkGovernance', 'decideGovernanceAction'], target: 'persist decision/effectIntent; execute after commit', type: 'writer' },
  { id: 'ppu-outbox', modules: ['app/api/acsm/plug/route.js', 'lib/acsm/plugPostHandler.mjs', 'services/governance/governanceStore.js'], legacy: ['enqueuePpuOutboxEvent', 'markPpuOutboxEventPublished', 'markPpuOutboxEventFailed'], target: 'Repository outbox + publicationId/attemptId', type: 'writer' },
  { id: 'profile-queries', modules: ['app/api/governance/cps/[cpsId]/route.js', 'app/api/governance/cps/[cpsId]/profile/route.js', 'lib/acsm/plugStore.mjs'], legacy: ['getGovernanceProfile', 'ensureGovernanceProfile', 'getActiveGovernanceProfile'], target: 'getProfile/correlated projection', type: 'reader' },
  { id: 'play-gate', modules: ['app/api/governance/cps/[cpsId]/play-gate/route.js'], legacy: ['getGovernanceProfile'], target: 'projectPlayGate requiring ACTIVE + APPROVED + compatible phase', type: 'reader' },
  { id: 'ui-consumers', modules: ['context/CPSContext.js'], legacy: ['governance HTTP contracts'], target: 'preserve response compatibility; no direct Store access', type: 'client' },
]);

const finding = (id, status, message, details = {}) => ({ id, status, message, details });

export function evaluateCutoverReadiness({ projectRoot, activeProfiles = [], validations = {}, dependencies = {}, readFileSync = fs.readFileSync } = {}) {
  if (!projectRoot || !path.isAbsolute(projectRoot)) throw new Error('projectRoot must be absolute.');
  const findings = [];
  const modules = CUTOVER_INTEGRATION_MATRIX.flatMap((row) => row.modules).filter((file, index, all) => all.indexOf(file) === index);
  const missingModules = modules.filter((file) => { try { readFileSync(path.join(projectRoot, file), 'utf8'); return false; } catch { return true; } });
  findings.push(missingModules.length
    ? finding('integration-inventory', 'FAIL', 'Integration matrix references missing modules.', { missingModules })
    : finding('integration-inventory', 'PASS', 'All inventoried integration modules exist.'));

  const handler = readFileSync(path.join(projectRoot, 'lib/acsm/plugPostHandler.mjs'), 'utf8');
  findings.push(/closeGovernancePlugCycle\s*\(\s*cpsId\s*\)/.test(handler)
    ? finding('cps-only-close', 'FAIL', 'Legacy snapshot import still closes governance using only cpsId.')
    : finding('cps-only-close', 'PASS', 'No CPS-only close path was detected.'));

  const expected = new Map([
    ['cpslai1', ['GOV-CPSLAI1-215', 'cpslai1-plug-v215']],
    ['cpslai2', ['GOV-CPSLAI2-103', 'cpslai2-plug-v103']],
    ['cpslai3', ['GOV-CPSLAI3-113', 'cpslai3-plug-v113']],
  ]);
  const incompatible = [...expected].filter(([cpsId, ids]) => {
    const profile = activeProfiles.find((item) => item.cpsId === cpsId);
    return !profile || profile.profileId !== ids[0] || profile.plugCycleId !== ids[1] || !profile.plugEventId || !Number.isSafeInteger(profile.profileVersion);
  });
  findings.push(incompatible.length
    ? finding('active-profile-correlation', 'FAIL', 'Active profile correlation is incomplete or divergent.', { cpsIds: incompatible.map(([cpsId]) => cpsId) })
    : finding('active-profile-correlation', 'PASS', 'All three active profiles have complete correlated identity.'));

  for (const [key, label] of Object.entries({ historicalPreservation: 'Historical preservation', retries: 'Retry behavior', concurrency: 'Multiprocess concurrency', corruption: 'Corruption handling', rollback: 'Rollback behavior', migrationSimulation: 'Migration simulation' })) {
    findings.push(validations[key] === true ? finding(`validation-${key}`, 'PASS', `${label} is validated.`) : finding(`validation-${key}`, 'BLOCKED', `${label} has no accepted evidence for this readiness run.`));
  }
  for (const [key, label] of Object.entries({ writersSuspension: 'Operational writer suspension', serverAuthentication: 'Server-side authentication', lifecycleEvidenceAuthority: 'Authoritative lifecycle evidence', effectDispatcher: 'Post-commit effect dispatcher', localFilesystemTopology: 'Single-host/local-filesystem topology', verifiedOperationalBackup: 'Verified operational backup and restore rehearsal' })) {
    findings.push(dependencies[key] === true ? finding(`dependency-${key}`, 'PASS', `${label} is available.`) : finding(`dependency-${key}`, 'BLOCKED', `${label} is still required.`));
  }
  const legacyWriterRows = LEGACY_GOVERNANCE_ACCESS_INVENTORY.filter((item) => item.kind === 'writer');
  findings.push(legacyWriterRows.length >= 10
    ? finding('legacy-writer-coverage', 'PASS', 'Legacy writer inventory covers all known writer concerns.', { count: legacyWriterRows.length })
    : finding('legacy-writer-coverage', 'FAIL', 'Legacy writer inventory is incomplete.', { count: legacyWriterRows.length }));

  const counts = { PASS: 0, FAIL: 0, BLOCKED: 0 };
  for (const item of findings) counts[item.status] += 1;
  return { status: counts.FAIL ? 'FAIL' : counts.BLOCKED ? 'BLOCKED' : 'PASS', counts, findings, matrix: CUTOVER_INTEGRATION_MATRIX };
}
