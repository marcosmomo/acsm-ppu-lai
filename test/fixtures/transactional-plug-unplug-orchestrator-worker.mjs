import { GovernanceRepository } from '../../lib/governance/governanceRepository.mjs';
import { TransactionalGovernanceFacade } from '../../lib/governance/transactionalGovernanceFacade.mjs';
import { TransactionalGovernanceAdapters } from '../../lib/governance/transactionalGovernanceAdapters.mjs';
import { TransactionalLifecycleAuthority } from '../../lib/governance/transactionalLifecycleAuthority.mjs';
import { LifecycleEvidenceRepository } from '../../lib/governance/lifecycleEvidenceRepository.mjs';
import { TransactionalPlugUnplugOrchestrator } from '../../lib/governance/transactionalPlugUnplugOrchestrator.mjs';
import { LIFECYCLE_CONFIRMATION_LEVELS as LEVEL } from '../../lib/governance/lifecycleEvidence.mjs';

const [filePath, startPath, plugEventId, identityJson] = process.argv.slice(2);
const identity = identityJson ? JSON.parse(identityJson) : { aasId: 'urn:test:cpslai1:aas', functionalVersion: '1', assetId: 'asset-cpslai1' };
while (!await import('node:fs').then(({ default: fs }) => fs.existsSync(startPath))) await new Promise((resolve) => setTimeout(resolve, 5));
const source = { system: 'acsm-test', component: 'orchestrator-worker', instanceId: `worker-${process.pid}` };
const receipt = (permission) => ({ verified: true, principal: { type: 'LIFECYCLE_AUTHORITY', ...source }, authorizationId: 'isolated-worker', scheme: 'test-verifier', claimsHash: 'worker-claims', permission });
const repository = new GovernanceRepository({ filePath });
const facade = new TransactionalGovernanceFacade({ repository });
const adapters = new TransactionalGovernanceAdapters({ facade });
const lifecycleAuthority = new TransactionalLifecycleAuthority({
  repository, source, initialStateByCps: { cpslai1: 'idle' },
  verifyTransitionResult: (_result, { permission }) => receipt(permission),
});
const evidenceRepository = new LifecycleEvidenceRepository({
  repository, verifyEvidenceOrigin: (_evidence, { permission }) => receipt(permission),
  confirmationPolicy: { minimumConfirmationLevel: LEVEL.BACKEND_ACCEPTED },
  resolveExpectedPreviousState: (cycle, operation) => operation === 'PLUG'
    ? cycle.authoritativeLifecycleState || 'idle'
    : cycle.authoritativeLifecycleState || cycle.lifecycleEvidence?.PLUG?.evidence?.resultingState || null,
});
const orchestrator = new TransactionalPlugUnplugOrchestrator({ adapters, lifecycleAuthority, evidenceRepository });
const result = orchestrator.plug({
  cpsId: 'cpslai1', plugEventId,
  identity,
});
process.stdout.write(JSON.stringify({ plugCycleId: result.plugCycleId, profileId: result.profileId, cycleState: result.cycleState, aasReference: result.reserved.cycle.aasReference || null }));
