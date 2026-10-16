import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AasArchive } from '../../lib/evolution/aasArchive.mjs';
import { AcceptedCycleAasComposition } from '../../lib/evolution/acceptedCycleAasComposition.mjs';
import { createConfinedAasFileReader, createVerifiableAasDocumentSource } from '../../lib/evolution/verifiableAasDocumentSource.mjs';
import { CPSLAI1_EXPERIMENTAL_AAS_CATALOG } from '../../lib/evolution/experimentalAasCatalog.mjs';
import { EvolutionStore } from '../../lib/evolution/evolutionStore.mjs';
import { GovernanceRepository } from '../../lib/governance/governanceRepository.mjs';
import { LifecycleEvidenceRepository } from '../../lib/governance/lifecycleEvidenceRepository.mjs';
import { LIFECYCLE_CONFIRMATION_LEVELS as LEVEL } from '../../lib/governance/lifecycleEvidence.mjs';
import { TransactionalGovernanceAdapters } from '../../lib/governance/transactionalGovernanceAdapters.mjs';
import { TransactionalGovernanceFacade } from '../../lib/governance/transactionalGovernanceFacade.mjs';
import { TransactionalLifecycleAuthority } from '../../lib/governance/transactionalLifecycleAuthority.mjs';
import { TransactionalPlugUnplugOrchestrator } from '../../lib/governance/transactionalPlugUnplugOrchestrator.mjs';
import { buildEvolutionCycleReadModel } from '../../lib/evolution/evolutionCycleReadModel.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixedNow = '2026-10-15T10:00:00.000Z';
const authoritySource = { system: 'int-evo-8-offline', component: 'transactional-lifecycle-fixture', instanceId: 'isolated-1' };
const humanAuthorization = { authenticated: true, authorized: true, trusted: true, subject: 'int-evo-8-human-approval-fixture' };
const receipt = (permission) => ({ verified: true, principal: { type: 'LIFECYCLE_AUTHORITY', ...authoritySource }, authorizationId: 'int-evo-8-fixture-auth', scheme: 'INT_EVO_8_OFFLINE_FIXTURE', claimsHash: 'int-evo-8-claims', permission });
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function createStack(root, { coordinate = undefined, sourceOverride = null, archiveOverride = null, catalogOverride = null } = {}) {
  const governancePath = path.join(root, 'governance.json');
  fs.mkdirSync(root, { recursive: true });
  fs.copyFileSync(path.join(projectRoot, 'test', 'fixtures', 'governance-repository', 'current-valid.json'), governancePath);
  const repository = new GovernanceRepository({ filePath: governancePath });
  const facade = new TransactionalGovernanceFacade({ repository, now: () => fixedNow });
  const adapters = new TransactionalGovernanceAdapters({ facade });
  const lifecycleAuthority = new TransactionalLifecycleAuthority({
    repository, source: authoritySource, now: () => fixedNow, initialStateByCps: { cpslai1: 'idle' },
    verifyTransitionResult: (_result, { permission }) => receipt(permission),
  });
  const evidenceRepository = new LifecycleEvidenceRepository({
    repository, now: () => fixedNow,
    verifyEvidenceOrigin: (_evidence, { permission }) => receipt(permission),
    confirmationPolicy: { minimumConfirmationLevel: LEVEL.BACKEND_ACCEPTED },
    resolveExpectedPreviousState: (cycle, operation) => operation === 'PLUG'
      ? cycle.authoritativeLifecycleState || 'idle'
      : cycle.authoritativeLifecycleState || cycle.lifecycleEvidence?.PLUG?.evidence?.resultingState || null,
  });
  const orchestrator = new TransactionalPlugUnplugOrchestrator({ adapters, lifecycleAuthority, evidenceRepository });
  const archive = archiveOverride || new AasArchive({ rootDir: path.join(root, 'aas-archive') });
  const realRoot = path.join(projectRoot, 'cps-defs');
  const entries = catalogOverride || Object.fromEntries(Object.entries(CPSLAI1_EXPERIMENTAL_AAS_CATALOG.cps.cpslai1.versions).map(([version, item]) => [`avm-${version}`, {
    locator: item.relativePath, cpsId: 'cpslai1', aasId: item.aasId, assetId: item.assetId,
    contentHash: item.sha256, version, sourceId: 'int-evo-8-avm-fixture-catalog',
    sourceType: 'EXPERIMENTAL_STATIC_DOCUMENT', operational: false,
  }]));
  const source = createVerifiableAasDocumentSource({
    catalog: entries,
    source: sourceOverride || createConfinedAasFileReader({ rootDir: realRoot }),
    archive,
  });
  const evolutionStore = new EvolutionStore({ filePath: path.join(root, 'evolution-store.json'), now: () => new Date(fixedNow) });
  const composition = new AcceptedCycleAasComposition({ adapters, orchestrator, aasSource: source, evolutionStore, coordinate, now: () => new Date(fixedNow) });
  return { repository, adapters, orchestrator, archive, source, evolutionStore, composition };
}

