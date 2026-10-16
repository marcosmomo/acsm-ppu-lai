import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AasArchive } from '../../lib/evolution/aasArchive.mjs';
import { createExperimentalAasResolver } from '../../lib/evolution/experimentalAasResolver.mjs';
import { ExperimentalAasSelectionStore } from '../../lib/evolution/experimentalAasSelectionStore.mjs';
import { coordinateAcceptedPlugEvolution } from '../../lib/evolution/evolutionCoordinator.mjs';
import { EvolutionStore } from '../../lib/evolution/evolutionStore.mjs';
import { GovernanceRepository } from '../../lib/governance/governanceRepository.mjs';
import { LifecycleEvidenceRepository } from '../../lib/governance/lifecycleEvidenceRepository.mjs';
import { LIFECYCLE_CONFIRMATION_LEVELS as LEVEL } from '../../lib/governance/lifecycleEvidence.mjs';
import { validateLifecycleBaseline } from '../../lib/governance/lifecycleBaseline.mjs';
import { TransactionalGovernanceAdapters } from '../../lib/governance/transactionalGovernanceAdapters.mjs';
import { TransactionalGovernanceFacade } from '../../lib/governance/transactionalGovernanceFacade.mjs';
import { TransactionalLifecycleAuthority } from '../../lib/governance/transactionalLifecycleAuthority.mjs';
import { TransactionalPlugUnplugOrchestrator } from '../../lib/governance/transactionalPlugUnplugOrchestrator.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const aasRoot = path.join(projectRoot, 'cps-defs');
const governanceFixture = path.join(projectRoot, 'test', 'fixtures', 'governance-repository', 'current-valid.json');
const fixedNow = '2026-10-14T20:00:00.000Z';
const now = () => fixedNow;
const authoritySource = Object.freeze({
  system: 'avm4-offline-fixture', component: 'transactional-lifecycle-authority', instanceId: 'avm4-isolated-1',
});
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const clone = (value) => structuredClone(value);

function authorityReceipt(permission) {
  return {
    verified: true,
    principal: { type: 'LIFECYCLE_AUTHORITY', ...authoritySource },
    authorizationId: 'avm4-simulated-server-authorization',
    scheme: 'AVM4_OFFLINE_FIXTURE_VERIFIER',
    claimsHash: 'avm4-fixture-claims',
    permission,
  };
}

function createGovernanceStack(filePath, { failActivationOnce = false, failCloseOnce = false } = {}) {
  const repository = new GovernanceRepository({ filePath });
  const facade = new TransactionalGovernanceFacade({ repository, now });
  const baseAdapters = new TransactionalGovernanceAdapters({ facade });
  const adapters = Object.create(baseAdapters);
  if (failActivationOnce) {
    let pending = true;
    adapters.activatePlugFromPersistedEvidence = (input) => {
      if (pending) { pending = false; throw new Error('AVM4_INJECTED_AFTER_PLUG_EVIDENCE'); }
      return baseAdapters.activatePlugFromPersistedEvidence(input);
    };
  }
  if (failCloseOnce) {
    let pending = true;
    adapters.closeUnplugFromPersistedEvidence = (input) => {
      if (pending) { pending = false; throw new Error('AVM4_INJECTED_AFTER_UNPLUG_EVIDENCE'); }
      return baseAdapters.closeUnplugFromPersistedEvidence(input);
    };
  }
  const lifecycleAuthority = new TransactionalLifecycleAuthority({
    repository, source: authoritySource, now, initialStateByCps: { cpslai1: 'idle' },
    verifyTransitionResult: (_result, { permission }) => authorityReceipt(permission),
  });
  const evidenceRepository = new LifecycleEvidenceRepository({
    repository, now,
    verifyEvidenceOrigin: (_evidence, { permission }) => authorityReceipt(permission),
    confirmationPolicy: { minimumConfirmationLevel: LEVEL.BACKEND_ACCEPTED },
    resolveExpectedPreviousState: (cycle, operation) => operation === 'PLUG'
      ? cycle.authoritativeLifecycleState || 'idle'
      : cycle.authoritativeLifecycleState || cycle.lifecycleEvidence?.PLUG?.evidence?.resultingState || null,
  });
  const orchestrator = new TransactionalPlugUnplugOrchestrator({ adapters, lifecycleAuthority, evidenceRepository });
  return { repository, facade, adapters, lifecycleAuthority, evidenceRepository, orchestrator };
}

