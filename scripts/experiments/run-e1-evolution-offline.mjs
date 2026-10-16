import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFunctionalDeclarations } from '../../lib/evolution/functionalExtractor.mjs';
import { buildFunctionalSnapshot } from '../../lib/evolution/functionalNormalizer.mjs';
import { compareFunctionalSnapshots } from '../../lib/evolution/functionalComparator.mjs';
import { coordinateAcceptedPlugEvolution } from '../../lib/evolution/evolutionCoordinator.mjs';
import { EvolutionStore } from '../../lib/evolution/evolutionStore.mjs';
import { AasArchive } from '../../lib/evolution/aasArchive.mjs';
import { GovernanceRepository } from '../../lib/governance/governanceRepository.mjs';
import { TransactionalGovernanceFacade } from '../../lib/governance/transactionalGovernanceFacade.mjs';
import { TransactionalGovernanceAdapters } from '../../lib/governance/transactionalGovernanceAdapters.mjs';
import { TransactionalLifecycleAuthority } from '../../lib/governance/transactionalLifecycleAuthority.mjs';
import { LifecycleEvidenceRepository } from '../../lib/governance/lifecycleEvidenceRepository.mjs';
import { TransactionalPlugUnplugOrchestrator } from '../../lib/governance/transactionalPlugUnplugOrchestrator.mjs';
import { LIFECYCLE_CONFIRMATION_LEVELS as LEVEL } from '../../lib/governance/lifecycleEvidence.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourceAasPath = path.join(projectRoot, 'cps-defs', 'cps-lai-01-aas-acsm-compatible-revised.json');
const governanceFixture = path.join(projectRoot, 'test', 'fixtures', 'governance-repository', 'current-valid.json');
const runAt = '2026-10-14T18:00:00.000Z';
const digest = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const clone = (value) => structuredClone(value);
const mkdir = (directory) => fs.mkdirSync(directory, { recursive: true });
const capabilities = (aas) => aas.submodels.find((item) => item.idShort === 'Capabilities').submodelElements;
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const source = { system: 'acsm-e1-isolated', component: 'logical-lifecycle-fixture', instanceId: 'e1-test-only' };
const authorityReceipt = (permission) => ({
  verified: true, principal: { type: 'LIFECYCLE_AUTHORITY', ...source }, authorizationId: 'e1-fixture-authority',
  scheme: 'isolated-test-verifier', claimsHash: 'e1-test-claims', permission,
});

function eventSummary(result, previousSnapshot, currentSnapshot, extra = {}) {
  const names = (snapshot) => snapshot.declarations.filter((item) => item.kind === 'CAPABILITY' || item.kind === 'SERVICE')
    .map((item) => ({ kind: item.kind, name: item.name, identity: item.identity, semanticReferences: item.semanticReferences }));
  return {
    status: result.status, reason: result.reason || null, promoted: result.promoted,
    duplicate: result.duplicate, functionalVersion: result.functionalVersion,
    functionalHash: result.functionalHash, aasContentHash: result.aasContentHash,
    snapshotId: result.snapshotId, comparisonId: result.comparisonId,
    previousSnapshotId: result.previousSnapshotId,
    differences: result.differences.map((difference) => ({
      type: difference.type, identity: difference.identity,
      beforeName: difference.before?.name || null, currentName: difference.current?.name || null,
      beforeHash: difference.before?.contractHash || null, currentHash: difference.current?.contractHash || null,
    })),
    ambiguities: result.ambiguities, issues: result.issues,
    capabilitiesBefore: names(previousSnapshot).filter((item) => item.kind === 'CAPABILITY'),
    capabilitiesAfter: names(currentSnapshot).filter((item) => item.kind === 'CAPABILITY'),
    servicesBefore: names(previousSnapshot).filter((item) => item.kind === 'SERVICE'),
    servicesAfter: names(currentSnapshot).filter((item) => item.kind === 'SERVICE'),
    ...extra,
  };
}