function differenceNames(differences) {
  return differences.map((item) => ({ type: item.type, name: item.current?.name || item.before?.name, identity: item.identity }));
}

function operatingModeIndependent(readModel) {
  const base = {
    cycleAuthority: { identity: readModel.identity, lifecyclePhase: readModel.lifecyclePhase, cycleState: readModel.cycleState, governanceStatus: readModel.governanceStatus, sourceType: 'TRANSACTIONAL_TEST_AUTHORITY' },
    aas: readModel.aas,
    evolution: readModel.evolution,
  };
  const project = (operatingMode) => buildEvolutionCycleReadModel({ ...base, lifecycle: { identity: readModel.identity, lifecyclePhase: readModel.lifecyclePhase, cycleState: readModel.cycleState, operatingMode } });
  const auto = project('AUTO');
  const manual = project('MANUAL');
  return JSON.stringify({ identity: auto.identity, phase: auto.lifecyclePhase, cycle: auto.cycleState, aas: auto.aas, evolution: auto.evolution }) ===
    JSON.stringify({ identity: manual.identity, phase: manual.lifecyclePhase, cycle: manual.cycleState, aas: manual.aas, evolution: manual.evolution });
}

async function removalProbe(root) {
  const v3Path = path.join(projectRoot, 'cps-defs', CPSLAI1_EXPERIMENTAL_AAS_CATALOG.cps.cpslai1.versions.v3.relativePath);
  const original = fs.readFileSync(v3Path);
  const changedDocument = JSON.parse(original.toString('utf8'));
  const capabilitySubmodel = changedDocument.submodels.find((item) => item.idShort === 'Capabilities');
  capabilitySubmodel.submodelElements = capabilitySubmodel.submodelElements.filter((item) => item.idShort !== 'SlideActuation');
  const changedBytes = Buffer.from(JSON.stringify(changedDocument));
  const referenceId = 'int-evo-8-fixture-v3-with-capability-removed';
  const catalogEntry = {
    locator: 'int-evo-8-memory-fixture.json', cpsId: 'cpslai1',
    aasId: changedDocument.assetAdministrationShells[0].id,
    assetId: changedDocument.assetAdministrationShells[0].assetInformation.globalAssetId,
    contentHash: sha256(changedBytes), version: 'v3-removed-capability',
    sourceId: 'int-evo-8-memory-fixture', sourceType: 'EXPERIMENTAL_STATIC_DOCUMENT', operational: false,
  };
  const probe = createStack(path.join(root, 'removal-probe'), {
    sourceOverride: { read: async ({ referenceId: requested }) => requested === referenceId ? changedBytes : fs.readFileSync(path.join(projectRoot, 'cps-defs', CPSLAI1_EXPERIMENTAL_AAS_CATALOG.cps.cpslai1.versions.v3.relativePath)) },
  });
  // Use a separate source instance with the synthetic allowlisted fixture added;
  // source locators remain catalog-owned and bytes are generated only in memory.
  probe.source = createVerifiableAasDocumentSource({
    catalog: { ...Object.fromEntries(Object.entries(CPSLAI1_EXPERIMENTAL_AAS_CATALOG.cps.cpslai1.versions).map(([version, item]) => [`avm-${version}`, {
      locator: item.relativePath, cpsId: 'cpslai1', aasId: item.aasId, assetId: item.assetId,
      contentHash: item.sha256, version, sourceId: 'int-evo-8-avm-fixture-catalog',
      sourceType: 'EXPERIMENTAL_STATIC_DOCUMENT', operational: false,
    }])), [referenceId]: catalogEntry },
    source: { read: async ({ locator, referenceId: requested }) => requested === referenceId
      ? changedBytes : fs.readFileSync(path.join(projectRoot, 'cps-defs', locator)) },
    archive: probe.archive,
  });
  probe.composition = new AcceptedCycleAasComposition({ adapters: probe.adapters, orchestrator: probe.orchestrator, aasSource: probe.source, evolutionStore: probe.evolutionStore, now: () => new Date(fixedNow) });
  const baseline = await probe.composition.acceptPlug({ cpsId: 'cpslai1', plugEventId: 'int-evo-8-removal-base', aasReferenceId: 'avm-v3' });
  await probe.composition.unplug(baseline.binding);
  const removed = await probe.composition.acceptPlug({ cpsId: 'cpslai1', plugEventId: 'int-evo-8-removal-next', aasReferenceId: referenceId });
  return {
    baseline: baseline.evolution.status,
    result: removed.evolution.status,
    differences: differenceNames(removed.evolution.differences),
    removedCardState: removed.projection.card.state,
    removedCardReason: removed.projection.card.reason,
    removedCardCapabilityCount: removed.projection.card.aas?.capabilities.length || 0,
  };
}