function validatedBaseline(plug) {
  const evidencePayload = Buffer.from(JSON.stringify({
    fixture: 'AVM4_SIMULATED_LIFECYCLE_BASELINE', identity: {
      cpsId: plug.cpsId, plugEventId: plug.plugEventId,
      plugCycleId: plug.plugCycleId, profileId: plug.profileId,
    }, lifecycleEvidence: plug.lifecycle.evidence,
  }));
  const contentHash = sha256(evidencePayload);
  const baseline = {
    schemaVersion: '1.0', cpsId: plug.cpsId, plugEventId: plug.plugEventId,
    plugCycleId: plug.plugCycleId, profileId: plug.profileId,
    lifecycleState: plug.lifecycleState, governanceStatus: plug.governanceStatus,
    confirmationLevel: 'BACKEND_ACCEPTED', observedAt: fixedNow, verifiedAt: fixedNow,
    source: {
      system: 'avm4-offline-fixture', component: 'baseline-recorder',
      recordId: plug.lifecycle.evidence.evidenceId, domain: 'BACKEND_LOGICAL',
    },
    provenance: {
      kind: 'SIMULATED_AUTHENTICATED_FIXTURE', issuer: 'AVM4_OFFLINE_RUNNER',
      verificationId: `avm4-baseline-verification:${plug.plugCycleId}`,
    },
    evidenceReference: { recordId: `avm4-baseline:${plug.plugCycleId}`, sha256: contentHash },
    simulation: true,
  };
  const governance = {
    cpsId: plug.cpsId, plugEventId: plug.plugEventId, plugCycleId: plug.plugCycleId,
    profileId: plug.profileId, cycleState: plug.cycleState,
    governanceStatus: plug.governanceStatus, profilePlugCycleStatus: 'ACTIVE',
  };
  const validation = validateLifecycleBaseline(baseline, {
    expectedCpsId: plug.cpsId, governance, now: fixedNow, maxAgeMs: 0,
    trustedSources: [{
      system: baseline.source.system, component: baseline.source.component,
      domain: baseline.source.domain, provenanceKinds: [baseline.provenance.kind],
    }],
    verifyProvenance: () => ({
      verified: true, verificationId: baseline.provenance.verificationId,
      system: baseline.source.system, component: baseline.source.component, contentHash,
    }),
  });
  if (validation.status !== 'PASS') throw Object.assign(new Error('AVM-4 simulated baseline was not validated.'), { validation });
  return { baseline, validation, evidencePayloadSha256: contentHash };
}

function differenceSummary(difference) {
  const beforeAttributes = difference.before?.attributes || {};
  const currentAttributes = difference.current?.attributes || {};
  const changedAttributes = [];
  for (const name of new Set([...Object.keys(beforeAttributes), ...Object.keys(currentAttributes)])) {
    const before = beforeAttributes[name]?.value ?? null;
    const current = currentAttributes[name]?.value ?? null;
    if (before !== current) changedAttributes.push({ name, before, current });
  }
  return {
    type: difference.type, identity: difference.identity,
    capabilityBefore: difference.before?.name || null,
    capabilityCurrent: difference.current?.name || null,
    changedAttributes,
  };
}