async function runEvolutionCase(root, name, aasV1Bytes, aasV2Bytes = null, { retrySameEvent = false, incomplete = false } = {}) {
  const caseRoot = path.join(root, 'scenarios', name);
  mkdir(caseRoot);
  const store = new EvolutionStore({ filePath: path.join(caseRoot, 'evolution-store.json') });
  const archive = new AasArchive({ rootDir: path.join(caseRoot, 'aas-archive') });
  const baseAas = JSON.parse(aasV1Bytes.toString('utf8'));
  const before = buildFunctionalSnapshot(baseAas);
  const v1Ref = await archive.archive({ bytes: aasV1Bytes });
  const resolved = (document, bytes, archiveReference, event) => ({
    document,
    identity: { cpsId: 'cpslai1', aasId: document.assetAdministrationShells[0].id,
      assetId: document.assetAdministrationShells[0].assetInformation.globalAssetId, version: document.assetAdministrationShells[0].administration.version,
      revision: document.assetAdministrationShells[0].administration.revision },
    integrity: { contentHash: digest(bytes), canonicalHash: buildFunctionalSnapshot(document).functionalHash },
    archiveReference,
    provenance: { sourceId: 'E1_TEMPORARY_DOCUMENT_FIXTURE', sourceType: 'STATIC_FILE', operational: false, sourceRevision: 'synthetic-e1' },
    resolverVersion: 'e1-offline-harness/1.0', resolvedAt: runAt, evidenceScope: 'STATIC_DOCUMENT_DECLARATION',
    physicalStateInferred: false, plugEventId: event,
  });
  const firstEvent = `${name}-plug-v1`;
  const firstResolved = resolved(baseAas, aasV1Bytes, v1Ref, firstEvent);
  const first = await coordinateAcceptedPlugEvolution({
    cpsId: 'cpslai1', plugEventId: firstEvent, plugCycleId: `${name}-cycle-v1`,
    resolvedAas: firstResolved, store, plugAccepted: true, capturedAt: runAt,
    provenance: { experiment: 'E1', scenario: name, aasFixture: 'V1' },
  });
  const previous = before;
  let final = first;
  let current = before;
  let v2Ref = null;
  let retry = null;
  if (retrySameEvent) {
    retry = await coordinateAcceptedPlugEvolution({
      cpsId: 'cpslai1', plugEventId: firstEvent, plugCycleId: `${name}-cycle-v1`,
      resolvedAas: firstResolved, store, plugAccepted: true, capturedAt: '2026-10-14T18:05:00.000Z',
      provenance: { experiment: 'E1', scenario: name, aasFixture: 'V1' },
    });
  } else if (aasV2Bytes) {
    const currentAas = JSON.parse(aasV2Bytes.toString('utf8'));
    current = buildFunctionalSnapshot(currentAas);
    v2Ref = await archive.archive({ bytes: aasV2Bytes });
    const event = `${name}-plug-v2`;
    const nextResolved = resolved(currentAas, aasV2Bytes, v2Ref, event);
    final = await coordinateAcceptedPlugEvolution({
      cpsId: 'cpslai1', plugEventId: event, plugCycleId: `${name}-cycle-v2`,
      resolvedAas: nextResolved, store, plugAccepted: true, capturedAt: runAt,
      provenance: { experiment: 'E1', scenario: name, aasFixture: incomplete ? 'V2_INCOMPLETE' : 'V2_SYNTHETIC' },
    });
  }
  const storeDocument = await store.inspect();
  const archivedV1 = await archive.getByHash(v1Ref.contentHash);
  const archivedV2 = v2Ref ? await archive.getByHash(v2Ref.contentHash) : null;
  return {
    name, expected: name === 'E1.1' ? 'BASELINE' : name === 'E1.2' ? 'NO_CHANGE' : incomplete ? 'INDETERMINATE' : 'CHANGED',
    actual: final.status, result: eventSummary(final, previous, current),
    retry: retry ? { duplicate: retry.duplicate, snapshotId: retry.snapshotId, status: retry.status } : null,
    counts: { snapshots: Object.keys(storeDocument.snapshots).length, comparisons: Object.keys(storeDocument.comparisons).length,
      histories: Object.keys(storeDocument.comparisons).length, processing: Object.keys(storeDocument.processing).length },
    hashes: { aasV1: v1Ref.contentHash, aasV2: v2Ref?.contentHash || null, functionalV1: before.functionalHash, functionalV2: current.functionalHash },
    archiveIntegrity: { v1: digest(archivedV1) === v1Ref.contentHash, v2: archivedV2 ? digest(archivedV2) === v2Ref.contentHash : null },
    archiveReferences: { v1: v1Ref.reference, v2: v2Ref?.reference || null },
    processingState: final.processingState,
  };
}