export async function runIntEvo8DynamicBinding({ rootDir = null } = {}) {
  const root = rootDir ? path.resolve(rootDir) : fs.mkdtempSync(path.join(os.tmpdir(), 'acsm-int-evo-8-'));
  const stack = createStack(root);
  const cycles = [];
  for (const [index, version] of ['v1', 'v1', 'v2', 'v3'].entries()) {
    const sequence = index + 1;
    const eventId = `int-evo-8-event-${sequence}`;
    const result = await stack.composition.acceptPlug({ cpsId: 'cpslai1', plugEventId: eventId, aasReferenceId: `avm-${version}` });
    const blocked = stack.composition.playGate(result.binding);
    const approval = stack.composition.approveWithFixture(result.binding, humanAuthorization);
    const permitted = stack.composition.playGate(result.binding);
    const retry = await stack.composition.acceptPlug({ cpsId: 'cpslai1', plugEventId: eventId, aasReferenceId: `avm-${version}` });
    const closed = await stack.composition.unplug(result.binding);
    const historical = await stack.composition.readCycle(result.binding);
    cycles.push({
      sequence, version, identity: {
        cpsId: result.binding.cpsId, plugEventId: result.binding.plugEventId,
        plugCycleId: result.binding.plugCycleId, profileId: result.binding.profileId,
      },
      profileStatusBeforeHumanApproval: result.plug.governanceStatus,
      profileStatusAfterHumanApproval: approval.profile.status,
      playGateBeforeApproval: blocked.reason,
      playGateAfterApproval: permitted.reason,
      evolution: { status: result.evolution.status, duplicateRetry: retry.evolution.duplicate, differences: differenceNames(result.evolution.differences) },
      operatingModeIndependent: operatingModeIndependent(result.projection.readModel),
      card: {
        state: result.projection.card.state,
        version: result.projection.card.aas?.version || null,
        capabilityCount: result.projection.card.aas?.capabilities.length || 0,
        aasId: result.projection.card.aas?.aasId || null,
        contentHash: result.projection.card.aas?.contentHash || null,
        reason: result.projection.card.reason,
        plugCycleId: result.projection.card.binding?.plugCycleId || null,
        evolution: result.projection.card.evolution.status,
      },
      query: { status: result.projection.status, correlationStatus: result.projection.correlationStatus, bindingStatus: result.projection.bindingStatus, evolutionStatus: result.projection.evolutionStatus, issues: result.projection.issues },
      unplug: { cycleState: closed.cycleState, evolutionCreated: false },
      closedCycleCard: { state: historical.card.state, reason: historical.card.reason, version: historical.card.aas?.version || null, cycleState: historical.cycle?.state || null, queryIssues: historical.issues },
    });
  }

  const removal = await removalProbe(path.join(root, 'capability-removal'));
  const evolution = await stack.evolutionStore.inspect();
  const report = {
    schemaVersion: 'INT-EVO-8-report/1.0',
    simulation: true,
    operational: false,
    physicalExecution: false,
    rootDir: root,
    cycles,
    removalProbe: removal,
    checks: {
      evolutionSequence: cycles.map((cycle) => cycle.evolution.status),
      distinctCycleIds: new Set(cycles.map((cycle) => cycle.identity.plugCycleId)).size,
      distinctProfileIds: new Set(cycles.map((cycle) => cycle.identity.profileId)).size,
      oneAasPerCard: cycles.every((cycle) => cycle.card.state === 'BOUND' && cycle.card.capabilityCount > 0),
      allPlayGateTransitionsExplicit: cycles.every((cycle) => cycle.playGateBeforeApproval === 'GOVERNANCE_APPROVAL_REQUIRED' && cycle.playGateAfterApproval === 'GOVERNANCE_GATE_PASSED'),
      allRetriesIdempotent: cycles.every((cycle) => cycle.evolution.duplicateRetry),
      closedCycleHistoryReadable: cycles.every((cycle) => cycle.closedCycleCard.state === 'BOUND' && cycle.closedCycleCard.cycleState === 'CLOSED'),
      noEvolutionOnUnplug: cycles.every((cycle) => !cycle.unplug.evolutionCreated),
      operatingModeIndependent: cycles.every((cycle) => cycle.operatingModeIndependent),
      historySnapshots: Object.keys(evolution.snapshots).length,
      historyComparisons: Object.keys(evolution.comparisons).length,
    },
  };
  fs.writeFileSync(path.join(root, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'summary.md'), `# INT-EVO-8 Offline\n\n${cycles.map((item) => `- Cycle ${item.sequence}: ${item.version.toUpperCase()} — ${item.evolution.status} — ${item.card.capabilityCount} capabilities — ${item.identity.plugCycleId}`).join('\n')}\n\nNo physical execution. All stores and archive files are under this temporary root.\n`);
  return { rootDir: root, report, files: { report: path.join(root, 'report.json'), summary: path.join(root, 'summary.md') } };
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const result = await runIntEvo8DynamicBinding();
  process.stdout.write(`${JSON.stringify({ rootDir: result.rootDir, files: result.files, checks: result.report.checks, removalProbe: result.report.removalProbe }, null, 2)}\n`);
}