async function runFaultRecoveryProbes(root) {
  const activationPath = path.join(root, 'fault-probes', 'activation-governance.json');
  fs.mkdirSync(path.dirname(activationPath), { recursive: true });
  fs.copyFileSync(governanceFixture, activationPath);
  const activation = createGovernanceStack(activationPath, { failActivationOnce: true });
  const plugInput = {
    cpsId: 'cpslai1', plugEventId: 'avm4-fault-activation',
    identity: { aasId: 'urn:ufsc:lai:ppu:cps-lai-01:aas', functionalVersion: 'v1', assetId: 'urn:ufsc:lai:asset:cps-lai-01:distribution-conveyor' },
  };
  let activationFailure;
  try { activation.orchestrator.plug(plugInput); } catch (error) { activationFailure = error.message; }
  const reservedCycle = Object.values(activation.repository.read().document.plugCycles).find((item) => item.plugEventId === plugInput.plugEventId);
  const evidenceStoredBeforeActivationRecovery = reservedCycle.state === 'RESERVED' && reservedCycle.lifecycleEvidence?.PLUG?.status === 'VALIDATED';
  const recoveredPlug = activation.orchestrator.plug(plugInput);

  const closePath = path.join(root, 'fault-probes', 'close-governance.json');
  fs.copyFileSync(governanceFixture, closePath);
  const close = createGovernanceStack(closePath, { failCloseOnce: true });
  const active = close.orchestrator.plug({ ...plugInput, plugEventId: 'avm4-fault-close' });
  let closeFailure;
  try { close.orchestrator.unplug(active); } catch (error) { closeFailure = error.message; }
  const beforeCloseRecovery = close.repository.read().document.plugCycles[active.plugCycleId];
  const evidenceStoredBeforeCloseRecovery = beforeCloseRecovery.state === 'ACTIVE' && beforeCloseRecovery.lifecycleEvidence?.UNPLUG?.status === 'VALIDATED';
  const recoveredClose = close.orchestrator.unplug(active);
  return {
    simulation: true,
    activation: { injectedFailure: activationFailure, evidenceStoredBeforeRecovery: evidenceStoredBeforeActivationRecovery, recoveredState: recoveredPlug.cycleState },
    close: { injectedFailure: closeFailure, evidenceStoredBeforeRecovery: evidenceStoredBeforeCloseRecovery, recoveredState: recoveredClose.cycleState },
  };
}

function summaryMarkdown(report) {
  const rows = report.cycles.map((cycle) =>
    `| ${cycle.sequence} | ${cycle.plugEventId} | ${cycle.plugCycleId} | ${cycle.profileId} | ${cycle.aasVersion.toUpperCase()} | ${cycle.evolution.status} | ${cycle.finalCycleState} | ${cycle.profileStatus} | ${cycle.playGate.reason} |`).join('\n');
  return `# AVM-4 — Replug offline com Evolution por ciclo\n\n` +
    `Simulação: **sim**. Validação física: **não alegada**. Validação operacional: **não alegada**.\n\n` +
    `| Ciclo | Evento | plugCycleId | profileId | AAS | Evolution | Estado final | Perfil | Play-gate |\n|---|---|---|---|---|---|---|---|---|\n${rows}\n\n` +
    `Todos os eventos lifecycle e autorizações são fixtures offline identificadas. Nenhum comando físico ou integração operacional foi executado.\n`;
}

function listFiles(root) {
  const result = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const item = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(item); else result.push(path.relative(root, item).replaceAll('\\', '/'));
    }
  };
  visit(root);
  return result.sort();
}