async function runGovernanceReplug(root, v1Bytes, v2Bytes) {
  const caseRoot = path.join(root, 'scenarios', 'E1.8');
  mkdir(caseRoot);
  const repositoryPath = path.join(caseRoot, 'governance-candidate.json');
  fs.copyFileSync(governanceFixture, repositoryPath);
  const repository = new GovernanceRepository({ filePath: repositoryPath });
  const facade = new TransactionalGovernanceFacade({ repository, now: () => runAt });
  const adapters = new TransactionalGovernanceAdapters({ facade });
  const lifecycleAuthority = new TransactionalLifecycleAuthority({
    repository, source, initialStateByCps: { cpslai1: 'idle' }, now: () => runAt,
    verifyTransitionResult: (_result, { permission }) => authorityReceipt(permission),
  });
  const evidenceRepository = new LifecycleEvidenceRepository({
    repository, now: () => runAt, verifyEvidenceOrigin: (_evidence, { permission }) => authorityReceipt(permission),
    confirmationPolicy: { minimumConfirmationLevel: LEVEL.BACKEND_ACCEPTED },
    resolveExpectedPreviousState: (cycle, operation) => operation === 'PLUG'
      ? cycle.authoritativeLifecycleState || 'idle'
      : cycle.authoritativeLifecycleState || cycle.lifecycleEvidence?.PLUG?.evidence?.resultingState || null,
  });
  const orchestrator = new TransactionalPlugUnplugOrchestrator({ adapters, lifecycleAuthority, evidenceRepository });
  const identity = { aasId: 'urn:ufsc:lai:ppu:cps-lai-01:aas', functionalVersion: '1', assetId: 'urn:ufsc:lai:asset:cps-lai-01:distribution-conveyor' };
  const oldVersionsBefore = repository.read().document.profileVersions.cpslai1.length;
  const first = orchestrator.plug({ cpsId: 'cpslai1', plugEventId: 'E1.8-plug-initial', identity });
  const gateBeforeApproval = adapters.projectPlayGate({ cpsId: 'cpslai1', profileId: first.profileId, plugCycleId: first.plugCycleId, lifecyclePhase: 'play', expectedPhase: 'play' });
  const oldAas = JSON.parse(v1Bytes.toString('utf8'));
  const evolvedAas = JSON.parse(v2Bytes.toString('utf8'));
  const evolutionPath = path.join(caseRoot, 'evolution-store.json');
  const archive = new AasArchive({ rootDir: path.join(caseRoot, 'aas-archive') });
  const store = new EvolutionStore({ filePath: evolutionPath });
  async function acceptedCapture(event, cycleId, aas, bytes) {
    const archiveRef = await archive.archive({ bytes });
    const resolvedAas = {
      document: aas,
      identity: { cpsId: 'cpslai1', aasId: aas.assetAdministrationShells[0].id, assetId: aas.assetAdministrationShells[0].assetInformation.globalAssetId, version: '1', revision: '1' },
      integrity: { contentHash: digest(bytes), canonicalHash: buildFunctionalSnapshot(aas).functionalHash }, archiveReference: archiveRef,
      provenance: { sourceId: 'E1_TEMPORARY_DOCUMENT_FIXTURE', sourceType: 'STATIC_FILE', operational: false },
      resolverVersion: 'e1-offline-harness/1.0', resolvedAt: runAt, evidenceScope: 'STATIC_DOCUMENT_DECLARATION', physicalStateInferred: false,
    };
    const beforeGovernance = repository.read();
    const result = await coordinateAcceptedPlugEvolution({ cpsId: 'cpslai1', plugEventId: event, plugCycleId: cycleId,
      resolvedAas, store, plugAccepted: true, capturedAt: runAt, provenance: { experiment: 'E1.8', syntheticOnly: true } });
    const afterGovernance = repository.read();
    return { result, governanceUnchanged: JSON.stringify(beforeGovernance) === JSON.stringify(afterGovernance), archiveRef };
  }
  const evolutionV1 = await acceptedCapture('E1.8-plug-initial', first.plugCycleId, oldAas, v1Bytes);
  const firstProfile = repository.read().document.profiles.cpslai1;
  const unplug = orchestrator.unplug({ cpsId: first.cpsId, plugEventId: first.plugEventId, plugCycleId: first.plugCycleId, profileId: first.profileId });
  const second = orchestrator.plug({ cpsId: 'cpslai1', plugEventId: 'E1.8-plug-replug', identity });
  const evolutionV2 = await acceptedCapture('E1.8-plug-replug', second.plugCycleId, evolvedAas, v2Bytes);
  const gateAfterReplug = adapters.projectPlayGate({ cpsId: 'cpslai1', profileId: second.profileId, plugCycleId: second.plugCycleId, lifecyclePhase: 'play', expectedPhase: 'play' });
  const finalDocument = repository.read().document;
  const oldProfile = finalDocument.profileVersions.cpslai1.find((entry) => entry.profileId === first.profileId);
  const newProfile = finalDocument.profiles.cpslai1;
  return {
    oldVersionsBefore, firstCycle: { state: unplug.cycleState, profileId: first.profileId, statusAtPlug: firstProfile.status, statusAfterUnplug: oldProfile.status },
    secondCycle: { state: second.cycleState, profileId: second.profileId, status: newProfile.status, plugCycleStatus: newProfile.plugCycleStatus },
    newProfileCreated: second.profileId !== first.profileId,
    approvalNotInherited: newProfile.status === 'PENDING_APPROVAL' && oldProfile.status === firstProfile.status,
    gateBeforeApproval: gateBeforeApproval.reason, gateAfterReplug: gateAfterReplug.reason,
    playBlocked: !gateBeforeApproval.ok && !gateAfterReplug.ok,
    evolution: { v1: evolutionV1.result.status, v2: evolutionV2.result.status, governanceUnchangedV1: evolutionV1.governanceUnchanged, governanceUnchangedV2: evolutionV2.governanceUnchanged,
      physicalValidationInferred: evolutionV2.result.evidence.physicalValidationInferred },
    cycles: Object.values(finalDocument.plugCycles).filter((cycle) => cycle.cpsId === 'cpslai1').map(({ plugEventId, plugCycleId, governanceProfileId, state, authoritativeLifecycleState }) => ({ plugEventId, plugCycleId, profileId: governanceProfileId, state, authoritativeLifecycleState })),
    profiles: finalDocument.profileVersions.cpslai1.map(({ profileId, profileVersion, plugEventId, plugCycleId, status, plugCycleStatus }) => ({ profileId, profileVersion, plugEventId: plugEventId || null, plugCycleId: plugCycleId || null, status, plugCycleStatus: plugCycleStatus || null })),
    governanceRevision: repository.read().revision,
  };
}

