import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AasArchive } from '../../lib/evolution/aasArchive.mjs';
import { coordinateAcceptedPlugEvolution } from '../../lib/evolution/evolutionCoordinator.mjs';
import { buildEvolutionCycleReadModel } from '../../lib/evolution/evolutionCycleReadModel.mjs';
import { EvolutionStore } from '../../lib/evolution/evolutionStore.mjs';
import { buildExperimentalAasCyclePresentation } from '../../lib/evolution/experimentalAasPreview.mjs';
import { CPSLAI1_EXPERIMENTAL_AAS_CATALOG } from '../../lib/evolution/experimentalAasCatalog.mjs';
import { createConfinedAasFileReader, createVerifiableAasDocumentSource } from '../../lib/evolution/verifiableAasDocumentSource.mjs';
import { GovernanceRepository } from '../../lib/governance/governanceRepository.mjs';
import { LifecycleEvidenceRepository } from '../../lib/governance/lifecycleEvidenceRepository.mjs';
import { LIFECYCLE_CONFIRMATION_LEVELS as LEVEL } from '../../lib/governance/lifecycleEvidence.mjs';
import { TransactionalGovernanceAdapters } from '../../lib/governance/transactionalGovernanceAdapters.mjs';
import { TransactionalGovernanceFacade } from '../../lib/governance/transactionalGovernanceFacade.mjs';
import { TransactionalLifecycleAuthority } from '../../lib/governance/transactionalLifecycleAuthority.mjs';
import { TransactionalPlugUnplugOrchestrator } from '../../lib/governance/transactionalPlugUnplugOrchestrator.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixedNow = '2026-10-14T21:00:00.000Z';
const authoritySource = { system: 'int-evo-6-offline', component: 'lifecycle-fixture', instanceId: 'isolated' };
const authorization = { authenticated: true, authorized: true, trusted: true, subject: 'int-evo-6-human-reviewer-fixture' };
const receipt = (permission) => ({ verified: true, principal: { type: 'LIFECYCLE_AUTHORITY', ...authoritySource }, authorizationId: 'int-evo-6-authority', scheme: 'OFFLINE_FIXTURE', claimsHash: 'int-evo-6-claims', permission });

function governanceStack(filePath) {
  const repository = new GovernanceRepository({ filePath });
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
  return { repository, adapters, orchestrator: new TransactionalPlugUnplugOrchestrator({ adapters, lifecycleAuthority, evidenceRepository }) };
}

function experimentalCatalog() {
  return Object.fromEntries(Object.entries(CPSLAI1_EXPERIMENTAL_AAS_CATALOG.cps.cpslai1.versions).map(([version, entry]) => [`avm-${version}`, {
    locator: entry.relativePath, cpsId: 'cpslai1', aasId: entry.aasId, assetId: entry.assetId,
    contentHash: entry.sha256, version, sourceId: 'int-evo-6-avm-fixtures',
    sourceType: 'EXPERIMENTAL_STATIC_DOCUMENT', operational: false,
  }]));
}

function aasForReadModel(resolved) {
  return {
    aasId: resolved.aasId, assetId: resolved.assetId, version: resolved.version,
    contentHash: resolved.contentHash, sourceType: resolved.sourceType,
    provenance: { sourceId: resolved.sourceId, sourceType: resolved.sourceType, experimental: true, operational: false },
    evidenceLevel: resolved.evidenceLevel, capabilities: resolved.capabilities, services: resolved.services,
  };
}

function renderHtml(report) {
  const cards = report.cycles.map((cycle) => `<article><h2>Cycle ${cycle.sequence} · ${cycle.card.aas.version.toUpperCase()}</h2><p>${cycle.evolution.status} · ${cycle.card.aas.capabilities.length} capabilities</p><p><code>${cycle.plugCycleId}</code></p><ul>${cycle.card.aas.capabilities.map((item) => `<li>${item.name}</li>`).join('')}</ul></article>`).join('');
  return `<!doctype html><meta charset="utf-8"><title>INT-EVO-6 offline evidence</title><style>body{font:16px system-ui;background:#0b1220;color:#e5e7eb;margin:2rem}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:1rem}article{border:1px solid #334155;border-radius:12px;padding:1rem;background:#111827}code{overflow-wrap:anywhere}</style><h1>OFFLINE PPU/AAS CARD EVIDENCE — NO PHYSICAL EXECUTION</h1><main>${cards}</main>`;
}