export async function runAvm4Experiment({ rootDir = null } = {}) {
  const root = rootDir ? path.resolve(rootDir) : fs.mkdtempSync(path.join(os.tmpdir(), 'acsm-avm4-cpslai1-'));
  fs.mkdirSync(root, { recursive: true });
  const governancePath = path.join(root, 'governance', 'governance.json');
  fs.mkdirSync(path.dirname(governancePath), { recursive: true });
  fs.copyFileSync(governanceFixture, governancePath);
  const governance = createGovernanceStack(governancePath);
  const resolver = createExperimentalAasResolver({ rootDir: aasRoot });
  const archive = new AasArchive({ rootDir: path.join(root, 'aas-archive') });
  const evolution = new EvolutionStore({ filePath: path.join(root, 'evolution', 'evolution-store.json'), now });
  const selections = new ExperimentalAasSelectionStore({ filePath: path.join(root, 'selection', 'selection-store.json'), now: () => new Date(fixedNow) });
  const initialGovernance = clone(governance.repository.read().document);
  const cycles = [];

  for (const [index, version] of ['v1', 'v2', 'v3'].entries()) {
    const sequence = index + 1;
    const resolved = await resolver.resolve({ cpsId: 'cpslai1', aasVersion: version });
    const plugInput = {
      cpsId: 'cpslai1', plugEventId: `avm4-plug-${version}`,
      identity: { aasId: resolved.identity.aasId, functionalVersion: version, assetId: resolved.identity.assetId },
    };
    const plug = governance.orchestrator.plug(plugInput);
    const plugRetry = governance.orchestrator.plug(plugInput);
    const baseline = validatedBaseline(plug);
    const selectionInput = {
      cpsId: plug.cpsId, plugEventId: plug.plugEventId, plugCycleId: plug.plugCycleId,
      profileId: plug.profileId, aasVersion: version, aasSha256: resolved.integrity.contentHash,
    };
    const selection = await selections.requestSelection(selectionInput);
    const selectionRetry = await selections.requestSelection(selectionInput);
    const archived = await archive.archive({ bytes: resolved.rawBytes, expectedHash: resolved.integrity.contentHash });
    const resolvedAas = {
      ...resolved, archiveReference: archived, evidenceScope: 'OFFLINE_DOCUMENTAL_AAS', resolvedAt: fixedNow,
      resolvedReference: { contentHash: resolved.integrity.contentHash, archiveReference: archived.reference },
    };
    const evolutionInput = {
      cpsId: plug.cpsId, plugEventId: plug.plugEventId, plugCycleId: plug.plugCycleId,
      aas: resolved.document, resolvedAas, store: evolution, plugAccepted: true,
      capturedAt: new Date(fixedNow), provenance: { experiment: 'AVM-4', simulation: true, operational: false },
    };
    const evolutionResult = await coordinateAcceptedPlugEvolution(evolutionInput);
    const evolutionRetry = await coordinateAcceptedPlugEvolution(evolutionInput);
    const playGate = governance.adapters.projectPlayGate({
      cpsId: plug.cpsId, profileId: plug.profileId, plugCycleId: plug.plugCycleId, lifecyclePhase: 'play',
    });
    cycles.push({
      sequence, cpsId: plug.cpsId, plugEventId: plug.plugEventId,
      plugCycleId: plug.plugCycleId, profileId: plug.profileId,
      aasVersion: version, aasSha256: resolved.integrity.contentHash,
      functionalHash: evolutionResult.functionalHash,
      selectionId: selection.selection.selectionId,
      selectionOutcome: selection.outcome, selectionRetryOutcome: selectionRetry.outcome,
      evolution: {
        status: evolutionResult.status, duplicateRetry: evolutionRetry.duplicate,
        snapshotId: evolutionResult.snapshotId, comparisonId: evolutionResult.comparisonId,
        previousSnapshotId: evolutionResult.previousSnapshotId,
        differences: evolutionResult.differences.map(differenceSummary),
      },
      archive: { contentHash: archived.contentHash, reference: archived.reference },
      lifecycle: {
        plug: clone(plug.lifecycle), baseline: clone(baseline), unplug: null,
        simulation: true, confirmationLevel: plug.confirmationLevel,
      },
      plugRetry: { sameCycle: plugRetry.plugCycleId === plug.plugCycleId, sameProfile: plugRetry.profileId === plug.profileId },
      profileStatus: plug.governanceStatus,
      playGate,
      unplug: null,
      finalCycleState: plug.cycleState,
    });
    if (version === 'v2') {
      const delayed = governance.orchestrator.unplug({
        cpsId: cycles[0].cpsId, plugEventId: cycles[0].plugEventId,
        plugCycleId: cycles[0].plugCycleId, profileId: cycles[0].profileId,
      });
      cycles[0].delayedUnplugRetry = { cycleState: delayed.cycleState, didNotCloseCurrentCycle: governance.repository.read().document.plugCycles[plug.plugCycleId].state === 'ACTIVE' };
    }
    if (version !== 'v3') {
      const unplug = governance.orchestrator.unplug(plug);
      cycles.at(-1).unplug = {
        cycleState: unplug.cycleState, governanceStatus: unplug.governanceStatus,
        confirmationLevel: unplug.confirmationLevel, lifecycle: clone(unplug.lifecycle),
      };
      cycles.at(-1).lifecycle.unplug = clone(unplug.lifecycle);
      cycles.at(-1).finalCycleState = unplug.cycleState;
    }
  }

  const finalGovernance = governance.repository.read();
  for (const cycle of cycles) cycle.finalCycleState = finalGovernance.document.plugCycles[cycle.plugCycleId].state;
  const evolutionDocument = await evolution.inspect();
  const selectionDocument = await selections.inspect();
  const faultRecovery = await runFaultRecoveryProbes(root);
  const archivedRecoverable = {};
  for (const cycle of cycles) archivedRecoverable[cycle.aasVersion] = sha256(await archive.getByHash(cycle.aasSha256)) === cycle.aasSha256;
  const report = {
    schemaVersion: 'AVM-4-report/1.0', experiment: 'AVM-4', generatedAt: fixedNow,
    simulation: true, physicalValidationClaimed: false, operationalValidationClaimed: false,
    rootDir: root,
    fixtures: {
      governanceSeed: 'test/fixtures/governance-repository/current-valid.json',
      lifecycleAuthority: authoritySource, baselineProvenanceKind: 'SIMULATED_AUTHENTICATED_FIXTURE',
    },
    cycles,
    checks: {
      distinctCycles: new Set(cycles.map((item) => item.plugCycleId)).size === 3,
      distinctProfiles: new Set(cycles.map((item) => item.profileId)).size === 3,
      evolutionSequence: cycles.map((item) => item.evolution.status),
      finalCycleStates: cycles.map((item) => item.finalCycleState),
      allProfilesPending: cycles.every((item) => item.profileStatus === 'PENDING_APPROVAL'),
      allPlayBlocked: cycles.every((item) => item.playGate.ok === false && item.playGate.reason === 'GOVERNANCE_APPROVAL_REQUIRED'),
      noApprovalInherited: cycles.every((item) => item.profileStatus === 'PENDING_APPROVAL'),
      archivedRecoverable,
      initialApprovedProfilePreserved: initialGovernance.profileVersions.cpslai1[0].status === 'APPROVED' &&
        finalGovernance.document.profileVersions.cpslai1[0].status === 'APPROVED',
      selectionCount: Object.keys(selectionDocument.selections).length,
      snapshotCount: Object.keys(evolutionDocument.snapshots).length,
      comparisonCount: Object.keys(evolutionDocument.comparisons).length,
      governanceRevision: finalGovernance.revision,
    },
    faultRecovery,
    governanceHistory: finalGovernance.document.history,
    evolutionHistory: Object.values(evolutionDocument.comparisons),
    selectionHistory: selectionDocument.history,
  };
  fs.writeFileSync(path.join(root, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'summary.md'), summaryMarkdown(report));
  const manifest = {
    schemaVersion: 'AVM-4-manifest/1.0', experiment: 'AVM-4', simulation: true,
    rootDir: root, generatedFiles: [...listFiles(root), 'manifest.json'].sort(),
  };
  fs.writeFileSync(path.join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { rootDir: root, report, manifest };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const result = await runAvm4Experiment();
  process.stdout.write(`${JSON.stringify({ rootDir: result.rootDir, report: path.join(result.rootDir, 'report.json'), summary: path.join(result.rootDir, 'summary.md'), manifest: path.join(result.rootDir, 'manifest.json') }, null, 2)}\n`);
}