function syntheticVariant(v1, operation) {
  const v2 = clone(v1);
  if (operation === 'add') capabilities(v2).push({ modelType: 'Property', idShort: 'E1SyntheticAdaptiveRouting', valueType: 'xs:boolean', value: 'true', description: [{ language: 'en', text: 'Synthetic E1 test capability; not a real or ECLASS capability.' }] });
  if (operation === 'remove') v2.submodels.find((item) => item.idShort === 'Capabilities').submodelElements = capabilities(v2).filter((item) => item.idShort !== 'ConveyorReverse');
  if (operation === 'modify') capabilities(v2).find((item) => item.idShort === 'ConveyorReverse').value = 'false';
  if (operation === 'incomplete') v2.submodels = v2.submodels.filter((item) => item.idShort !== 'Capabilities');
  if (operation === 'ambiguous') capabilities(v2).find((item) => item.idShort === 'ConveyorForward').idShort = 'E1RenamedConveyorForward';
  if (operation === 'irrelevant') {
    const shell = v2.assetAdministrationShells[0];
    shell.description = [{ language: 'en', text: 'E1 synthetic descriptive-only change; no functional contract change.' }];
    shell.idShort = 'CPSLAI01_AAS';
  }
  return Buffer.from(`${JSON.stringify(v2, null, 2)}\n`);
}