export async function runIntEvo6OfflineCardDemo({ rootDir = null } = {}) {
  const root = rootDir ? path.resolve(rootDir) : fs.mkdtempSync(path.join(os.tmpdir(), 'acsm-int-evo-6-'));
  fs.mkdirSync(root, { recursive: true });
  const governancePath = path.join(root, 'governance.json');
  fs.copyFileSync(path.join(projectRoot, 'test', 'fixtures', 'governance-repository', 'current-valid.json'), governancePath);
  const governance = governanceStack(governancePath);
  const archive = new AasArchive({ rootDir: path.join(root, 'aas-archive') });
  const source = createVerifiableAasDocumentSource({
    catalog: experimentalCatalog(), source: createConfinedAasFileReader({ rootDir: path.join(projectRoot, 'cps-defs') }), archive,
  });
  const evolutionStore = new EvolutionStore({ filePath: path.join(root, 'evolution.json'), now: () => new Date(fixedNow) });
  const cycles = [];
  let operatingMode = 'ABSTRACT_MODE_A';

  for (const [index, version] of ['v1', 'v1', 'v2', 'v3'].entries()) {
    const sequence = index + 1;
    const resolved = await source.resolve({ referenceId: `avm-${version}`, cpsId: 'cpslai1' });
    const plug = governance.orchestrator.plug({
      cpsId: 'cpslai1', plugEventId: `int-evo-6-plug-${sequence}`,
      identity: { aasId: resolved.aasId, assetId: resolved.assetId, functionalVersion: version },
    });
    const blockedGate = governance.adapters.projectPlayGate({ ...plug, lifecyclePhase: 'play' });
    const approved = governance.adapters.approveProfile({ ...plug, authorization });
    const allowedGate = governance.adapters.projectPlayGate({ ...plug, lifecyclePhase: 'play' });
    const evolution = await coordinateAcceptedPlugEvolution({
      cpsId: plug.cpsId, plugEventId: plug.plugEventId, plugCycleId: plug.plugCycleId,
      aas: null, resolvedAas: {
        document: JSON.parse((await archive.getByHash(resolved.contentHash)).toString('utf8')),
        identity: { cpsId: resolved.cpsId, aasId: resolved.aasId, assetId: resolved.assetId, version: resolved.version },
        integrity: { contentHash: resolved.contentHash }, archiveReference: resolved.archiveReference,
        provenance: { sourceId: resolved.sourceId, sourceType: resolved.sourceType, operational: false },
        evidenceScope: 'OFFLINE_DOCUMENTAL_AAS', resolvedAt: fixedNow,
      },
      store: evolutionStore, plugAccepted: true, capturedAt: new Date(fixedNow),
      provenance: { experiment: 'INT-EVO-6', simulation: true, operational: false },
    });
    const identity = { cpsId: plug.cpsId, plugEventId: plug.plugEventId, plugCycleId: plug.plugCycleId, profileId: plug.profileId };
    const readModel = buildEvolutionCycleReadModel({
      cycleAuthority: { identity, lifecyclePhase: 'play', cycleState: 'ACTIVE', governanceStatus: approved.profile.status },
      governance: { ...identity, governanceStatus: approved.profile.status },
      lifecycle: { ...identity, lifecyclePhase: 'play', cycleState: 'ACTIVE' },
      aas: aasForReadModel(resolved), evolution: { ...identity, ...evolution, evidenceLevel: resolved.evidenceLevel },
    });
    const binding = { ...identity, aasId: resolved.aasId, aasHash: resolved.contentHash, aasVersion: resolved.version, sourceType: resolved.sourceType, correlationStatus: readModel.identityCorrelationStatus };
    const projectedCard = buildExperimentalAasCyclePresentation({ cpsId: 'cpslai1', binding, cycleReadModel: readModel });
    const card = { ...projectedCard, boundToOperationalPlugCycle: false, boundToSimulatedPpuCycle: projectedCard.state === 'BOUND' };
    const modeBefore = operatingMode;
    operatingMode = `ABSTRACT_MODE_${String.fromCharCode(66 + index)}`;
    const afterModeReadModel = buildEvolutionCycleReadModel({
      cycleAuthority: { identity, lifecyclePhase: 'play', cycleState: 'ACTIVE', governanceStatus: approved.profile.status },
      governance: { ...identity, governanceStatus: approved.profile.status },
      lifecycle: { ...identity, lifecyclePhase: 'play', cycleState: 'ACTIVE', operatingMode },
      aas: aasForReadModel(resolved), evolution: { ...identity, ...evolution, evidenceLevel: resolved.evidenceLevel },
    });
    const projectedAfterModeCard = buildExperimentalAasCyclePresentation({ cpsId: 'cpslai1', binding, cycleReadModel: afterModeReadModel });
    const afterModeCard = { ...projectedAfterModeCard, boundToOperationalPlugCycle: false, boundToSimulatedPpuCycle: projectedAfterModeCard.state === 'BOUND' };
    const comparisonCountBeforeUnplug = Object.keys((await evolutionStore.inspect()).comparisons).length;
    const unplug = governance.orchestrator.unplug(plug);
    const comparisonCountAfterUnplug = Object.keys((await evolutionStore.inspect()).comparisons).length;
    cycles.push({
      sequence, version, ...identity, profileStatusBeforeApproval: plug.governanceStatus,
      profileStatusAfterApproval: approved.profile.status, blockedGate, allowedGate,
      aas: { aasId: resolved.aasId, assetId: resolved.assetId, contentHash: resolved.contentHash, functionalHash: resolved.functionalHash },
      evolution: { status: evolution.status, differences: evolution.differences, snapshotId: evolution.snapshotId, comparisonId: evolution.comparisonId },
      card, unplug: { cycleState: unplug.cycleState, evolutionCreated: comparisonCountAfterUnplug !== comparisonCountBeforeUnplug },
      operatingMode: { before: modeBefore, after: operatingMode, cardUnchanged: JSON.stringify(card) === JSON.stringify(afterModeCard), functionalHashUnchanged: resolved.functionalHash === afterModeReadModel.evolution.functionalHash },
    });
  }

  const active = cycles.at(-1);
  const hashConflict = buildExperimentalAasCyclePresentation({ cpsId: 'cpslai1', binding: { ...active.card.binding, aasHash: 'f'.repeat(64) }, cycleReadModel: buildEvolutionCycleReadModel({}) });
  const profileConflict = buildExperimentalAasCyclePresentation({ cpsId: 'cpslai1', binding: { ...active.card.binding, profileId: 'other-profile' }, cycleReadModel: { ...active.card, identityCorrelationStatus: 'CONFLICT' } });
  const report = {
    schemaVersion: 'INT-EVO-6-offline-card-report/1.0', simulation: true, operational: false,
    physicalExecution: false, generatedAt: fixedNow, cycles,
    checks: {
      evolutionSequence: cycles.map((item) => item.evolution.status),
      distinctCycleIds: new Set(cycles.map((item) => item.plugCycleId)).size,
      distinctProfileIds: new Set(cycles.map((item) => item.profileId)).size,
      allCardsBoundToOneAas: cycles.every((item) => item.card.state === 'BOUND' && item.card.aas && !Array.isArray(item.card.aas)),
      allApprovalsExplicit: cycles.every((item) => item.blockedGate.ok === false && item.allowedGate.ok === true),
      noEvolutionOnUnplug: cycles.every((item) => item.unplug.evolutionCreated === false),
      operatingModeIndependent: cycles.every((item) => item.operatingMode.cardUnchanged && item.operatingMode.functionalHashUnchanged),
      hashConflictState: hashConflict.state, profileConflictState: profileConflict.state,
    },
  };
  fs.writeFileSync(path.join(root, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'index.html'), renderHtml(report));
  return { rootDir: root, report, files: { report: path.join(root, 'report.json'), html: path.join(root, 'index.html') } };
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const result = await runIntEvo6OfflineCardDemo();
  process.stdout.write(`${JSON.stringify({ rootDir: result.rootDir, files: result.files, checks: result.report.checks }, null, 2)}\n`);
}