function markdown(report) {
  const rows = report.scenarios.map((item) => `| ${item.id} | ${item.label} | ${item.actual || item.result?.actual || '—'} | ${item.result?.result?.differences?.map((d) => d.type).join(', ') || item.result?.differences?.map((d) => d.type).join(', ') || '—'} | ${item.pass ? 'PASS' : item.status || 'BLOCKED'} |`).join('\n');
  const caps = report.v1Extraction.capabilities.map((item) => `- ${item.name} — ${item.path}; ${item.identityBasis}; evidência ${item.evidence.level}`).join('\n');
  const services = report.v1Extraction.services.map((item) => `- ${item.name} — ${item.path}; evidência ${item.evidence.level}`).join('\n');
  return `# Experimento E1 — Evolution offline do CPS-LAI-01\n\n`+
    `Execução: ${report.generatedAt}\n\n`+
    `AAS V1: ${report.source.aasId} / ${report.source.assetId}; SHA-256 ${report.source.aasSha256}; escopo ${report.source.evidenceScope}. Documento de referência somente leitura; cópia experimental em temporary root.\n\n`+
    `## Extração real da AAS V1\n\nCapacidades (${report.v1Extraction.capabilities.length}):\n${caps}\n\nServiços (${report.v1Extraction.services.length}):\n${services}\n\n`+
    `A extração é ${report.v1Extraction.completeness}; nenhuma declaração foi considerada fisicamente validada. Declarações sem semanticId foram identificadas por caminho técnico; não foram criados IRDIs ECLASS.\n\n`+
    `## Matriz E1\n\n| ID | Cenário | Resultado | Diferenças | Avaliação |\n|---|---|---|---|---|\n${rows}\n\n`+
    `## Governança E1.8\n\n${JSON.stringify(report.governanceReplug, null, 2)}\n\n`+
    `## Limitações\n\nSomente fixtures e simulação local em arquivos temporários. O aceite Plug/evidência lifecycle, AAS V2 e estados de governança são simulados. Evolution compara declarações funcionais; não valida operação física, autenticação real, autoridade lifecycle operacional ou Play-gate em runtime. A AAS oficial não foi alterada. Os stores de Evolution e Governance usados no experimento são temporários e independentes dos operacionais.\n\n`+
    `Arquivos temporários: consulte manifest.json neste diretório.\n`;
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acsm-e1-evolution-offline-'));
  const v1Bytes = fs.readFileSync(sourceAasPath);
  const v1 = JSON.parse(v1Bytes.toString('utf8'));
  const extraction = extractFunctionalDeclarations(v1);
  const normalizedV1 = buildFunctionalSnapshot(v1);
  const v2 = {
    unchanged: v1Bytes,
    added: syntheticVariant(v1, 'add'), removed: syntheticVariant(v1, 'remove'), modified: syntheticVariant(v1, 'modify'),
    incomplete: syntheticVariant(v1, 'incomplete'), ambiguous: syntheticVariant(v1, 'ambiguous'), irrelevant: syntheticVariant(v1, 'irrelevant'),
  };
  mkdir(path.join(root, 'aas'));
  fs.writeFileSync(path.join(root, 'aas', 'V1-reference-copy.json'), v1Bytes);
  for (const [name, bytes] of Object.entries(v2)) fs.writeFileSync(path.join(root, 'aas', `V2-${name}.json`), bytes);

  const scenarioRuns = [
    ['E1.1', 'Primeira AAS registrada', v1Bytes, null, {}],
    ['E1.2', 'Replug inalterado; controle descritivo irrelevante em store independente', v1Bytes, v2.irrelevant, {}],
    ['E1.3', 'Replug com capacidade sintética adicionada', v1Bytes, v2.added, {}],
    ['E1.4', 'Replug com capacidade removida', v1Bytes, v2.removed, {}],
    ['E1.5', 'Replug com atributo funcional alterado, identidade técnica mantida', v1Bytes, v2.modified, {}],
    ['E1.6-incomplete', 'AAS funcional incompleta', v1Bytes, v2.incomplete, { incomplete: true }],
    ['E1.6-ambiguous', 'Identidade técnica renomeada sem identidade semântica estável', v1Bytes, v2.ambiguous, {}],
    ['E1.7', 'Retry do mesmo plugEventId', v1Bytes, null, { retrySameEvent: true }],
  ];
  const scenarios = [];
  for (const [id, label, before, after, options] of scenarioRuns) {
    const result = await runEvolutionCase(root, id, before, after, options);
    const expected = id === 'E1.1' ? 'BASELINE' : id === 'E1.2' ? 'NO_CHANGE' : id.startsWith('E1.6') ? 'INDETERMINATE' : id === 'E1.7' ? 'NO_OP' : 'CHANGED';
    const actual = id === 'E1.7' && result.retry?.duplicate === true ? 'NO_OP' : result.actual;
    const retryPass = id !== 'E1.7' || (result.retry?.duplicate === true && result.counts.snapshots === 1 && result.counts.comparisons === 1);
    scenarios.push({ id, label, expected, actual, pass: actual === expected && result.archiveIntegrity.v1 && (result.archiveIntegrity.v2 !== false) && retryPass,
      result, status: result.actual === expected ? 'PASS' : 'FAIL' });
  }
  const gov = await runGovernanceReplug(root, v1Bytes, v2.modified);
  scenarios.push({ id: 'E1.8', label: 'Unplug → Replug com perfil pendente e Play bloqueado', expected: 'PENDING_APPROVAL / BLOCKED', actual: `${gov.secondCycle.status} / ${gov.playBlocked ? 'BLOCKED' : 'PASS'}`,
    pass: gov.newProfileCreated && gov.approvalNotInherited && gov.playBlocked && gov.evolution.v1 === 'BASELINE' && gov.evolution.v2 === 'CHANGED' && gov.evolution.governanceUnchangedV1 && gov.evolution.governanceUnchangedV2,
    status: 'SIMULATED', result: { governanceReplug: gov } });
  const report = {
    schemaVersion: 'E1-report/1.0', experiment: 'E1', title: 'Evolution offline do CPS-LAI-01', generatedAt: runAt,
    tempRoot: root,
    source: { path: 'cps-defs/cps-lai-01-aas-acsm-compatible-revised.json', readOnly: true, aasId: extraction.source.aasId, aasIdShort: extraction.source.aasIdShort,
      assetId: extraction.source.assetId, cpsId: 'cpslai1', aasSha256: digest(v1Bytes), evidenceScope: 'STATIC_DOCUMENT_DECLARATION', operational: false },
    v1Extraction: { completeness: extraction.completeness, functionalHash: normalizedV1.functionalHash,
      capabilities: extraction.declarations.filter((item) => item.kind === 'CAPABILITY').map((item) => ({ name: item.name, path: item.source.path, identityBasis: item.semanticReferences.length ? 'SEMANTIC_REFERENCE' : 'TECHNICAL_PATH', semanticReferences: item.semanticReferences, attributes: item.attributes, evidence: item.evidence })),
      services: extraction.declarations.filter((item) => item.kind === 'SERVICE').map((item) => ({ name: item.name, path: item.source.path, semanticReferences: item.semanticReferences, evidence: item.evidence })),
      issues: extraction.issues },
    syntheticChanges: { addedCapability: 'E1SyntheticAdaptiveRouting (test-only; no official ECLASS IRDI; technical-path identity)', removedCapability: 'ConveyorReverse', modifiedAttribute: 'ConveyorReverse.value true → false', incomplete: 'Capabilities submodel removed in isolated negative fixture', ambiguous: 'ConveyorForward idShort renamed without semanticId', irrelevant: 'AAS shell description changed only; functional extractor should ignore it' },
    scenarios, governanceReplug: gov,
    physicalValidationClaimed: false, operationalValidationClaimed: false,
    temporaryFiles: [],
  };
  function listFiles(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const item = path.join(directory, entry.name);
      if (entry.isDirectory()) listFiles(item); else report.temporaryFiles.push(path.relative(root, item));
    }
  }
  listFiles(root);
  report.temporaryFiles.push('report.json', 'summary.md', 'manifest.json');
  writeJson(path.join(root, 'report.json'), report);
  fs.writeFileSync(path.join(root, 'summary.md'), markdown(report));
  writeJson(path.join(root, 'manifest.json'), { experiment: 'E1', tempRoot: root, generatedFiles: report.temporaryFiles });
  process.stdout.write(JSON.stringify({ tempRoot: root, reportPath: path.join(root, 'report.json'), summaryPath: path.join(root, 'summary.md'), manifestPath: path.join(root, 'manifest.json'),
    v1Capabilities: report.v1Extraction.capabilities.map((item) => item.name), v1Services: report.v1Extraction.services.map((item) => item.name),
    scenarios: scenarios.map(({ id, expected, actual, pass }) => ({ id, expected, actual, pass })), allPass: scenarios.every((item) => item.pass), fileCount: report.temporaryFiles.length }, null, 2));
}

main().catch((error) => { process.stderr.write(`${error.code || error.name}: ${error.message}\n`); process.exitCode = 1; });
